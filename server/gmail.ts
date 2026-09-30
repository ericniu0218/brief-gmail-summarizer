import type { Email } from '@/lib/mail';
import { deterministicClassify } from '@/lib/deterministic';
import { applyPolicy, type Classification } from '@/lib/classification';
import { normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { decryptToken, googleClient, HttpError, runtime, type Runtime } from './runtime';

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
export async function gmail<T>(path:string, token:string, init:RequestInit={}) {
  const result=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!result.ok){
    const status=[400,401,403,429].includes(result.status)?result.status:502;
    const message=result.status===429?'Gmail is busy. Please try again in a minute.'
      :result.status===401||result.status===403?'Your Gmail connection needs to be renewed. Reconnect in settings.'
      :'Gmail could not complete that request. Please try again.';
    throw new HttpError(status,message);
  }
  return await result.json() as T;
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
    body:n.text,quoted:n.quoted,html:n.html,
    time:new Date(n.receivedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),
    receivedAt:n.receivedAt,
    category,tags,priority,
    needsReply:classification.replyRequired,
    unread:n.labels.includes('UNREAD'),
    color:['purple','blue','rose','green'][sender.length%4],
    label,
    classification,
    contentComplete:n.contentComplete,incompleteReasons:n.incompleteReasons,
    messageId:n.messageId,unsubscribe,
    oneClick:(n.headers['list-unsubscribe-post']||'').toLowerCase().includes('list-unsubscribe=one-click'),
  };
}

export function parseMessage(m:GmailMessage,userAddress=''):Email {
  const normalized=normalizeMessage(m);
  return emailFrom(normalized,deterministicClassify(normalized,userAddress));
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
