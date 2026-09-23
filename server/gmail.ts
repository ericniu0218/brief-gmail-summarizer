import type { Email } from '@/lib/mail';
import { deterministicClassify } from '@/lib/deterministic';
import { derivePriority, effectiveCategories, type Classification } from '@/lib/classification';
import { normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { decrypt, HttpError, runtime, type Runtime } from './runtime';
export type Connection = { user_id:string; email:string; token:string; last_sync:number|null; sync_lock:number; error:string|null };
export async function connection(user:string,e=runtime()) {
  const c=await e.DB.prepare('SELECT * FROM connections WHERE user_id = ?').bind(user).first<Connection>();
  if(!c) throw new HttpError(409,'Connect Gmail before using your live inbox.');
  return c;
}
export async function accessToken(user:string,e=runtime()) {
  const c=await connection(user,e);
  const refresh=await decrypt(c.token,user,e);
  const result=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,client_id:e.GOOGLE_CLIENT_ID!,client_secret:e.GOOGLE_CLIENT_SECRET!}),signal:AbortSignal.timeout(15000)});
  if(!result.ok) throw new HttpError(401,'Your Gmail connection needs to be renewed. Reconnect in settings.');
  const data=await result.json() as {access_token:string};
  return data.access_token;
}
export async function gmail<T>(path:string, token:string, init:RequestInit={}) {
  const result=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!result.ok) throw new HttpError(result.status===429?429:502,result.status===429?'Gmail is busy. Please try again in a minute.':'Gmail could not complete that request. Please try again.');
  return await result.json() as T;
}
export type { GmailMessage } from './message';

/**
 * Build the dashboard's email shape from a normalized message and its classification.
 * Category, tags and priority all come from the one policy in lib/classification.
 */
export function emailFrom(n:NormalizedMessage,classification:Classification,now=Date.now()):Email {
  const {category,tags}=effectiveCategories(classification);
  const priority=derivePriority(classification,now);
  const sender=n.from.name||n.from.address.split('@')[0]||'Unknown sender';
  const list=n.headers['list-unsubscribe']||'';
  const unsubscribe=list.match(/<(https:\/\/[^>]+)>/i)?.[1];
  return {
    id:n.id,threadId:n.threadId,sender,address:n.from.address,
    initials:sender.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase(),
    subject:n.subject,
    summary:n.text.replace(/\s+/g,' ').trim().slice(0,140),
    body:n.text,quoted:n.quoted,
    time:new Date(n.receivedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),
    receivedAt:n.receivedAt,
    category,tags,priority,
    needsReply:classification.replyRequired,
    unread:n.labels.includes('UNREAD'),
    color:['purple','blue','rose','green'][sender.length%4],
    label:priority==='high'?'Important':category==='noise'?'Junk':category==='work'?'Work':'Personal',
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
export function safeUnsubscribe(url:string,e:Runtime) {
  let target:URL; try{target=new URL(url);}catch{return false;}
  if(target.protocol!=='https:'||target.username||target.password||target.port && target.port!=='443')return false;
  const allowed=['list-manage.com','mailchimp.com','sendgrid.net','convertkit.com','beehiiv.com','substack.com',...(e.UNSUBSCRIBE_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)];
  return allowed.some(host=>target.hostname===host||target.hostname.endsWith('.'+host));
}
