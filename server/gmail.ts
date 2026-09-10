import type { Email } from '@/lib/mail';
import { decode, decrypt, HttpError, runtime, type Runtime } from './runtime';
export const GMAIL_RECONNECT_MESSAGE='Your Gmail connection needs to be renewed. Reconnect in settings.';
export type Connection = { id:string; user_id:string; email:string; token:string; last_sync:number|null; sync_lock:number; error:string|null };
export async function connection(user:string,e=runtime(),accountId?:string) {
  if(accountId !== undefined && (typeof accountId !== 'string' || !accountId || accountId === 'all'))throw new HttpError(400,'Choose a Gmail account for this action.');
  const c=accountId
    ?await e.DB.prepare('SELECT * FROM connections WHERE user_id = ? AND id = ?').bind(user,accountId).first<Connection>()
    :await e.DB.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY id = (SELECT default_account_id FROM account_preferences WHERE user_id = ?) DESC, email LIMIT 1').bind(user,user).first<Connection>();
  if(!c) throw new HttpError(409,'This Gmail account is not connected to your workspace.');
  return c;
}
export async function accessToken(user:string,e=runtime(),accountId?:string) {
  const c=await connection(user,e,accountId);
  const refresh=await decrypt(c.token,user,e);
  const result=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,client_id:e.GOOGLE_CLIENT_ID!,client_secret:e.GOOGLE_CLIENT_SECRET!}),signal:AbortSignal.timeout(15000)});
  if(!result.ok){
    if(result.status===429)throw new HttpError(429,'Google is busy. Please try again in a minute.');
    if(result.status>=500)throw new HttpError(502,'Google is temporarily unavailable. Please try again.');
    const detail=await result.json().catch(()=>null) as {error?:string}|null;
    if(detail?.error==='invalid_grant')throw new HttpError(401,GMAIL_RECONNECT_MESSAGE);
    if(detail?.error==='invalid_client'||detail?.error==='unauthorized_client')throw new HttpError(503,'The workspace Google app credentials need to be checked in settings.');
    throw new HttpError(502,'Google could not renew access right now. Please try again.');
  }
  const data=await result.json() as {access_token:string};
  return data.access_token;
}
export async function gmail<T>(path:string, token:string, init:RequestInit={}) {
  const result=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(20000)});
  if(!result.ok){
    if(result.status===404)throw new HttpError(404,'This email is no longer available. Refresh your inbox.');
    if(result.status===401)throw new HttpError(401,GMAIL_RECONNECT_MESSAGE);
    throw new HttpError(result.status===429?429:502,result.status===429?'Gmail is busy. Please try again in a minute.':'Gmail could not complete that request. Please try again.');
  }
  return await result.json() as T;
}
type Part={mimeType?:string;body?:{data?:string};parts?:Part[];headers?:{name:string;value:string}[]};
export type GmailMessage={id:string;threadId:string;snippet:string;internalDate:string;labelIds:string[];payload:Part};
function plainText(p:Part):string {
  if(p.mimeType==='text/plain' && p.body?.data) return new TextDecoder().decode(decode(p.body.data));
  return (p.parts||[]).map(plainText).filter(Boolean).join('\n');
}
export function parseMessage(m:GmailMessage):Email {
  const header=(name:string)=>m.payload.headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value||'';
  const from=header('From'); const address=(from.match(/<([^>]+)>/)?.[1]||from).trim();
  const sender=(from.includes('<')?from.split('<')[0].replaceAll('"','').trim():address.split('@')[0])||'Unknown sender';
  const list=header('List-Unsubscribe');
  const unsubscribe=list.match(/<(https:\/\/[^>]+)>/i)?.[1];
  const noise=m.labelIds.some(l=>['CATEGORY_PROMOTIONS','SPAM'].includes(l)) || !!list;
  const priority=m.labelIds.includes('IMPORTANT') && !noise;
  return {id:m.id,threadId:m.threadId,receivedAt:Number(m.internalDate),sender,address,initials:sender.split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase(),subject:header('Subject')||'(No subject)',summary:m.snippet,body:(plainText(m.payload)||m.snippet).slice(0,20000),time:new Date(Number(m.internalDate)).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),category:noise?'noise':'personal',priority:priority?'high':'normal',needsReply:false,unread:m.labelIds.includes('UNREAD'),color:['purple','blue','rose','green'][sender.length%4],label:noise?'Newsletter':priority?'Important':'Mail',messageId:header('Message-ID'),unsubscribe,oneClick:header('List-Unsubscribe-Post').toLowerCase().includes('list-unsubscribe=one-click')};
}
export function safeUnsubscribe(url:string,e:Runtime) {
  let target:URL; try{target=new URL(url);}catch{return false;}
  if(target.protocol!=='https:'||target.username||target.password||target.port && target.port!=='443')return false;
  const allowed=['list-manage.com','mailchimp.com','sendgrid.net','convertkit.com','beehiiv.com','substack.com',...(e.UNSUBSCRIBE_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)];
  return allowed.some(host=>target.hostname===host||target.hostname.endsWith('.'+host));
}
