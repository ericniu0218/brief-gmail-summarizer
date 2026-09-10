import type { Email } from '@/lib/mail';
import { hasImportantSignal } from '@/lib/inbox-priority';
import { decode, decrypt, HttpError, runtime, type Runtime } from './runtime';
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
  const subject=header('Subject')||'(No subject)';
  const body=(plainText(m.payload)||m.snippet).slice(0,20000);
  const list=header('List-Unsubscribe');
  const unsubscribe=list.match(/<(https:\/\/[^>]+)>/i)?.[1];
  const noise=m.labelIds.some(l=>['CATEGORY_PROMOTIONS','SPAM'].includes(l)) || !!list;
  const priority=!noise&&(m.labelIds.includes('IMPORTANT')||hasImportantSignal(subject,body));
  return {id:m.id,threadId:m.threadId,sender,address,initials:sender.split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase(),subject,summary:m.snippet,body,time:new Date(Number(m.internalDate)).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}),category:noise?'noise':'personal',priority:priority?'high':'normal',needsReply:false,unread:m.labelIds.includes('UNREAD'),color:['purple','blue','rose','green'][sender.length%4],label:noise?'Newsletter':priority?'Important':'Mail',messageId:header('Message-ID'),unsubscribe,oneClick:header('List-Unsubscribe-Post').toLowerCase().includes('list-unsubscribe=one-click')};
}
export function safeUnsubscribe(url:string,e:Runtime) {
  let target:URL; try{target=new URL(url);}catch{return false;}
  if(target.protocol!=='https:'||target.username||target.password||target.port && target.port!=='443')return false;
  const allowed=['list-manage.com','mailchimp.com','sendgrid.net','convertkit.com','beehiiv.com','substack.com',...(e.UNSUBSCRIBE_ALLOWED_HOSTS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)];
  return allowed.some(host=>target.hostname===host||target.hostname.endsWith('.'+host));
}
