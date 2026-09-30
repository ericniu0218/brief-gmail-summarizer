import { accessToken, emailFrom, getOwnedConnection, gmail } from './gmail';
import { describeUnsubscribe } from './unsubscribe';
import { hydrateDeferredBodies, normalizeMessage, type GmailMessage, type NormalizedMessage } from './message';
import { classifyMessages, recheckModelResult } from './classify';
import { activeJunkPreference, applyOverride, automaticBaseline, contentFingerprint, loadOverrides, loadSenderRules, manualCorrectionView, senderRuleFor, withSenderRule } from './overrides';
import { parseSnapshot } from './snapshots';
import { loadMessageMap, loadMessages, parseStoredEmail, snapshotSentIds } from './messages';
import { deterministicClassify } from '@/lib/deterministic';
import { POLICY_VERSION, type Classification } from '@/lib/classification';
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
export type StoredEmail=Email&{
  fingerprint?:string;
  analysisVersion?:string;
  /** Untouched classifier output. Displayed fields are always derived from this value. */
  automaticClassification?:Email['classification'];
  classificationSource?:'ai'|'deterministic';
  classificationPending?:boolean;
  classifiedAt?:number;
  /** Full-mailbox scan that most recently observed this Gmail message. */
  syncGeneration?:string;
  /** Reply send receipt from mailbox_messages, independent of a task correction. */
  replied?:boolean;
};
/**
 * The content and classification rules a completed full scan has applied to every stored
 * message. An incremental refresh only revisits the last two days, so raising this is how a
 * rule change reaches older mail: each account runs one full scan, page by page through the
 * existing cursor, and records this value only when that scan reaches its last page.
 *
 * 1: structured content (quoted history, signatures, calendar invitations).
 * 2: promotional-purpose checks (sales calls to action are never required tasks).
 * 3: contextual purpose checks and local rule upgrades.
 * 4: audit fixes — calendar-file dates, month-end and year rollover, every task per kind,
 *    sentence-scoped optional wording and meeting state, earned-record protection.
 */
export const CONTENT_VERSION=4;

/** Whether a stored result came from the model. Older records carry only its version. */
function fromModel(hit:Pick<StoredEmail,'classificationSource'|'analysisVersion'>|undefined){
  return !!hit&&(hit.classificationSource==='ai'||(!hit.classificationSource&&/^gemini:/.test(hit.analysisVersion||'')));
}

export type Snapshot={emails:StoredEmail[];ai:boolean;pending:number;skipped:number;analysisVersion:string;updated:number;limit:number;hasMore:boolean};
export async function summarizeInbox(emails:Email[],e:Runtime){
  try{return await summarize(emails,e);}
  catch{
    console.error('Gemini inbox analysis failed; storing the inbox without AI enrichment.');
    return {emails,ai:false};
  }
}
/**
 * Refresh one connected mailbox. The caller names an account the user owns, and every
 * read, write and cleanup below is scoped to it, so one mailbox can never publish over
 * another's snapshot or clear another's records.
 */
export async function syncInbox(user:string,accountId:string,e:Runtime) {
  const owned=await getOwnedConnection(user,accountId,e);
  const now=Date.now();
  let leaseUntil=now+600000;
  // The token returned by this atomic update identifies both the connection and the
  // refresh that acquired the lease. Concurrent refreshes stop here with a conflict.
  // The lease is per account row, so refreshing one mailbox never blocks another.
  const lock=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE id = ? AND user_id = ? AND sync_lock < ? RETURNING token, sync_page_token, sync_generation, sync_skipped, sync_full_scan, backfill_complete, last_full_scan, content_version, recovery_needed')
    .bind(leaseUntil,accountId,user,now).first<{token:string;sync_page_token:string|null;sync_generation:string|null;sync_skipped:number;sync_full_scan:number;backfill_complete:number;last_full_scan:number|null;content_version:number;recovery_needed:number}>();
  if(!lock)throw new HttpError(409,'This inbox is already being refreshed.');
  // Long backfills renew their lease at each expensive boundary. The exact previous
  // expiry and credential must still match, so a stale or reconnected worker cannot
  // reclaim ownership after another refresh has taken over.
  const renewLease=async()=>{
    const checkedAt=Date.now();
    const next=checkedAt+600000;
    const renewed=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE id = ? AND user_id = ? AND token = ? AND sync_lock = ? AND sync_lock > ?')
      .bind(next,accountId,user,lock.token,leaseUntil,checkedAt).run();
    if(!renewed.meta.changes)throw new HttpError(409,'This Gmail refresh expired or the connection changed. Please refresh the inbox again.');
    leaseUntil=next;
  };
  try{
    const token=await accessToken(user,accountId,e);
    const account=owned.email;
    // Scan received mail in bounded pages. The cursor is stored on the account so a large
    // mailbox progresses across scheduled runs without exceeding a worker time limit.
    const pageToken=lock.sync_page_token;
    const generation=lock.sync_generation||`${now.toString(36)}-${crypto.randomUUID()}`;
    // After the first complete backfill, ordinary refreshes scan only a two-day overlap.
    // A monthly full reconciliation removes messages deleted outside the application.
    // An account whose mail an earlier version deleted is reconciled against Gmail. The
    // request only widens the *next* scan to start: a scan already in progress keeps its
    // saved cursor, because restarting it would lose its position and the partial results
    // already written. Nothing is cleared up front, so the visible inbox is never emptied
    // while the scan runs; messages still in Gmail are simply written back as it passes.
    // A count of outstanding requests, not a flag: one added while this scan runs must
    // survive this scan's completion, which clears only the requests it saw at the start.
    const recovering=lock.recovery_needed>0;
    // Guards left by an older instance's unsubscribe only need to outlast that instance's
    // own follow-up delete, which runs immediately. The recovery the same insert scheduled
    // restores anything that got through.
    await e.DB.prepare('DELETE FROM legacy_unsubscribe_guards WHERE account_id=? AND user_id=?').bind(accountId,user).run();
    const fullScan=pageToken?lock.sync_full_scan!==0:recovering||lock.content_version<CONTENT_VERSION||!lock.backfill_complete||!lock.last_full_scan||now-lock.last_full_scan>=30*86400000;
    const query=encodeURIComponent(`${fullScan?'':'newer_than:2d '}-in:sent -in:trash -in:spam -in:drafts`);
    let list:{messages?:{id:string}[];nextPageToken?:string};
    try{list=await gmail(`messages?maxResults=100&q=${query}${pageToken?`&pageToken=${encodeURIComponent(pageToken)}`:''}`,token);}
    catch(error){
      // Gmail continuation tokens can expire. Clear only an invalid continuation so the
      // next run starts a fresh generation while the last complete rows stay visible.
      if(pageToken&&error instanceof HttpError&&error.status===400)
        await e.DB.prepare('UPDATE connections SET sync_page_token=NULL,sync_generation=NULL,sync_skipped=0 WHERE id=? AND user_id=? AND token=? AND sync_lock=?')
          .bind(accountId,user,lock.token,leaseUntil).run();
      throw error;
    }
    await renewLease();
    // The previous snapshot is a classification cache as well as the last visible inbox.
    const previous=await e.DB.prepare('SELECT data, revision FROM snapshots WHERE account_id = ? AND user_id = ?').bind(accountId,user).first<{data:string;revision:number}>();
    const old=previous?parseSnapshot(previous.data):undefined;
    const currentAnalysisVersion=analysisVersion(e);
    // Import a legacy snapshot once. Subsequent reads and writes use bounded message rows.
    const sentInSnapshot=snapshotSentIds(previous?.data);
    const legacy=(old?.emails||[]).map(email=>email&&typeof email==='object'?parseStoredEmail(JSON.stringify(email)):undefined).filter((email):email is StoredEmail=>!!email);
    const existingCount=await e.DB.prepare('SELECT COUNT(*) count FROM mailbox_messages WHERE account_id=? AND user_id=?').bind(accountId,user).first<{count:number}>();
    if(!existingCount?.count&&legacy.length)for(let i=0;i<legacy.length;i+=50){
      // The replied column is filled from the record, so a send made before the column
      // existed survives the next sync rewriting this row.
      await e.DB.batch(legacy.slice(i,i+50).map(email=>e.DB.prepare('INSERT OR IGNORE INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,?,?,?)')
        .bind(user,accountId,email.id,JSON.stringify(email),email.receivedAt||0,email.syncGeneration||'legacy',email.replied||sentInSnapshot.has(email.id)?1:0)));
    }
    const normalized:NormalizedMessage[]=[];
    const refs=list.messages||[];
    const cached=await loadMessageMap(user,accountId,refs.map(ref=>ref.id),e);
    const unreadableIds=new Set<string>();
    let skipped=0;
    // Keep Gmail requests in small parallel groups so a refresh is fast without sending
    // an unbounded burst of full-message requests.
    for(let i=0;i<refs.length;i+=6){
      await renewLease();
      const chunk=refs.slice(i,i+6);
      const batch=await Promise.allSettled(chunk.map(async ({id})=>{
        const raw=await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',token);
        await hydrateDeferredBodies(raw,attachmentId=>gmail(`messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,token));
        return normalizeMessage(raw);
      }));
      for(const [index,result] of batch.entries()){
        if(result.status==='fulfilled')normalized.push(result.value);
        else{skipped++;unreadableIds.add(chunk[index].id);}
      }
    }
    const overrides=await loadOverrides(user,accountId,e,normalized.map(message=>message.id));
    const senderRules=await loadSenderRules(user,accountId,e);
    // Reuse a stored classification only when the content and the rules that produced it
    // both still match. Reading or refreshing never triggers reclassification.
    //
    // A model result and a rule-based one are kept apart, because they mean different
    // things. A model result under older rules keeps the model's facts and has only the
    // current purpose checks applied, so a rule change never bills the whole mailbox and
    // never throws away a task only the model recognised. A rule-based result is a stand-in
    // whenever a model is configured — the model failed, or was not configured when the
    // message arrived — so it goes back to the model rather than being relabelled as if the
    // model had produced it.
    const aiConfigured=!!e.GEMINI_API_KEY;
    const localVersion=`${POLICY_VERSION}:deterministic`;
    const rechecked=new Map<string,Classification>();
    const reusable=(message:NormalizedMessage)=>{
      if(rechecked.has(message.id))return rechecked.get(message.id);
      const hit=cached.get(message.id);
      const automatic=automaticBaseline(hit?.automaticClassification)??automaticBaseline(hit?.classification);
      if(!hit||!automatic||automatic.processingStatus==='failed')return undefined;
      const current=hit.fingerprint===contentFingerprint(message);
      // A fingerprint written before campaign evidence was part of it still identifies the
      // same content; only the checks that read that evidence need to run again.
      if(!current&&hit.fingerprint!==contentFingerprint(message,true))return undefined;
      if(fromModel(hit)){
        if(current&&automatic.version===POLICY_VERSION)return automatic;
        const updated=recheckModelResult(automatic,message,account);
        rechecked.set(message.id,updated);
        return updated;
      }
      if(aiConfigured)return undefined;
      if(current&&automatic.version===localVersion)return automatic;
      const updated=deterministicClassify(message,account);
      rechecked.set(message.id,updated);
      return updated;
    };
    const fresh=normalized.filter(message=>!reusable(message));
    // Only new or changed content crosses the model boundary.
    await renewLease();
    const {results,failures}=await classifyMessages(fresh,account,e);
    await renewLease();
    let pending=0;
    const pageEmails:StoredEmail[]=[];
    for(const message of normalized){
      try{
        const stored=reusable(message);
        // Precedence: a fresh validated result, then a still-valid stored result, then the
        // deterministic fallback. A failure never replaces an earlier valid classification.
        let classification=results.get(message.id)||stored;
        if(!classification){
          // The deterministic classifier keeps the inbox usable during model failures;
          // failed model results stay visible as review items instead of disappearing.
          const local=deterministicClassify(message,account);
          // A model failure is the more urgent thing to say; otherwise keep the classifier's
          // own note, such as incomplete content or only being copied.
          classification={...local,processingStatus:failures.has(message.id)?'needs_review':local.processingStatus,
            uncertainty:failures.get(message.id)||local.uncertainty};
        }
        // The snapshot retains `classification` as the effective display value for old
        // clients, but `automaticClassification` is the clean cache used by every future
        // sync, mailbox read and reset. Manual intent can never contaminate that cache.
        const manual=overrides.get(message.id),senderRule=senderRuleFor(senderRules,message.from.address);
        const effective=withSenderRule(manual,senderRule,message.id);
        const email=emailFrom(message,applyOverride(classification,effective));
        const plan=describeUnsubscribe(message,e);
        // Each stored message remembers its source mailbox so the combined view can
        // attribute it and every action can target the right account.
        pageEmails.push({...email,accountId,accountEmail:account,automaticClassification:classification,
          correctionRevision:manual?.revision??0,manuallyCorrected:manual?.active!==false&&!!manual,
          manualCorrection:manualCorrectionView(manual),
          senderJunkPreference:activeJunkPreference(senderRule),senderRuleRevision:senderRule?.revision??0,
          automaticClassificationAvailable:true,
          fingerprint:contentFingerprint(message),
          // Only a model call made now earns the current model version. A result checked
          // again under new rules keeps the version of the model that actually produced it.
          analysisVersion:results.has(message.id)?currentAnalysisVersion:stored?cached.get(message.id)!.analysisVersion||'':'',
          classificationSource:results.has(message.id)||(stored&&fromModel(cached.get(message.id)))?'ai':'deterministic',
          classificationPending:failures.has(message.id),
          classifiedAt:results.has(message.id)||!stored?Date.now():cached.get(message.id)?.classifiedAt,
          syncGeneration:generation,
          // Both come from one call, so the flag the older interface reads and the richer
          // capability can never disagree about the same message.
          oneClick:plan.capability==='one-click',unsubscribeCapability:plan.capability,
          listId:plan.identity.listId});
        if(failures.has(message.id))pending++;
      }catch{
        // A corrupt cached classification or override affects only its own message.
        skipped++;unreadableIds.add(message.id);
      }
    }
    // Keep earlier pages while a scan is in progress. On its final page, retain only
    // messages observed in this generation; this safely removes deleted or newly sent
    // mail without blanking the inbox during a partial scan.
    // Preserve the last readable copy of a malformed message and mark it seen in this scan.
    for(const id of unreadableIds)if(cached.has(id))pageEmails.push({...cached.get(id)!,syncGeneration:generation});
    for(let i=0;i<pageEmails.length;i+=50){
      await renewLease();
      await e.DB.batch(pageEmails.slice(i,i+50).map(email=>
      // Every message Gmail returns is stored. Asking a newsletter to stop sending says
      // nothing about what this mailbox should show: the sender still controls delivery, and
      // its receipts and account notices must keep arriving normally. Preserve a successful
      // reply recorded concurrently.
      e.DB.prepare("INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,?,?,0) ON CONFLICT(account_id,message_id) DO UPDATE SET data=CASE WHEN mailbox_messages.replied=1 THEN json_set(excluded.data,'$.needsReply',json('false')) ELSE excluded.data END,received_at=excluded.received_at,scan_generation=excluded.scan_generation")
        .bind(user,accountId,email.id,JSON.stringify(email),email.receivedAt||0,generation)));
    }
    await renewLease();
    if(fullScan&&!list.nextPageToken){
      await e.DB.prepare('DELETE FROM mailbox_messages WHERE account_id=? AND user_id=? AND scan_generation<>?').bind(accountId,user,generation).run();
      // Once Gmail confirms a message is absent, its correction can no longer be reached
      // by the correction API, so retaining that override would only create unbounded rows.
      await e.DB.prepare('DELETE FROM overrides WHERE account_id=? AND user_id=? AND NOT EXISTS (SELECT 1 FROM mailbox_messages WHERE mailbox_messages.account_id=overrides.account_id AND mailbox_messages.message_id=overrides.message_id)')
        .bind(accountId,user).run();
    }
    const totals=await e.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN json_extract(data,'$.classificationPending')=1 THEN 1 ELSE 0 END) pending FROM mailbox_messages WHERE account_id=? AND user_id=?")
      .bind(accountId,user).first<{total:number;pending:number|null}>();
    pending=totals?.pending||0;
    const totalSkipped=(pageToken?lock.sync_skipped:0)+skipped;
    // Keep only this bounded page in the legacy snapshot for rolling compatibility. The
    // complete mailbox lives in `mailbox_messages` and is never serialized as one blob.
    const snapshot:Snapshot={emails:pageEmails,ai:pending===0&&!!e.GEMINI_API_KEY,pending,skipped:totalSkipped,analysisVersion:currentAnalysisVersion,updated:Date.now(),limit:totals?.total||0,hasMore:!!list.nextPageToken};
    await renewLease();
    // Both the lease and the encrypted credential identify this refresh's owner.
    // A reconnect changes the credential even if it renews the same mailbox.
    const writes=await e.DB.batch([
      // EXISTS re-checks that this refresh still owns the lease and that the credential
      // has not changed. A disconnected account has no row, so a late refresh cannot
      // recreate it; a reconnect rewrites the token, so a stale refresh cannot publish.
      previous
        ?e.DB.prepare('UPDATE snapshots SET data=?, updated=?, revision=revision+1 WHERE account_id=? AND user_id=? AND revision=? AND EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=? AND token=? AND sync_lock=? AND sync_lock>?)').bind(JSON.stringify(snapshot),snapshot.updated,accountId,user,previous.revision,accountId,user,lock.token,leaseUntil,snapshot.updated)
        :e.DB.prepare('INSERT INTO snapshots (account_id,user_id,data,updated,revision) SELECT ?,?,?,?,0 WHERE EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=? AND token=? AND sync_lock=? AND sync_lock>?) ON CONFLICT(account_id) DO NOTHING').bind(accountId,user,JSON.stringify(snapshot),snapshot.updated,accountId,user,lock.token,leaseUntil,snapshot.updated),
      e.DB.prepare('UPDATE connections SET last_sync=?,sync_lock=0,error=NULL,sync_page_token=?,sync_generation=?,sync_skipped=?,sync_full_scan=?,backfill_complete=?,last_full_scan=?,content_version=?,recovery_needed=MAX(recovery_needed-?,0) WHERE id=? AND user_id=? AND token=? AND sync_lock=? AND sync_lock>?')
        .bind(snapshot.updated,list.nextPageToken||null,list.nextPageToken?generation:null,list.nextPageToken?totalSkipped:0,fullScan?1:0,
          fullScan&&!list.nextPageToken?1:lock.backfill_complete,fullScan&&!list.nextPageToken?snapshot.updated:lock.last_full_scan,
          fullScan&&!list.nextPageToken?CONTENT_VERSION:lock.content_version,
          // Cleared only by a full scan that reached its last page, and only by the number
          // of requests it saw at the start. This write already requires the lease and the
          // credential to be unchanged, so an interrupted or superseded recovery leaves the
          // count and the next refresh resumes it.
          recovering&&fullScan&&!list.nextPageToken?lock.recovery_needed:0,
          accountId,user,lock.token,leaseUntil,snapshot.updated),
    ]);
    if(!writes[0].meta.changes)throw new HttpError(409,'This Gmail connection or refresh changed. Please refresh the inbox again.');
    return {...snapshot,emails:await loadMessages(user,accountId,e)};
  }catch(error){
    // An account-level failure records its error on that account alone and leaves the
    // previous snapshot in place, so a failed refresh never empties a working mailbox.
    await e.DB.prepare('UPDATE connections SET sync_lock = 0, error = ? WHERE id = ? AND user_id = ? AND token = ? AND sync_lock = ?').bind(error instanceof HttpError?error.message:'Inbox refresh failed. Please try again.',accountId,user,lock.token,leaseUntil).run();
    throw error;
  }
}
export async function runAgent(e:Runtime) {
  const now=Date.now();
  // Record scheduler health before processing accounts, then cap each run so one cron
  // invocation cannot grow without bound as the number of connections increases.
  await e.DB.prepare('INSERT INTO agent_status (id, last_run) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run').bind('scheduler',now).run();
  // Accounts are selected independently of their owner, so one user's stalled mailbox
  // cannot starve another's. Ordering by last_sync gives the longest-waiting account the
  // next slot, which stops a repeatedly failing mailbox from monopolising every run.
  // Reserve half the run for backfills and half for ordinary refreshes so a group of
  // large mailboxes cannot permanently starve accounts whose scans are already complete.
  const [continuing,regular]=await Promise.all([
    e.DB.prepare('SELECT id,user_id FROM connections WHERE sync_page_token IS NOT NULL AND sync_lock<? ORDER BY COALESCE(last_sync,0) LIMIT 10').bind(now).all<{id:string;user_id:string}>(),
    e.DB.prepare('SELECT id,user_id FROM connections WHERE sync_page_token IS NULL AND (last_sync IS NULL OR last_sync<=?) AND sync_lock<? ORDER BY COALESCE(last_sync,0) LIMIT 10').bind(now-29*60000,now).all<{id:string;user_id:string}>(),
  ]);
  const accounts=[...(continuing.results||[]),...(regular.results||[])];
  // Bounded concurrency keeps a refresh round fast without issuing an unbounded burst of
  // Gmail and model requests.
  for(let i=0;i<accounts.length;i+=3){
    await Promise.all(accounts.slice(i,i+3).map(async account=>{
      // One account's failure is recorded on that account and never stops the others.
      try{await syncInbox(account.user_id,account.id,e);}
      catch{console.error('Scheduled inbox refresh failed; account status was updated.');}
    }));
  }
  await e.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now).run();
  // Reset tombstones only need to outlive stale browser tabs and in-flight requests.
}
