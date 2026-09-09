import { accessToken, gmail, parseMessage, safeUnsubscribe, type GmailMessage } from './gmail';
import { summarize } from './ai';
import { HttpError, type Runtime } from './runtime';
import type { Email } from '@/lib/mail';
export type Snapshot={emails:Email[];ai:boolean;updated:number;limit:number;hasMore:boolean};
export async function syncInbox(user:string,e:Runtime) {
  const now=Date.now();
  const lock=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE user_id = ? AND sync_lock < ?').bind(now+600000,user,now).run();
  if(!lock.meta.changes)throw new HttpError(409,'Your inbox is already being refreshed.');
  try{
    const token=await accessToken(user,e);
    const list=await gmail<{messages?:{id:string}[];nextPageToken?:string}>('messages?labelIds=INBOX&maxResults=60',token);
    const previous=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    const old=previous?JSON.parse(previous.data) as Snapshot:null;
    const cached=new Map((old?.emails||[]).map(m=>[m.id,m]));
    const messages:Email[]=[];
    const refs=list.messages||[];
    for(let i=0;i<refs.length;i+=6){
      messages.push(...await Promise.all(refs.slice(i,i+6).map(async ({id})=>parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',token)))));
    }
    const fresh=messages.filter(m=>!cached.has(m.id)||!old?.ai);
    const analysis=await summarize(fresh,e);
    const analyzed=new Map(analysis.emails.map(m=>[m.id,m]));
    const removed=await e.DB.prepare('SELECT address FROM unsubscribed WHERE user_id = ?').bind(user).all<{address:string}>();
    const muted=new Set(removed.results.map(r=>r.address));
    const emails=messages.map(m=>{
      const enriched=analyzed.get(m.id)||cached.get(m.id);
      return {...m,...(enriched?{summary:enriched.summary,category:enriched.category,priority:enriched.priority,needsReply:enriched.needsReply,label:enriched.label}:{}),oneClick:!!(m.oneClick&&m.unsubscribe&&safeUnsubscribe(m.unsubscribe,e))};
    }).filter(m=>!muted.has(m.address));
    const snapshot:Snapshot={emails,ai:analysis.ai,updated:Date.now(),limit:60,hasMore:!!list.nextPageToken};
    await e.DB.batch([
      e.DB.prepare('INSERT INTO snapshots (user_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated=excluded.updated').bind(user,JSON.stringify(snapshot),snapshot.updated),
      e.DB.prepare('UPDATE connections SET last_sync = ?, sync_lock = 0, error = NULL WHERE user_id = ?').bind(snapshot.updated,user),
    ]);
    return snapshot;
  }catch(error){
    await e.DB.prepare('UPDATE connections SET sync_lock = 0, error = ? WHERE user_id = ?').bind(error instanceof HttpError?error.message:'Inbox refresh failed. Please try again.',user).run();
    throw error;
  }
}
export async function runAgent(e:Runtime) {
  const now=Date.now();
  await e.DB.prepare('INSERT INTO agent_status (id, last_run) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run').bind('scheduler',now).run();
  const accounts=await e.DB.prepare('SELECT user_id FROM connections WHERE (last_sync IS NULL OR last_sync <= ?) AND sync_lock < ? ORDER BY COALESCE(last_sync, 0) LIMIT 20').bind(now-29*60000,now).all<{user_id:string}>();
  for(const account of accounts.results){
    try{await syncInbox(account.user_id,e);}catch{console.error('Scheduled inbox refresh failed; account status was updated.');}
  }
  await e.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now).run();
}
