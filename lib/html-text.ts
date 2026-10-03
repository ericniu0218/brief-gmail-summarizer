import { normalizeEmailText } from './email-text';

/**
 * Plain text from email HTML, and the split between a message's own text, its quoted
 * history and its signature. Pure functions with no server dependency: the server uses them
 * to normalize mail, and the browser's reading view uses them to lay out a message.
 */

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

/** Elements whose content is never readable text. */
const HIDDEN_CONTENT=new Set(['script','style','head','title']);
/** Closing one of these ends a line of text. */
const BLOCK_END=new Set(['p','div','tr','li','h1','h2','h3','h4','h5','h6','table','blockquote','section','article']);
/** Longest HTML body converted to text. Beyond this the text is truncated and marked. */
export const MAX_HTML_TEXT_INPUT=2_000_000;

/** A link target from a tag's attributes, read without a backtracking pattern. */
function hrefOf(tag:string){
  const at=tag.search(/\shref\s*=/i);
  if(at<0)return '';
  let index=tag.indexOf('=',at)+1;
  while(tag[index]===' '||tag[index]==='\t'||tag[index]==='\n')index++;
  const quote=tag[index];
  if(quote!=='"'&&quote!=="'")return '';
  const end=tag.indexOf(quote,index+1);
  return end<0?'':tag.slice(index+1,end);
}

/**
 * Convert HTML mail to text. Markup is treated purely as data: nothing is executed,
 * no remote content is fetched, and no link is followed. Link targets are preserved
 * inline so a classifier can still see them.
 *
 * One pass over the input, moving forward only. The previous regular expressions searched
 * to the end of the input again from every unmatched `<`, so a malformed 100 KB body took
 * seconds; the work here grows in proportion to the input. An unterminated comment,
 * script or style hides the rest of the document, as it does in a browser, and a `<` with
 * no `>` after it anywhere is plain text.
 */
export function htmlToText(html:string,options:{cells?:boolean}={}){
  const source=html.length>MAX_HTML_TEXT_INPUT?html.slice(0,MAX_HTML_TEXT_INPUT):html;
  const lower=source.toLowerCase();
  // Closing tags already known to be absent, so an unclosed `<title>` repeated thousands of
  // times is searched for once rather than once per repeat.
  const unclosed=new Set<string>();
  // Output is kept as chunks: closing a link replaces only its own label, never copies the
  // whole text written so far.
  const out:string[]=[];
  let cursor=0;
  let link:{href:string;start:number}|undefined;
  const closeLink=()=>{
    if(!link)return;
    const label=out.splice(link.start).join('').replace(/\s+/g,' ').trim();
    const text=decodeEntities(label);
    const href=link.href,decoded=decodeEntities(href);
    const replacement=!href||/^(?:javascript|data):/i.test(decoded.trim())?label
      :text&&!text.includes(decoded)?`${label} (${href})`:href;
    out.push(replacement);
    link=undefined;
  };
  while(cursor<source.length){
    const open=source.indexOf('<',cursor);
    if(open<0){out.push(source.slice(cursor));break;}
    out.push(source.slice(cursor,open));
    if(source.startsWith('<!--',open)){
      const end=source.indexOf('-->',open+4);
      if(end<0)break;
      out.push(' ');cursor=end+3;continue;
    }
    const close=source.indexOf('>',open+1);
    if(close<0){out.push(source.slice(open));break;}
    cursor=close+1;
    const tag=lower.slice(open+1,close);
    const match=/^(\/)?\s*([a-z][a-z0-9]*)/.exec(tag);
    if(!match)continue;
    const closing=!!match[1],name=match[2];
    if(!closing&&HIDDEN_CONTENT.has(name)&&!tag.endsWith('/')){
      if(unclosed.has(name))continue;
      const end=lower.indexOf('</'+name,cursor);
      if(end<0){
        // Script and style run to the end of an unclosed document; a stray <title> or
        // <head> opener is only a tag.
        if(name==='script'||name==='style')break;
        unclosed.add(name);continue;
      }
      const endClose=source.indexOf('>',end);
      out.push(' ');cursor=endClose<0?source.length:endClose+1;continue;
    }
    if(name==='a'){
      // Links do not nest; a new one closes the previous, as a browser's parser does.
      closeLink();
      if(!closing)link={href:hrefOf(source.slice(open+1,close)),start:out.length};
      continue;
    }
    // The reading view keeps table cells apart (a receipt's columns); the stored text, which
    // fingerprints and classification read, is left exactly as it has always been.
    if(options.cells&&closing&&(name==='td'||name==='th'))out.push('\t');
    else if(name==='br')out.push('\n');
    else if(closing&&BLOCK_END.has(name))out.push('\n');
    else if(!closing&&name==='li')out.push('\n- ');
  }
  closeLink();
  const text=decodeEntities(out.join(''));
  return normalizeEmailText(options.cells?text.replace(/[ \u00a0]+/g,' ').replace(/ *\t */g,'\t').replace(/\t+(?=\n|$)/g,''):text.replace(/[ \t\u00a0]+/g,' '));
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

