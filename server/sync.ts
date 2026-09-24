import { accessToken, connection, emailFrom, gmail, safeUnsubscribe } from './gmail';
import { normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { classifyMessages } from './classify';
import { applyOverride, contentFingerprint, loadOverrides } from './overrides';
import { deterministicClassify } from '@/lib/deterministic';
import { analysisVersion, summarize } from './ai';
import { HttpError, type Runtime } from './runtime';
import type { Email } from '@/lib/mail';

/**
 * Gmail synchronization pipeline:
 * acquire a per-account lease, fetch and normalize the current inbox window, reuse
 * still-valid classifications, classify changed messages, apply user overrides, and
 * publish the finished snapshot only if this refresh still owns the lease.
 */

/** Cached messages carry the fingerprint and classifier version their result came from. */
export type StoredEmail=Email&{fingerprint?:string;analysisVersion?:string};
export type Snapshot={emails:StoredEmail[];ai:boolean;pending:number;skipped:number;analysisVersion:string;updated:number;limit:number;hasMore:boolean};
export async function summarizeInbox(emails:Email[],e:Runtime){
  try{return await summarize(emails,e);}
  catch{
    console.error('Gemini inbox analysis failed; storing the inbox without AI enrichment.');
    return {emails,ai:false};
  }
}
export async function syncInbox(user:string,e:Runtime) {
  const now=Date.now();
  const leaseUntil=now+600000;
  // The token returned by this atomic update identifies both the connection and the
  // refresh that acquired the lease. Concurrent refreshes stop here with a conflict.
  const lock=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE user_id = ? AND sync_lock < ? RETURNING token').bind(leaseUntil,user,now).first<{token:string}>();
  if(!lock)throw new HttpError(409,'Your inbox is already being refreshed.');
  try{
    const token=await accessToken(user,e);
    const account=(await connection(user,e)).email;
    // This snapshot intentionally covers the first 60 Inbox messages. `hasMore` tells
    // the interface that Gmail returned another page which this sync has not loaded.
    const list=await gmail<{messages?:{id:string}[];nextPageToken?:string}>('messages?labelIds=INBOX&maxResults=60',token);
    // The previous snapshot is a classification cache as well as the last visible inbox.
    const previous=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    const old=previous?JSON.parse(previous.data) as Snapshot:null;
    const currentAnalysisVersion=analysisVersion(e);
    const cached=new Map((old?.emails||[]).map(m=>[m.id,m]));
    const normalized:NormalizedMessage[]=[];
    const refs=list.messages||[];
    let skipped=0;
    // Keep Gmail requests in small parallel groups so a refresh is fast without sending
    // an unbounded burst of full-message requests.
    for(let i=0;i<refs.length;i+=6){
      const batch=await Promise.allSettled(refs.slice(i,i+6).map(async ({id})=>
        normalizeMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',token))));
      for(const result of batch){
        if(result.status==='fulfilled')normalized.push(result.value);
        else skipped++;
      }
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
    // Only new or changed content crosses the model boundary.
    const {results,failures}=await classifyMessages(fresh,account,e);
    const removed=await e.DB.prepare('SELECT address FROM unsubscribed WHERE user_id = ?').bind(user).all<{address:string}>();
    const muted=new Set(removed.results.map(r=>r.address));
    let pending=0;
    const emails:StoredEmail[]=[];
    for(const message of normalized){
      try{
        const stored=reusable(message);
        // Precedence: a fresh validated result, then a still-valid stored result, then the
        // deterministic fallback. A failure never replaces an earlier valid classification.
        let classification=results.get(message.id)||stored;
        if(!classification){
          // The deterministic classifier keeps the inbox usable during model failures;
          // failed model results stay visible as review items instead of disappearing.
          classification={...deterministicClassify(message,account),processingStatus:failures.has(message.id)?'needs_review':'classified',
            uncertainty:failures.get(message.id)||undefined};
        }
        // Manual message corrections and sender rules are applied after automatic
        // classification so the user's explicit choices remain authoritative.
        const email=emailFrom(message,applyOverride(classification,overrides.get(message.id)));
        if(muted.has(email.address))continue;
        emails.push({...email,
          fingerprint:contentFingerprint(message),
          analysisVersion:results.has(message.id)?currentAnalysisVersion:stored?cached.get(message.id)!.analysisVersion:'',
          oneClick:!!(email.oneClick&&email.unsubscribe&&safeUnsubscribe(email.unsubscribe,e))});
        if(failures.has(message.id))pending++;
      }catch{
        // A corrupt cached classification or override affects only its own message.
        skipped++;
      }
    }
    const snapshot:Snapshot={emails,ai:pending===0&&!!e.GEMINI_API_KEY,pending,skipped,analysisVersion:currentAnalysisVersion,updated:Date.now(),limit:60,hasMore:!!list.nextPageToken};
    // Both the lease and the encrypted credential identify this refresh's owner.
    // A reconnect changes the credential even if it renews the same mailbox.
    const writes=await e.DB.batch([
      e.DB.prepare('INSERT INTO snapshots (user_id, data, updated) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND token = ? AND sync_lock = ? AND sync_lock > ?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated=excluded.updated').bind(user,JSON.stringify(snapshot),snapshot.updated,user,lock.token,leaseUntil,snapshot.updated),
      e.DB.prepare('UPDATE connections SET last_sync = ?, sync_lock = 0, error = NULL WHERE user_id = ? AND token = ? AND sync_lock = ? AND sync_lock > ?').bind(snapshot.updated,user,lock.token,leaseUntil,snapshot.updated),
    ]);
    if(!writes[0].meta.changes)throw new HttpError(409,'Your Gmail connection or refresh changed. Please refresh your inbox again.');
    return snapshot;
  }catch(error){
    await e.DB.prepare('UPDATE connections SET sync_lock = 0, error = ? WHERE user_id = ? AND token = ? AND sync_lock = ?').bind(error instanceof HttpError?error.message:'Inbox refresh failed. Please try again.',user,lock.token,leaseUntil).run();
    throw error;
  }
}
export async function runAgent(e:Runtime) {
  const now=Date.now();
  // Record scheduler health before processing accounts, then cap each run so one cron
  // invocation cannot grow without bound as the number of connections increases.
  await e.DB.prepare('INSERT INTO agent_status (id, last_run) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run').bind('scheduler',now).run();
  const accounts=await e.DB.prepare('SELECT user_id FROM connections WHERE (last_sync IS NULL OR last_sync <= ?) AND sync_lock < ? ORDER BY COALESCE(last_sync, 0) LIMIT 20').bind(now-29*60000,now).all<{user_id:string}>();
  for(const account of accounts.results){
    try{await syncInbox(account.user_id,e);}catch{console.error('Scheduled inbox refresh failed; account status was updated.');}
  }
  await e.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now).run();
}
