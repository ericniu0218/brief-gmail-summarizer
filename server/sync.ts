import { accessToken, connection, emailFrom, gmail, safeUnsubscribe } from './gmail';
import { normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { classifyMessages } from './classify';
import { applyOverride, contentFingerprint, loadOverrides } from './overrides';
import { deterministicClassify } from '@/lib/deterministic';
import { analysisVersion, summarize } from './ai';
import { HttpError, type Runtime } from './runtime';
import type { Email } from '@/lib/mail';

/** Cached messages carry the fingerprint and classifier version their result came from. */
export type StoredEmail=Email&{fingerprint?:string;analysisVersion?:string};
export type Snapshot={emails:StoredEmail[];ai:boolean;pending:number;analysisVersion:string;updated:number;limit:number;hasMore:boolean};
export async function summarizeInbox(emails:Email[],e:Runtime){
  try{return await summarize(emails,e);}
  catch{
    console.error('Gemini inbox analysis failed; storing the inbox without AI enrichment.');
    return {emails,ai:false};
  }
}
export async function syncInbox(user:string,e:Runtime) {
  const now=Date.now();
  const lock=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE user_id = ? AND sync_lock < ?').bind(now+600000,user,now).run();
  if(!lock.meta.changes)throw new HttpError(409,'Your inbox is already being refreshed.');
  try{
    const token=await accessToken(user,e);
    const account=(await connection(user,e)).email;
    const list=await gmail<{messages?:{id:string}[];nextPageToken?:string}>('messages?labelIds=INBOX&maxResults=60',token);
    const previous=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    const old=previous?JSON.parse(previous.data) as Snapshot:null;
    const currentAnalysisVersion=analysisVersion(e);
    const cached=new Map((old?.emails||[]).map(m=>[m.id,m]));
    const normalized:NormalizedMessage[]=[];
    const refs=list.messages||[];
    for(let i=0;i<refs.length;i+=6){
      normalized.push(...await Promise.all(refs.slice(i,i+6).map(async ({id})=>normalizeMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',token)))));
    }
    const overrides=await loadOverrides(user,e);
    // Reuse a stored classification only when the content and the classifier version
    // both still match. Reading or refreshing never triggers reclassification.
    const reusable=(message:NormalizedMessage)=>{
      const hit=cached.get(message.id);
      if(!hit?.classification||hit.classification.processingStatus==='failed')return undefined;
      if(hit.fingerprint!==contentFingerprint(message))return undefined;
      return hit.analysisVersion===currentAnalysisVersion?hit.classification:undefined;
    };
    const fresh=normalized.filter(message=>!reusable(message));
    const {results,failures}=await classifyMessages(fresh,account,e);
    const removed=await e.DB.prepare('SELECT address FROM unsubscribed WHERE user_id = ?').bind(user).all<{address:string}>();
    const muted=new Set(removed.results.map(r=>r.address));
    let pending=0;
    const emails=normalized.map(message=>{
      const stored=reusable(message);
      // Precedence: a fresh validated result, then a still-valid stored result, then the
      // deterministic fallback. A failure never replaces an earlier valid classification.
      let classification=results.get(message.id)||stored;
      if(!classification){
        classification={...deterministicClassify(message,account),processingStatus:failures.has(message.id)?'needs_review':'classified',
          uncertainty:failures.get(message.id)||undefined};
        if(failures.has(message.id))pending++;
      }
      const email=emailFrom(message,applyOverride(classification,overrides.get(message.id)));
      return {...email,
        fingerprint:contentFingerprint(message),
        analysisVersion:results.has(message.id)?currentAnalysisVersion:stored?cached.get(message.id)!.analysisVersion:'',
        oneClick:!!(email.oneClick&&email.unsubscribe&&safeUnsubscribe(email.unsubscribe,e))};
    }).filter(m=>!muted.has(m.address));
    const snapshot:Snapshot={emails,ai:pending===0&&!!e.GEMINI_API_KEY,pending,analysisVersion:currentAnalysisVersion,updated:Date.now(),limit:60,hasMore:!!list.nextPageToken};
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
