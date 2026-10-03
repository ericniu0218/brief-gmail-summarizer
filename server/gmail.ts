import type { Email } from '@/lib/mail';
import { deterministicClassify } from '@/lib/deterministic';
import { applyPolicy, type Classification } from '@/lib/classification';
import { gmailSignals } from '@/lib/gmail-signals';
import { normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { encode, decryptToken, googleClient, HttpError, runtime, type Runtime } from './runtime';
import { normalizeAddress } from '@/lib/recipients';
import { replyAddress } from '@/lib/reply-address';

export type Connection = {
  id:string; user_id:string; provider_identity:string|null; email:string; token:string;
  token_version:number; last_sync:number|null; sync_lock:number; error:string|null; created:number;
  sync_page_token:string|null; sync_generation:string|null; sync_skipped:number;sync_full_scan:number;backfill_complete:number;last_full_scan:number|null;content_version:number;
};

/** The reserved selection for the combined view. It is never a credential-bearing account. */
export const ALL_INBOXES='all';

/**
 * The single authorization funnel for every account-scoped operation.
 *
 * It matches owner *and* account together, so holding an account id proves nothing by
 * itself. A mailbox owned by someone else and a mailbox that does not exist return the
 * same error, so responses cannot be used to discover other users' accounts.
 */
export async function getOwnedConnection(user:string,accountId:string,e=runtime()){
  if(!accountId||accountId===ALL_INBOXES)throw new HttpError(400,'Choose a specific Gmail account for this action.');
  const c=await e.DB.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').bind(accountId,user).first<Connection>();
  if(!c)throw new HttpError(404,'That Gmail account is not connected.');
  return c;
}

/** Every mailbox this user owns, oldest connection first, for listing and fan-out. */
export async function ownedConnections(user:string,e=runtime()){
  const rows=await e.DB.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created, id').bind(user).all<Connection>();
  return rows.results||[];
}

/**
 * Read a connection's refresh token in whichever format it was stored.
 *
 * This deliberately does not rewrite the stored ciphertext. A refresh holds its lease by
 * remembering the token it started with, so re-encrypting here would change that value
 * mid-sync and make a healthy refresh look stale. Legacy tokens are upgraded on reconnect.
 */
export async function refreshTokenFor(c:Connection,e=runtime()){
  return decryptToken(c.token,c.user_id,c.id,c.token_version,e);
}

export async function accessToken(user:string,accountId:string,e=runtime()) {
  const c=await getOwnedConnection(user,accountId,e);
  const refresh=await refreshTokenFor(c,e);
  const result=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,...googleClient(e)}),signal:AbortSignal.timeout(15000)});
  if(!result.ok) throw new HttpError(401,'Your Gmail connection needs to be renewed. Reconnect in settings.');
  const data=await result.json() as {access_token:string};
  return data.access_token;
}
// Gmail reports per-user rate limits as 403 as well as 429. Those mean "slow down", not
// "this connection is broken", so they are treated as busy and retried rather than asking
// the person to reconnect.
const RATE_LIMITED=/rateLimitExceeded|userRateLimitExceeded|tooManyConcurrentRequests|backendError|RESOURCE_EXHAUSTED/i;
async function failureFrom(result:Response){
  let detail='';
  try{detail=(await result.text()).slice(0,4000);}catch{/* The status alone still decides. */}
  return gmailFailure(result.status===403&&RATE_LIMITED.test(detail)?429:result.status);
}
const busy=(status:number)=>status===429||status>=500;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** How long to wait before retry `attempt`: Gmail's Retry-After when given, else 0.5 s, 1 s, 2 s, with jitter. */
function retryDelay(result:Response,attempt:number){
  const after=Number(result.headers.get('retry-after'));
  const base=Number.isFinite(after)&&after>0?after*1000:500*2**attempt;
  return Math.min(base,8000)+Math.floor(Math.random()*250);
}
const READ_ATTEMPTS=4;
function gmailFailure(status:number){
  const mapped=[400,401,403,404,429].includes(status)?status:502;
  const message=status===429?'Gmail is busy. Please try again in a minute.'
    :status===401||status===403?'Your Gmail connection needs to be renewed. Reconnect in settings.'
    :status===404?'That Gmail item is no longer available.'
    :'Gmail could not complete that request. Please try again.';
  return new HttpError(mapped,message);
}
/**
 * One Gmail API call. Reads are retried a few times when Gmail is busy or briefly failing;
 * anything that changes Gmail (send, draft, delete) is never retried here, because a
 * timeout there may already have taken effect — the send protocol handles that case.
 */
export async function gmail<T>(path:string, token:string, init:RequestInit={}) {
  const read=!init.method||init.method.toUpperCase()==='GET';
  for(let attempt=0;;attempt++){
    const result=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:init.signal??AbortSignal.timeout(20000)});
    if(result.ok)return await result.json() as T;
    const failure=await failureFrom(result);
    if(!read||!busy(failure.status===502?500:failure.status)||attempt+1>=READ_ATTEMPTS)throw failure;
    await pause(retryDelay(result,attempt));
  }
}
/**
 * Sends or drafts a complete message (including attachments) by uploading it as-is, which
 * avoids base64-encoding a large message a second time inside JSON.
 */
export async function gmailUpload<T>(path:string, token:string, mime:string,method:'POST'|'PUT'='POST') {
  const result=await fetch(`https://gmail.googleapis.com/upload/gmail/v1/users/me/${path}?uploadType=media`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'message/rfc822'},body:mime,signal:AbortSignal.timeout(60000)});
  if(!result.ok)throw await failureFrom(result);
  return await result.json() as T;
}
export async function gmailDelete(path:string,token:string){
  const result=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
  if(!result.ok&&result.status!==404)throw await failureFrom(result);
}
export type { GmailMessage } from './message';

/**
 * Build the dashboard's email shape from a normalized message and its classification.
 * Category, tags and priority all come from the one policy in lib/classification.
 */
export function emailFrom(n:NormalizedMessage,proposed:Classification,now=Date.now()):Email {
  // One policy decides the effective classification and everything derived from it.
  const {classification,category,tags,priority,label}=applyPolicy(proposed,now);
  const sender=n.from.name||n.from.address.split('@')[0]||'Unknown sender';
  const list=n.headers['list-unsubscribe']||'';
  const unsubscribe=list.match(/<(https:\/\/[^>]+)>/i)?.[1];
  return {
    id:n.id,threadId:n.threadId,sender,address:n.from.address,
    initials:sender.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase(),
    subject:n.subject,
    summary:classification.summary||n.text.replace(/\s+/g,' ').trim().slice(0,140),
    body:n.text,quoted:n.quoted,signature:n.signature,html:n.html,
    time:new Date(n.receivedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),
    receivedAt:n.receivedAt,senderFamiliarity:n.senderFamiliarity,
    category,tags,priority,
    needsReply:classification.replyRequired,
    unread:n.labels.includes('UNREAD'),
    gmailLabels:gmailSignals(n.labels)||[],
    inInbox:n.labels.includes('INBOX'),
    color:['purple','blue','rose','green'][sender.length%4],
    label,
    classification,
    contentComplete:n.contentComplete,incompleteReasons:n.incompleteReasons,hasAttachments:n.attachments.length>0,
    messageId:n.messageId,unsubscribe,
    to:n.to.map(party=>party.address).filter(Boolean).slice(0,50),cc:n.cc.map(party=>party.address).filter(Boolean).slice(0,50),
    replyTo:replyAddress((n.headerValues?.['reply-to']||
      (n.headers['reply-to']?[n.headers['reply-to']]:[])).map(value=>({name:'Reply-To',value})),n.from.address),
    oneClick:(n.headers['list-unsubscribe-post']||'').toLowerCase().includes('list-unsubscribe=one-click'),
  };
}

export function parseMessage(m:GmailMessage,userAddress=''):Email {
  const normalized=normalizeMessage(m);
  return {...emailFrom(normalized,deterministicClassify(normalized,userAddress)),readerWasRecipient:[...normalized.to,...normalized.cc].some(party=>party.address.toLowerCase()===userAddress.toLowerCase())};
}
/**
 * Addresses this server must never call, whatever a header says.
 *
 * An unsubscribe URL comes from mail written by a stranger, so it is treated as hostile
 * input aimed at the network this worker sits on. Anything naming an address literal rather
 * than a public name is refused outright: there is no legitimate unsubscribe endpoint at an
 * IP address, and every interesting target of a server-side request forgery — loopback, a
 * private range, link-local metadata services, unique local addresses — is reachable only
 * that way.
 */
const IPV4=/^\d{1,3}(?:\.\d{1,3}){3}$/;
const INTERNAL_NAME=/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;
export function privateDestination(hostname:string){
  const host=hostname.toLowerCase().replace(/\.$/,'');
  if(!host)return true;
  // An IPv6 literal arrives bracketed from the URL parser; any of them is refused, which
  // covers ::1, fc00::/7 and fe80::/10 without parsing the address.
  if(host.startsWith('['))return true;
  if(INTERNAL_NAME.test(host))return true;
  if(IPV4.test(host)){
    const parts=host.split('.').map(Number);
    if(parts.some(part=>!Number.isInteger(part)||part<0||part>255))return true;
    const [a,b]=parts;
    // Loopback, both private ranges, link-local (which carries cloud metadata at
    // 169.254.169.254), carrier-grade NAT, and this-network.
    return a===127||a===10||a===0||(a===172&&b>=16&&b<=31)||(a===192&&b===168)
      ||(a===169&&b===254)||(a===100&&b>=64&&b<=127);
  }
  // A name with no dot cannot be a public domain, so it can only resolve somewhere local.
  return !host.includes('.');
}

/**
 * Whether this server may make an unsubscribe request to a URL by itself.
 *
 * The allowlist is the substance of the protection and is deliberately kept: a destination
 * this app has never heard of is offered to the person to open, never called automatically.
 * The checks before it make the allowlist meaningful — a hostname is compared on domain
 * boundaries, so `list-manage.com.attacker.example` does not match `list-manage.com`.
 *
 * DNS is not resolved here, so this cannot detect a name that resolves to a private address
 * or rebinds between the check and the request. That is acceptable only because the
 * allowlist limits requests to known bulk providers; widening it would require resolving
 * and pinning the address before connecting.
 */
export function safeUnsubscribe(url:string,e:Runtime) {
  let target:URL; try{target=new URL(url);}catch{return false;}
  if(target.protocol!=='https:'||target.username||target.password||target.port && target.port!=='443')return false;
  if(privateDestination(target.hostname))return false;
  const allowed=['list-manage.com','mailchimp.com','sendgrid.net','convertkit.com','beehiiv.com','substack.com',...(e.UNSUBSCRIBE_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)];
  const host=target.hostname.toLowerCase().replace(/\.$/,'');
  return allowed.some(entry=>host===entry||host.endsWith('.'+entry));
}

// ---- Composing a message -------------------------------------------------------------------
export const MAX_RECIPIENTS=20;
function addressList(input:unknown,required:boolean):string[] {
  if(!required&&(input===undefined||input===null||input===''))return [];
  if(typeof input!=='string')throw new HttpError(400,required?'Add at least one recipient.':'Cc and Bcc must be email addresses.');
  if(!input.trim()){if(required)throw new HttpError(400,'Add at least one recipient.');return [];}
  const seen=new Map<string,string>();
  for(const token of input.split(/[\s,;]+/).filter(Boolean)){
    const address=normalizeAddress(token);
    if(!address)throw new HttpError(400,`"${token.slice(0,60)}" is not a plain email address. Use addresses like name@example.com, separated by commas.`);
    if(!seen.has(address.toLowerCase()))seen.set(address.toLowerCase(),address);
  }
  return [...seen.values()];
}
/**
 * Accepts plain addresses separated by commas, semicolons, or whitespace. Anything that is not
 * a bare address is rejected, so a pasted value can never add hidden recipients or headers.
 * An address appears once overall (To wins over Cc, Cc over Bcc) and To+Cc+Bcc is capped.
 */
export function parseRecipientGroups(input:{to?:unknown;cc?:unknown;bcc?:unknown}):{to:string[];cc:string[];bcc:string[]} {
  const to=addressList(input.to,true);
  const taken=new Set(to.map(a=>a.toLowerCase()));
  const unseen=(list:string[])=>list.filter(a=>{const key=a.toLowerCase();if(taken.has(key))return false;taken.add(key);return true;});
  const cc=unseen(addressList(input.cc,false));const bcc=unseen(addressList(input.bcc,false));
  if(to.length+cc.length+bcc.length>MAX_RECIPIENTS)throw new HttpError(400,`Send to at most ${MAX_RECIPIENTS} people at a time.`);
  return {to,cc,bcc};
}
// Encodes in pieces whose length is a multiple of three so large attachments never build a huge
// intermediate string or array.
function base64(bytes:Uint8Array){
  let out='';
  for(let i=0;i<bytes.length;i+=24576)out+=btoa(String.fromCharCode(...bytes.subarray(i,i+24576)));
  return out;
}
const wrap76=(text:string)=>text.match(/.{1,76}/g)?.join('\r\n')||'';
// RFC 2047 encoded words are limited to 75 characters, so long or non-ASCII subjects are split
// on character boundaries (45 bytes of text per word) and folded onto continuation lines.
function encodeSubject(subject:string) {
  const encoder=new TextEncoder();const words:string[]=[];let chunk:number[]=[];
  const flush=()=>{if(chunk.length)words.push(`=?UTF-8?B?${base64(Uint8Array.from(chunk))}?=`);chunk=[];};
  for(const char of subject){
    const bytes=encoder.encode(char);
    if(chunk.length+bytes.length>45)flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join('\r\n ');
}
export type MimeAttachment={name:string;type:string;bytes:Uint8Array};
/** RFC 2231 continuation lines keep long UTF-8 filenames within mail header limits. */
function filenameParameters(name:string){
  const fallback=name.replace(/[^\x20-\x7e]/g,'_').replace(/["\\]/g,'_').slice(0,60);
  const encoded=encodeURIComponent(name).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const atoms=encoded.match(/%[0-9A-F]{2}|[^%]/g)||[];
  const chunks:string[]=[];
  for(let index=0;index<atoms.length;){
    let chunk='';
    while(index<atoms.length&&chunk.length+atoms[index].length<=48)chunk+=atoms[index++];
    chunks.push(chunk);
  }
  const extended=chunks.length<=1?`filename*=UTF-8''${chunks[0]||''}`:
    chunks.map((chunk,index)=>`filename*${index}*=${index===0?"UTF-8''":''}${chunk}`).join(';\r\n ');
  return {fallback,extended};
}
export function buildMime({to,cc=[],bcc=[],subject,body,inReplyTo,attachments=[]}:{to:string[];cc?:string[];bcc?:string[];subject:string;body:string;inReplyTo?:string;attachments?:MimeAttachment[]}) {
  if(!to.length||![...to,...cc,...bcc].every(address=>normalizeAddress(address)===address))throw new HttpError(400,'Add at least one valid recipient.');
  if(/[\r\n]/.test(inReplyTo||''))throw new HttpError(400,'The conversation reference is not valid.');
  const headers=[`To: ${to.join(', ')}`,...(cc.length?[`Cc: ${cc.join(', ')}`]:[]),...(bcc.length?[`Bcc: ${bcc.join(', ')}`]:[]),`Subject: ${encodeSubject(subject)}`,...(inReplyTo?[`In-Reply-To: ${inReplyTo}`,`References: ${inReplyTo}`]:[]),'MIME-Version: 1.0'];
  const text=wrap76(base64(new TextEncoder().encode(body)));
  if(!attachments.length)return [...headers,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',text].join('\r\n');
  // Base64 never contains "-", so this boundary cannot appear inside any encoded part.
  const boundary='----=_brief_'+crypto.randomUUID();
  const parts=[`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${text}`];
  for(const file of attachments){
    const {fallback,extended}=filenameParameters(file.name);
    parts.push(`--${boundary}\r\nContent-Type: ${file.type}; name="${fallback}"\r\nContent-Disposition: attachment;\r\n filename="${fallback}";\r\n ${extended}\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(base64(file.bytes))}`);
  }
  return [...headers,`Content-Type: multipart/mixed; boundary="${boundary}"`,'',parts.join('\r\n')+`\r\n--${boundary}--`].join('\r\n');
}
/** The same message as base64url text, the form the Gmail JSON API expects. */
export function buildRawMessage(message:{to:string[];cc?:string[];bcc?:string[];subject:string;body:string;inReplyTo?:string}) {return encode(buildMime(message));}
