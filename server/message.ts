import { decode } from './runtime';

export type Party={name:string;address:string};
export type Attachment={filename:string;mimeType:string;size:number};
export type CalendarInvite={method?:string;summary?:string;start?:string;end?:string;status?:string;uid?:string};

export type NormalizedMessage={
  id:string;threadId:string;messageId:string;
  receivedAt:number;
  from:Party;to:Party[];cc:Party[];
  subject:string;
  /** Text written in this message, with quoted history and signature removed. */
  text:string;
  /** Quoted replies kept as separate context so old requests are not read as new tasks. */
  quoted:string;
  signature:string;
  labels:string[];
  headers:Record<string,string>;
  calendar?:CalendarInvite;
  attachments:Attachment[];
  htmlOnly:boolean;
  /** False whenever any part of the message was dropped, truncated, or unavailable. */
  contentComplete:boolean;
  incompleteReasons:string[];
};

type Part={mimeType?:string;filename?:string;body?:{data?:string;size?:number;attachmentId?:string};parts?:Part[];headers?:{name:string;value:string}[]};
export type GmailMessage={id:string;threadId:string;snippet:string;internalDate:string;labelIds:string[];payload:Part};

const TEXT_LIMIT=20000;

const ENTITIES:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',mdash:'—',ndash:'–',hellip:'…',rsquo:'’',lsquo:'‘',ldquo:'“',rdquo:'”'};

export function decodeEntities(value:string){
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(whole,entity:string)=>{
    if(entity[0]==='#'){
      const code=entity[1]==='x'||entity[1]==='X'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
      return Number.isFinite(code)&&code>0&&code<0x110000?String.fromCodePoint(code):whole;
    }
    return ENTITIES[entity.toLowerCase()]??whole;
  });
}

function stripTags(value:string){return value.replace(/<[^>]*>/g,'');}

/**
 * Convert HTML mail to text. Markup is treated purely as data: nothing is executed,
 * no remote content is fetched, and no link is followed. Link targets are preserved
 * inline so a classifier can still see them.
 */
export function htmlToText(html:string){
  let value=html.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ');
  value=value.replace(/<a\b[^>]*?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,(_whole,href:string,label:string)=>{
    const text=decodeEntities(stripTags(label)).replace(/\s+/g,' ').trim();
    if(!href||/^(?:javascript|data):/i.test(href))return text;
    return text&&!text.includes(href)?`${text} (${href})`:href;
  });
  value=value.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote|section|article)>/gi,'\n');
  value=value.replace(/<li\b[^>]*>/gi,'\n- ');
  return decodeEntities(stripTags(value)).replace(/\r/g,'').replace(/[ \t ]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}

const QUOTE_HEADER=[
  /^\s*On\b[\s\S]{3,300}?\bwrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^\s*From:\s.+\n(?:\s*(?:Sent|Date|To|Subject):\s.*\n){1,}/im,
  /^\s*_{10,}\s*$/m,
];

/** Split this message's own text from quoted history, conservatively. */
export function splitQuoted(text:string):{current:string;quoted:string}{
  let cut=-1;
  for(const pattern of QUOTE_HEADER){
    const match=pattern.exec(text);
    if(match&&match.index!==undefined&&(cut===-1||match.index<cut))cut=match.index;
  }
  const lines=text.split('\n');
  // A run of '>' lines that reaches the end of the message is quoted history too.
  for(let i=0;i<lines.length;i++){
    if(!/^\s*>/.test(lines[i]))continue;
    const rest=lines.slice(i).filter(line=>line.trim());
    if(rest.every(line=>/^\s*>/.test(line))){
      const index=lines.slice(0,i).join('\n').length;
      if(cut===-1||index<cut)cut=index;
    }
    break;
  }
  if(cut<=0)return cut===0?{current:'',quoted:text.trim()}:{current:text.trim(),quoted:''};
  return {current:text.slice(0,cut).trim(),quoted:text.slice(cut).trim()};
}

/** Separate a trailing signature. Only the standard '-- ' delimiter and common mobile footers. */
export function splitSignature(text:string):{body:string;signature:string}{
  const delimiter=/\n-{2}[ \t]*\n/g;
  let index=-1;
  for(const match of text.matchAll(delimiter))index=match.index??index;
  if(index>=0)return {body:text.slice(0,index).trim(),signature:text.slice(index).replace(/^\n-{2}[ \t]*\n/,'').trim()};
  const mobile=/\n(Sent from my [^\n]{0,60})\s*$/i.exec(text);
  if(mobile)return {body:text.slice(0,mobile.index).trim(),signature:mobile[1].trim()};
  return {body:text.trim(),signature:''};
}

export function parseParties(value:string):Party[]{
  if(!value.trim())return [];
  // Split on commas that are not inside quotes or angle brackets.
  const parts:string[]=[];let depth=0;let quoted=false;let current='';
  for(const char of value){
    if(char==='"')quoted=!quoted;
    if(char==='<')depth++;
    if(char==='>')depth--;
    if(char===','&&!quoted&&depth<=0){parts.push(current);current='';continue;}
    current+=char;
  }
  parts.push(current);
  return parts.map(entry=>entry.trim()).filter(Boolean).map(entry=>{
    const address=(entry.match(/<([^>]+)>/)?.[1]||entry).trim().toLowerCase();
    const name=entry.includes('<')?entry.split('<')[0].replaceAll('"','').trim():'';
    return {name:name||address.split('@')[0],address};
  }).filter(party=>party.address.includes('@'));
}

function collect(part:Part,into:{text:string[];html:string[];attachments:Attachment[];calendar:string[];deferred:boolean}){
  const mime=(part.mimeType||'').toLowerCase();
  const isAttachment=!!part.filename;
  if(isAttachment){
    into.attachments.push({filename:part.filename!,mimeType:mime||'application/octet-stream',size:part.body?.size||0});
  }else if(part.body?.data){
    const decoded=new TextDecoder().decode(decode(part.body.data));
    if(mime==='text/plain')into.text.push(decoded);
    else if(mime==='text/html')into.html.push(decoded);
    else if(mime==='text/calendar'||mime==='application/ics')into.calendar.push(decoded);
  }else if(part.body?.attachmentId&&!isAttachment&&(mime==='text/plain'||mime==='text/html')){
    // Gmail stores oversized bodies separately; this needs a second fetch to read.
    into.deferred=true;
  }
  for(const child of part.parts||[])collect(child,into);
}

function icsValue(ics:string,field:string){
  const match=new RegExp(`^${field}(?:;[^:\\n]*)?:(.*)$`,'im').exec(ics.replace(/\r\n[ \t]/g,''));
  return match?match[1].trim():undefined;
}

export function parseCalendar(ics:string):CalendarInvite|undefined{
  if(!/BEGIN:VEVENT/i.test(ics))return undefined;
  return {
    method:icsValue(ics,'METHOD'),summary:icsValue(ics,'SUMMARY'),
    start:icsValue(ics,'DTSTART'),end:icsValue(ics,'DTEND'),
    status:icsValue(ics,'STATUS'),uid:icsValue(ics,'UID'),
  };
}

export function normalizeMessage(m:GmailMessage):NormalizedMessage{
  const headers:Record<string,string>={};
  for(const header of m.payload.headers||[])headers[header.name.toLowerCase()]=header.value;
  const found={text:[] as string[],html:[] as string[],attachments:[] as Attachment[],calendar:[] as string[],deferred:false};
  collect(m.payload,found);

  const incompleteReasons:string[]=[];
  const plain=found.text.join('\n').trim();
  const htmlOnly=!plain&&found.html.length>0;
  let raw=plain||(found.html.length?htmlToText(found.html.join('\n')):'');
  if(!raw){raw=m.snippet||'';if(raw)incompleteReasons.push('only-snippet-available');}
  if(found.deferred)incompleteReasons.push('body-stored-separately-by-gmail');

  const {current,quoted}=splitQuoted(raw);
  const {body,signature}=splitSignature(current);
  let text=body;
  if(text.length>TEXT_LIMIT){text=text.slice(0,TEXT_LIMIT);incompleteReasons.push('current-text-truncated');}
  let quotedText=quoted;
  if(quotedText.length>TEXT_LIMIT){quotedText=quotedText.slice(0,TEXT_LIMIT);incompleteReasons.push('quoted-text-truncated');}
  if(found.attachments.length)incompleteReasons.push('attachments-not-read');

  const receivedAt=Number(m.internalDate);
  const from=parseParties(headers.from||'')[0]||{name:'Unknown sender',address:''};
  return {
    id:m.id,threadId:m.threadId,messageId:headers['message-id']||'',
    receivedAt:Number.isFinite(receivedAt)?receivedAt:Date.now(),
    from,to:parseParties(headers.to||''),cc:parseParties(headers.cc||''),
    subject:headers.subject||'(No subject)',
    text,quoted:quotedText,signature,
    labels:m.labelIds||[],headers,
    calendar:found.calendar.length?parseCalendar(found.calendar.join('\n')):undefined,
    attachments:found.attachments,
    htmlOnly,
    contentComplete:incompleteReasons.length===0,
    incompleteReasons,
  };
}
