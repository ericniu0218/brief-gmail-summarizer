/**
 * Make sender-supplied plain text readable without changing what it says.
 *
 * Email generators often pad sections with many empty lines and leave spaces at the end
 * of lines. Keeping one blank line preserves paragraphs while avoiding large empty walls
 * in the reader. This is also safe to apply to old records at display time.
 */
export function normalizeEmailText(value:string){
  return value
    .replace(/\r\n?/g,'\n')
    .replace(/[\t ]+$/gm,'')
    .replace(/\n[\t ]+\n/g,'\n\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

export type EmailTextPart=
  |{kind:'text';value:string}
  |{kind:'link';href:string;label:string;destination:string};

/** Remove punctuation that belongs to the sentence rather than to the URL. */
function splitUrlToken(token:string){
  let end=token.length;
  while(end&&/[.,;!]/.test(token[end-1]))end--;
  // A parenthesized URL normally contributes one unmatched closing parenthesis. Keep
  // balanced parentheses that are genuinely part of a path, such as a Wikipedia title.
  while(end&&token[end-1]===')'){
    const value=token.slice(0,end);
    const opens=(value.match(/\(/g)||[]).length,closes=(value.match(/\)/g)||[]).length;
    if(closes<=opens)break;
    end--;
  }
  return {candidate:token.slice(0,end),trailing:token.slice(end)};
}

/** A short, honest label for a URL; the complete destination remains in `href` and title. */
function linkLabel(url:URL,source:string){
  const host=url.hostname.replace(/^www\./,'');
  const path=url.pathname==='/'?'':url.pathname;
  const readable=`${host}${path}`;
  if(source.length>88||readable.length>72||url.search||url.hash)return `${host}/…`;
  return readable||host;
}

/**
 * Split plain mail into React-friendly text and safe HTTP links.
 *
 * Very long tracking query strings are represented by their real hostname instead of
 * hundreds of noisy characters. The original URL is retained as the link destination
 * and hover title. Invalid URLs remain ordinary text.
 */
export function emailTextParts(value:string):EmailTextPart[]{
  const text=normalizeEmailText(value),parts:EmailTextPart[]=[];
  const pattern=/https?:\/\/[^\s<>"']+/gi;
  let cursor=0,match:RegExpExecArray|null;
  while((match=pattern.exec(text))){
    if(match.index>cursor)parts.push({kind:'text',value:text.slice(cursor,match.index)});
    const {candidate,trailing}=splitUrlToken(match[0]);
    try{
      const url=new URL(candidate);
      if(url.protocol!=='http:'&&url.protocol!=='https:')throw new Error('unsupported protocol');
      parts.push({kind:'link',href:url.href,label:linkLabel(url,candidate),destination:url.hostname});
    }catch{parts.push({kind:'text',value:candidate});}
    if(trailing)parts.push({kind:'text',value:trailing});
    cursor=match.index+match[0].length;
  }
  if(cursor<text.length)parts.push({kind:'text',value:text.slice(cursor)});
  return parts;
}
