import { decode } from './runtime';
import { normalizeEmailText } from '@/lib/email-text';
import { htmlToText, MAX_HTML_TEXT_INPUT, splitQuoted, splitSignature } from '@/lib/html-text';
// Text extraction and splitting are shared with the browser's reading view (lib/html-text).
export { decodeEntities, htmlToText, MAX_HTML_TEXT_INPUT, splitQuoted, splitSignature } from '@/lib/html-text';

/**
 * Gmail-to-application normalization. This module turns nested MIME payloads into a
 * bounded, inert record for classification while preserving quoted history, signatures,
 * calendar metadata, and indicators for content that could not be read.
 */

export type Party={name:string;address:string};
export type Attachment={filename:string;mimeType:string;size:number};
export type CalendarInvite={method?:string;summary?:string;start?:string;end?:string;status?:string;uid?:string};

export type NormalizedMessage={
  id:string;threadId:string;messageId:string;
  receivedAt:number;
  senderFamiliarity?:import('@/lib/sender-familiarity').SenderFamiliarity;
  senderFamiliarityDeferred?:boolean;
  senderFamiliarityAttemptedAt?:number;
  from:Party;to:Party[];cc:Party[];
  subject:string;
  /** Text written in this message, with quoted history and signature removed. */
  text:string;
  /** Quoted replies kept as separate context so old requests are not read as new tasks. */
  quoted:string;
  signature:string;
  /** Original rich body for isolated display. Never use this untrusted HTML for sorting. */
  html?:string;
  labels:string[];
  headers:Record<string,string>;
  /**
   * Every value for each header, including repeats. Optional because a message normalized
   * by an older version, or a fixture, may not carry it; readers fall back to `headers`.
   */
  headerValues?:Record<string,string[]>;
  calendar?:CalendarInvite;
  /**
   * Campaign headers, derived once here so both classifiers read the same facts. Only ever
   * supporting evidence of a promotion. Optional because older records do not carry it.
   */
  distribution?:{listUnsubscribe:boolean;bulkPrecedence:boolean};
  attachments:Attachment[];
  htmlOnly:boolean;
  /** False whenever any part of the message was dropped, truncated, or unavailable. */
  contentComplete:boolean;
  incompleteReasons:string[];
};

export type GmailPart={mimeType?:string;filename?:string;body?:{data?:string;size?:number;attachmentId?:string};parts?:GmailPart[];headers?:{name:string;value:string}[]};
export type GmailMessage={id:string;threadId:string;snippet:string;internalDate:string;labelIds:string[];payload:Part};
type Part=GmailPart;

const TEXT_LIMIT=20000;
// Keep a single stored message comfortably below D1's row limit after JSON encoding.
const HTML_DISPLAY_LIMIT=750_000;
const MAX_MIME_DEPTH=20;
const MAX_DEFERRED_BODIES=8;
/** Largest calendar file read from a named attachment. Invitations are a few kilobytes. */
const MAX_CALENDAR_BYTES=262144;
const CALENDAR_TYPES=['text/calendar','application/ics'];
/** A calendar part is read even when it carries a filename such as `invite.ics`. */
function isCalendarPart(mime:string,size:number){
  return CALENDAR_TYPES.includes(mime)&&size<=MAX_CALENDAR_BYTES;
}
const MAX_DEFERRED_BYTES=2_000_000;

/**
 * Gmail may put a large text body behind an attachment id even though it is not a file.
 * Fetch only those readable body parts, with hard count and declared-size limits. A
 * failed fetch stays unset, so normalization truthfully marks the message incomplete.
 */
export async function hydrateDeferredBodies(message:GmailMessage,load:(attachmentId:string)=>Promise<{data?:unknown;size?:unknown}>){
  const deferred:GmailPart[]=[];
  function visit(part:GmailPart|undefined,depth=0){
    if(!part||depth>MAX_MIME_DEPTH)return;
    const mime=typeof part.mimeType==='string'?part.mimeType.toLowerCase():'';
    const readable=!part.filename&&['text/plain','text/html','text/calendar','application/ics'].includes(mime);
    if(part.body?.attachmentId&&!part.body.data&&(readable||isCalendarPart(mime,part.body.size||0)))deferred.push(part);
    for(const child of Array.isArray(part.parts)?part.parts:[])visit(child,depth+1);
  }
  visit(message.payload);
  for(const part of deferred.slice(0,MAX_DEFERRED_BODIES)){
    if((part.body?.size||0)>MAX_DEFERRED_BYTES)continue;
    try{
      const result=await load(part.body!.attachmentId!);
      if(typeof result.data==='string'&&result.data.length<=Math.ceil(MAX_DEFERRED_BYTES*4/3)+8)part.body!.data=result.data;
    }catch{/* The normalizer records the still-deferred body as incomplete. */}
  }
  return message;
}

/** Some senders publish a broken text/plain alternative containing their CSS bundle. */
function looksLikeLeakedCss(value:string){
  const rules=value.match(/(?:^|\n)\s*[^\n{}]{1,100}\{[^{}]{1,2000}\}/g)||[];
  const declarations=value.match(/(?:^|[;{\n]\s*)(?:background|border(?:-color)?|color|font(?:-family|-size|-weight)?|margin|padding|width|height)\s*:/gim)||[];
  return rules.length>=2&&declarations.length>=4;
}

export function parseParties(value:string):Party[]{
  if(!value.trim())return [];
  // Split on commas that are not inside quotes or angle brackets.
  const parts:string[]=[];let depth=0;let quoted=false;let comments=0;let escaped=false;let current='';
  for(const char of value){
    if(escaped){if(!comments)current+=char;escaped=false;continue;}
    if(char==='\\'&&(quoted||comments)){if(!comments)current+=char;escaped=true;continue;}
    if(!quoted&&char==='('){comments++;continue;}
    if(comments){if(char===')')comments--;continue;}
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

function collect(part:Part|null|undefined,into:{text:string[];html:string[];attachments:Attachment[];calendar:string[];deferred:boolean;depthLimited:boolean;malformed:boolean},depth=0){
  // Walk the MIME tree once, separating readable body variants from metadata-only
  // attachments. Attachment bytes are deliberately never decoded here.
  if(depth>MAX_MIME_DEPTH){into.depthLimited=true;return;}
  if(!part||typeof part!=='object'){into.malformed=true;return;}
  const mime=typeof part.mimeType==='string'?part.mimeType.toLowerCase():'';
  const named=typeof part.filename==='string'&&!!part.filename;
  // An invitation often arrives only as `invite.ics`. It is read like an inline calendar
  // part, within a size bound, instead of being listed as an unread attachment.
  const isAttachment=named&&!isCalendarPart(mime,part.body?.size||0);
  if(isAttachment){
    into.attachments.push({filename:part.filename!,mimeType:mime||'application/octet-stream',size:part.body?.size||0});
  }else if(typeof part.body?.data==='string'&&part.body.data){
    const decoded=new TextDecoder().decode(decode(part.body.data));
    if(mime==='text/plain')into.text.push(decoded);
    else if(mime==='text/html')into.html.push(decoded);
    else if(mime==='text/calendar'||mime==='application/ics')into.calendar.push(decoded);
  }else if(part.body?.data!==undefined&&typeof part.body.data!=='string'){
    into.malformed=true;
  }else if(part.body?.attachmentId&&!isAttachment&&(mime==='text/plain'||mime==='text/html'||mime==='text/calendar'||mime==='application/ics')){
    // Gmail stores oversized bodies separately; this needs a second fetch to read.
    into.deferred=true;
  }
  if(part.parts!==undefined&&!Array.isArray(part.parts))into.malformed=true;
  for(const child of Array.isArray(part.parts)?part.parts:[])collect(child,into,depth+1);
}

function icsProperty(ics:string,field:string){
  // Parameter values may be quoted, and a quoted value may contain ':' — Outlook writes
  // TZID="(UTC-08:00) Pacific Time (US & Canada)". The value starts at the first unquoted ':'.
  const match=new RegExp(`^${field}((?:;(?:[^:;"\\n]|"[^"\\n]*")*)*):(.*)$`,'im').exec(ics.replace(/\r?\n[ \t]/g,''));
  return match?{params:match[1],value:match[2].trim()}:undefined;
}
function icsValue(ics:string,field:string){return icsProperty(ics,field)?.value;}

/** Milliseconds `zone` is ahead of UTC at the instant `at`. Throws for an unknown zone. */
function zoneOffset(at:number,zone:string){
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',
    year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'})
    .formatToParts(new Date(at)).map(part=>[part.type,part.value]));
  return Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second))-at;
}

/**
 * An iCalendar date-time as ISO 8601, so every consumer can read it without knowing the
 * format. Calendar files write `20260930T090000Z`, not the extended form `Date.parse`
 * accepts, and a local time is only meaningful with the `TZID` beside it.
 *
 *   - UTC (`…Z`) becomes `2026-09-30T09:00:00Z`.
 *   - A `TZID` local time is converted to UTC in that zone, daylight saving included.
 *   - An all-day `VALUE=DATE` becomes the date alone.
 *   - A floating time, or one in a zone this runtime does not know, keeps its wall-clock
 *     form with no zone; readers treat it as that day with an unknown timezone.
 *
 * Anything else is returned as written, which `Date.parse` may still understand.
 */
export function icsDateTime(params:string,value:string):string{
  const match=/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value);
  if(!match)return value;
  const [,y,mo,d,h,mi,sec='00',utc]=match;
  const date=`${y}-${mo}-${d}`;
  if(h===undefined)return date;
  const wall=`${date}T${h}:${mi}:${sec}`;
  if(utc)return `${wall}Z`;
  const zone=/;TZID=("?)([^;:"]+)\1/i.exec(params)?.[2];
  if(!zone)return wall;
  try{
    const guess=Date.UTC(Number(y),Number(mo)-1,Number(d),Number(h),Number(mi),Number(sec));
    let instant=guess-zoneOffset(guess,zone);
    // Once more at the corrected instant, in case the guess fell across a DST change.
    instant=guess-zoneOffset(instant,zone);
    return new Date(instant).toISOString().replace('.000Z','Z');
  }catch{return wall;}
}

export function parseCalendar(ics:string):CalendarInvite|undefined{
  // Extract only fields the sorter needs. This is intentionally not a general iCalendar
  // parser; folded lines are handled by `icsProperty` and all other properties are ignored.
  // Event fields come from the event itself: a VTIMEZONE block, which usually comes first,
  // has DTSTART lines of its own describing when daylight saving began in 1970.
  const event=/BEGIN:VEVENT[\s\S]*?(?:END:VEVENT|$)/i.exec(ics)?.[0];
  if(!event)return undefined;
  const start=icsProperty(event,'DTSTART'),end=icsProperty(event,'DTEND');
  return {
    method:icsValue(ics,'METHOD'),summary:icsValue(event,'SUMMARY'),
    start:start?icsDateTime(start.params,start.value):undefined,end:end?icsDateTime(end.params,end.value):undefined,
    status:icsValue(event,'STATUS'),uid:icsValue(event,'UID'),
  };
}

export function normalizeMessage(m:GmailMessage):NormalizedMessage{
  // 1. Read headers and partition the MIME tree into its useful content types.
  const headers:Record<string,string>={};
  // Every value for a repeated header, in the order received. `headers` keeps one value for
  // the many callers that want a single string; unsubscribe decisions read this instead,
  // because two List-Unsubscribe headers that disagree must be noticed rather than one
  // silently overwriting the other.
  const headerValues:Record<string,string[]>={};
  const found={text:[] as string[],html:[] as string[],attachments:[] as Attachment[],calendar:[] as string[],deferred:false,depthLimited:false,malformed:false};
  const payload=m.payload&&typeof m.payload==='object'?m.payload:undefined;
  if(!payload)found.malformed=true;
  if(payload?.headers!==undefined&&!Array.isArray(payload.headers))found.malformed=true;
  for(const header of Array.isArray(payload?.headers)?payload.headers:[]){
    if(!header||typeof header.name!=='string'||typeof header.value!=='string'){found.malformed=true;continue;}
    const name=header.name.toLowerCase();
    headers[name]=header.value;
    (headerValues[name]||=[]).push(header.value);
  }
  collect(payload,found);

  // 2. Prefer plain text, safely reduce HTML when needed, and record every reason the
  // normalized content is incomplete instead of silently treating a snippet as complete.
  const incompleteReasons:string[]=[];
  // Plain MIME alternatives need the same whitespace cleanup as HTML-derived text.
  // Bulk-mail generators commonly insert many empty spacer lines into this part.
  const plain=normalizeEmailText(found.text.join('\n'));
  // multipart/alternative should contain one HTML representation. If malformed mail
  // supplies several, the largest is normally the complete newsletter rather than a
  // signature fragment or quoted footer.
  const richHtml=found.html.reduce((best,value)=>value.length>best.length?value:best,'');
  const htmlOnly=!plain&&!!richHtml;
  const brokenPlain=!!(plain&&richHtml&&looksLikeLeakedCss(plain));
  let raw=brokenPlain?htmlToText(richHtml):plain||(richHtml?htmlToText(richHtml):'');
  if((brokenPlain||!plain)&&richHtml.length>MAX_HTML_TEXT_INPUT)incompleteReasons.push('formatted-body-truncated');
  const displayHtml=richHtml&&new TextEncoder().encode(richHtml).byteLength<=HTML_DISPLAY_LIMIT?richHtml:undefined;
  if(richHtml&&!displayHtml)incompleteReasons.push('formatted-body-too-large');
  if(!raw){raw=normalizeEmailText(m.snippet||'');if(raw)incompleteReasons.push('only-snippet-available');}
  if(found.deferred)incompleteReasons.push('body-stored-separately-by-gmail');
  if(found.depthLimited)incompleteReasons.push('mime-depth-limit');
  if(found.malformed)incompleteReasons.push('malformed-message-structure');

  // 3. Separate newly written text from old thread context and signatures, then enforce
  // independent size limits so quoted history cannot crowd out the current message.
  const {current,quoted}=splitQuoted(raw);
  const {body,signature}=splitSignature(current);
  let text=body;
  if(text.length>TEXT_LIMIT){text=text.slice(0,TEXT_LIMIT);incompleteReasons.push('current-text-truncated');}
  let quotedText=quoted;
  if(quotedText.length>TEXT_LIMIT){quotedText=quotedText.slice(0,TEXT_LIMIT);incompleteReasons.push('quoted-text-truncated');}
  if(found.attachments.length)incompleteReasons.push('attachments-not-read');

  // 4. Assemble the stable record consumed by classification and inbox rendering.
  const receivedAt=Number(m.internalDate);
  // Some automated mail omits From but still supplies Sender or Return-Path. The final
  // identifier is deliberately unique so unrelated unattributed mail cannot share a mute.
  const from=parseParties(headers.from||'')[0]
    ||parseParties(headers.sender||'')[0]
    ||parseParties(headers['return-path']||'')[0]
    ||{name:'Unknown sender',address:`unattributed:${m.id}`};
  return {
    id:m.id,threadId:m.threadId,messageId:headers['message-id']||'',
    receivedAt:Number.isFinite(receivedAt)?receivedAt:Date.now(),
    from,to:parseParties(headers.to||''),cc:parseParties(headers.cc||''),
    subject:headers.subject||'(No subject)',
    text,quoted:quotedText,signature,html:displayHtml,
    labels:m.labelIds||[],headers,headerValues,
    calendar:found.calendar.length?parseCalendar(found.calendar.join('\n')):undefined,
    distribution:{listUnsubscribe:!!(headers['list-unsubscribe']||'').trim(),
      bulkPrecedence:/^\s*(?:bulk|list)\b/i.test(headers.precedence||'')},
    attachments:found.attachments,
    htmlOnly,
    contentComplete:incompleteReasons.length===0,
    incompleteReasons,
  };
}
