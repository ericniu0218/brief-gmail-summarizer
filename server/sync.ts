import { attachSenderFamiliarity } from './sender-familiarity';
import { withSenderFamiliarity } from '@/lib/sender-familiarity';
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
import { buildDigest, type Digest } from './digest';
import { sendDueScheduled } from './scheduled';
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
  senderFamiliarityDeferred?:boolean;
  senderFamiliarityAttemptedAt?:number;
  analysisVersion?:string;
  /** Untouched classifier output. Displayed fields are always derived from this value. */
  automaticClassification?:Email['classification'];
  classificationSource?:'ai'|'deterministic';
  classificationPending?:boolean;
  modelAttempts?:number;
  modelRetryAt?:number;
  modelRetryVersion?:string;
  /** Last metadata-only check for a sent reply in this Gmail conversation. */
  replyCheckedAt?:number;
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
 * 5: reply assessment — whether an email answer is owed, request by request, with its
 *    channel, condition, urgency and evidence (lib/reply).
 * 6: preserve the sender's signature for complete forwards.
 * 7: recognize requests to redirect a payment to changed bank details.
 * 8: keep Gmail's own tab, Important marker and star (lib/gmail-signals), and use them as
 *    evidence in the rules, the model request and the importance ranking.
 * 9: prior sent-mail evidence for existing correspondents.
 * 10: attachment presence and full-recipient membership, including older mail.
 */
/** Another refresh of this mailbox is still running; it will bring the mail in, so this one stands down. */
export class RefreshBusy extends HttpError{constructor(){super(409,'This inbox is already being refreshed.');}}

export const CONTENT_VERSION=10;
/** More rule-based stand-ins than this, after a model or prompt change, justify one full listing. */
const MODEL_PASS_MIN_FALLBACK=48;
/** How many of Gmail's newest inbox ids each refresh checks the Inbox view against. */
const INBOX_MIRROR=500;
/** How much of the newest mail a scan part-way through the mailbox checks for first. */
const RECENT_FIRST=50;

/** Whether a stored result came from the model. Older records carry only its version. */
function fromModel(hit:Pick<StoredEmail,'classificationSource'|'analysisVersion'>|undefined){
  return !!hit&&(hit.classificationSource==='ai'||(!hit.classificationSource&&(hit.analysisVersion||'').startsWith('gemini:')));
}

/**
 * The legacy snapshot's copy of a page. One D1 value is capped at about 2 MB, and a page of
 * 100 newsletters is often larger, so the copy leaves out the message text and HTML that
 * `mailbox_messages` already holds. If even that is too large, older readers fall back to
 * the per-message rows, which every current reader prefers anyway.
 */
const SNAPSHOT_PAGE_BYTES=1_000_000;
function snapshotPage(emails:StoredEmail[]):StoredEmail[]{
  const slim=emails.map(email=>{
    const copy:StoredEmail={...email,body:''};
    delete copy.html;delete copy.quoted;delete copy.signature;
    return copy;
  });
  return new TextEncoder().encode(JSON.stringify(slim)).byteLength<=SNAPSHOT_PAGE_BYTES?slim:[];
}

export type Snapshot={emails:StoredEmail[];ai:boolean;pending:number;skipped:number;analysisVersion:string;updated:number;limit:number;hasMore:boolean;
  /** AI-written wording for the daily digest's items. Ranking is recomputed on every read. */
  digest?:Digest;
  inboxMirror?:{pageToken:string;generation:string;started:number};
  /** Messages Gmail was too busy to hand over, fetched again by ID on the next refresh. */
  fetchRetry?:{id:string;attempts:number}[]};
/** Tries at a message Gmail keeps refusing as busy, before it is counted as unreadable. */
const MAX_FETCH_ATTEMPTS=5;
/** Most retried messages fetched in one refresh, and most remembered. */
const FETCH_RETRY_BATCH=50;
const FETCH_RETRY_KEPT=1000;
/** A Gmail read that failed for a reason that may pass: busy, a server error, or a timeout. */
class FetchFailure extends Error{
  readonly transient:boolean;
  constructor(cause:unknown){
    super('Gmail read failed');
    this.transient=cause instanceof HttpError?cause.status===429||cause.status>=500:true;
  }
}
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
  const lock=await e.DB.prepare('UPDATE connections SET sync_lock = ? WHERE id = ? AND user_id = ? AND sync_lock < ? RETURNING token, sync_page_token, sync_generation, sync_skipped, sync_full_scan, backfill_complete, last_full_scan, content_version, model_backfill_version, recovery_needed')
    .bind(leaseUntil,accountId,user,now).first<{token:string;sync_page_token:string|null;sync_generation:string|null;sync_skipped:number;sync_full_scan:number;backfill_complete:number;last_full_scan:number|null;content_version:number;model_backfill_version:string|null;recovery_needed:number}>();
  if(!lock)throw new RefreshBusy();
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
    // Fallback backfills may need a full pass. Failed older messages are retried below
    // by ID in small batches, without listing the entire mailbox again.
    const modelVersion=e.GEMINI_API_KEY?analysisVersion(e):null;
    // A new model or prompt version only needs the full listing when many messages still
    // carry rule-based stand-ins; a few are retried by ID on ordinary refreshes below. Mail
    // already classified by an older model rotates through the bounded retry queue below.
    const modelChanged=!pageToken&&!!modelVersion&&lock.model_backfill_version!==modelVersion;
    const fallbackCount=modelChanged?(await e.DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM mailbox_messages
      WHERE account_id=? AND user_id=? AND COALESCE(json_extract(data,'$.classificationSource'),'deterministic')='deterministic' LIMIT ?)`)
      .bind(accountId,user,MODEL_PASS_MIN_FALLBACK+1).first<{n:number}>())?.n||0:0;
    const modelPass=modelChanged&&fallbackCount>MODEL_PASS_MIN_FALLBACK;
    const fullScan=pageToken?lock.sync_full_scan!==0:modelPass||recovering||lock.content_version<CONTENT_VERSION||!lock.backfill_complete||!lock.last_full_scan||now-lock.last_full_scan>=30*86400000;
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
    const page=list.messages||[];
    // A scan part-way through the mailbox lists older pages, so mail that arrived since it
    // began would wait for the last page. Each continuing page therefore also lists the
    // newest mail and fetches anything not yet stored, ahead of the older page. Stored mail
    // is not fetched again here, and a failed listing only delays new mail to the next page.
    let arrived:{id:string}[]=[];
    if(pageToken){
      try{
        const newest=await gmail<{messages?:{id:string}[]}>(`messages?maxResults=${RECENT_FIRST}&q=${encodeURIComponent('newer_than:2d -in:sent -in:trash -in:spam -in:drafts')}`,token);
        const onPage=new Set(page.map(ref=>ref.id));
        const ids=(newest.messages||[]).map(ref=>ref.id).filter(id=>!onPage.has(id));
        const known=ids.length?await loadMessageMap(user,accountId,ids,e):new Map();
        arrived=ids.filter(id=>!known.has(id)).map(id=>({id}));
      }catch{console.error('Listing new mail failed; it will be fetched on the next refresh.');}
    }
    const listed=[...arrived,...page];
    // The two-day Gmail query cannot see older mail whose model call failed during a
    // backfill. Retry a bounded number of due fallback rows by ID on each incremental
    // refresh. Backoff on each row prevents a permanently bad message from consuming an
    // unbounded number of model calls or forcing another full mailbox listing.
    const retryRows=!fullScan&&modelVersion?await e.DB.prepare(`SELECT message_id FROM mailbox_messages
      WHERE account_id=? AND user_id=? AND COALESCE(json_extract(data,'$.classificationSource'),'deterministic')='deterministic'
      AND COALESCE(json_extract(data,'$.modelRetryAt'),0)<=?
      AND message_id NOT IN (SELECT value FROM json_each(?))
      ORDER BY COALESCE(json_extract(data,'$.modelRetryAt'),0),received_at DESC LIMIT 12`)
      .bind(accountId,user,now,JSON.stringify(listed.map(ref=>ref.id))).all<{message_id:string}>():undefined;
    // Refresh stale AI answers gradually, preserving the old answer if this attempt fails.
    const modelRefreshRows=modelVersion?await e.DB.prepare(`SELECT message_id FROM mailbox_messages
      WHERE account_id=? AND user_id=?
      AND (json_extract(data,'$.classificationSource')='ai' OR json_extract(data,'$.analysisVersion') LIKE 'gemini:%')
      AND COALESCE(json_extract(data,'$.analysisVersion'),'')<>?
      AND (COALESCE(json_extract(data,'$.modelRetryVersion'),'')<>? OR COALESCE(json_extract(data,'$.modelRetryAt'),0)<=?)
      ORDER BY COALESCE(json_extract(data,'$.classifiedAt'),0),received_at DESC,message_id LIMIT 8`)
      .bind(accountId,user,currentAnalysisVersion,currentAnalysisVersion,now).all<{message_id:string}>():undefined;
    const modelRefreshIds=new Set((modelRefreshRows?.results||[]).map(row=>row.message_id));
    // Deferred sender evidence rotates ahead of new senders and never forces a full listing.
    const senderRows=await e.DB.prepare(`SELECT MIN(message_id) AS message_id FROM mailbox_messages
      WHERE account_id=? AND user_id=? AND json_extract(data,'$.senderFamiliarityDeferred')=1
      AND COALESCE(json_extract(data,'$.senderFamiliarityAttemptedAt'),0)<=?
      GROUP BY lower(json_extract(data,'$.address'))
      ORDER BY MIN(COALESCE(json_extract(data,'$.senderFamiliarityAttemptedAt'),0)),MIN(received_at) LIMIT 10`)
      .bind(accountId,user,now-30*60000).all<{message_id:string}>();
    const senderIds=(senderRows.results||[]).map(row=>row.message_id);
    const retryIds=new Set((retryRows?.results||[]).map(row=>row.message_id));
    // Messages Gmail was too busy to hand over last time. Waiting for the next monthly full
    // listing would leave them missing for weeks, so they are asked for again by ID.
    const fetchRetries=new Map<string,number>((Array.isArray(old?.fetchRetry)?old.fetchRetry:[])
      .filter(entry=>entry&&typeof entry.id==='string'&&/^[a-zA-Z0-9_-]{1,150}$/.test(entry.id)&&Number.isInteger(entry.attempts))
      .map(entry=>[entry.id,entry.attempts]));
    const queued=new Set([...listed.map(ref=>ref.id),...retryIds,...modelRefreshIds,...senderIds]);
    const fetchAgain=[...fetchRetries.keys()].filter(id=>!queued.has(id)).slice(0,FETCH_RETRY_BATCH);
    const refs=[...new Set([...senderIds,...listed.map(ref=>ref.id),...retryIds,...modelRefreshIds,...fetchAgain])].map(id=>({id}));
    // Retries not reached this time stay queued; each one this refresh asks for is decided below.
    const nextFetchRetry=new Map([...fetchRetries].filter(([id])=>!refs.some(ref=>ref.id===id)));
    const busyIds=new Set<string>();
    const cached=await loadMessageMap(user,accountId,refs.map(ref=>ref.id),e);
    const unreadableIds=new Set<string>();
    const missingRetryIds=new Set<string>();
    let skipped=0;
    // Keep Gmail requests in small parallel groups so a refresh is fast without sending
    // an unbounded burst of full-message requests.
    for(let i=0;i<refs.length;i+=6){
      await renewLease();
      const chunk=refs.slice(i,i+6);
      const batch=await Promise.allSettled(chunk.map(async ({id})=>{
        let raw:GmailMessage;
        try{
          raw=await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',token);
          await hydrateDeferredBodies(raw,attachmentId=>gmail(`messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,token));
        }catch(error){
          // A message deleted since it was listed is simply gone, not a failure to retry.
          if(error instanceof HttpError&&error.status===404)throw error;
          throw new FetchFailure(error);
        }
        return normalizeMessage(raw);
      }));
      for(const [index,result] of batch.entries()){
        const id=chunk[index].id;
        if(result.status==='fulfilled')normalized.push(result.value);
        else if((retryIds.has(id)||modelRefreshIds.has(id)||senderIds.includes(id))&&result.reason instanceof HttpError&&result.reason.status===404)
          missingRetryIds.add(id);
        else if(fetchRetries.has(id)&&result.reason instanceof HttpError&&result.reason.status===404){/* Deleted in Gmail. */}
        else if(result.reason instanceof FetchFailure&&result.reason.transient&&(fetchRetries.get(id)||0)+1<MAX_FETCH_ATTEMPTS){
          // Not counted as unreadable: it is asked for again on the next refresh.
          nextFetchRetry.set(id,(fetchRetries.get(id)||0)+1);busyIds.add(id);
        }
        else{skipped++;unreadableIds.add(id);}
      }
    }
    for(const id of missingRetryIds)
      await e.DB.prepare('DELETE FROM mailbox_messages WHERE account_id=? AND user_id=? AND message_id=?').bind(accountId,user,id).run();
    await renewLease();
    await attachSenderFamiliarity(normalized,user,accountId,token,e,now);
    await renewLease();
    const overrides=await loadOverrides(user,accountId,e,normalized.map(message=>message.id));
    const senderRules=await loadSenderRules(user,accountId,e);
    // Reuse a stored classification only when the content and the rules that produced it
    // both still match. Reading never triggers reclassification; refresh rotates stale versions.
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
      if(aiConfigured){
        // A repeatedly rejected message stays visible under the rules while retries
        // back off; a new model/prompt version gets a fresh attempt immediately.
        if(current&&hit.modelRetryVersion===currentAnalysisVersion&&(hit.modelRetryAt||0)>now)return automatic;
        return undefined;
      }
      if(current&&automatic.version===localVersion)return automatic;
      const updated=deterministicClassify(message,account);
      rechecked.set(message.id,updated);
      return updated;
    };
    const fresh=normalized.filter(message=>modelRefreshIds.has(message.id)||!reusable(message));
    // New content and the bounded stale-version queue cross the model boundary.
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
        classification=withSenderFamiliarity(classification,message);
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
          senderFamiliarityDeferred:message.senderFamiliarityDeferred,senderFamiliarityAttemptedAt:message.senderFamiliarityAttemptedAt,
          readerWasRecipient:[...message.to,...message.cc].some(party=>party.address.toLowerCase()===account.toLowerCase()),
          correctionRevision:manual?.revision??0,manuallyCorrected:manual?.active!==false&&!!manual,
          manualCorrection:manualCorrectionView(manual),
          senderJunkPreference:activeJunkPreference(senderRule),senderRuleRevision:senderRule?.revision??0,
          automaticClassificationAvailable:true,
          fingerprint:contentFingerprint(message),
          // Only a model call made now earns the current model version. A result checked
          // again under new rules keeps the version of the model that actually produced it.
          analysisVersion:results.has(message.id)?currentAnalysisVersion:stored?cached.get(message.id)!.analysisVersion||'':'',
          classificationSource:results.has(message.id)||(stored&&fromModel(cached.get(message.id)))?'ai':'deterministic',
          classificationPending:failures.has(message.id)||!results.has(message.id)&&!!stored&&!!cached.get(message.id)?.classificationPending,
          modelAttempts:failures.has(message.id)?Math.min((cached.get(message.id)?.modelRetryVersion===currentAnalysisVersion?cached.get(message.id)?.modelAttempts||0:0)+1,10):stored?cached.get(message.id)?.modelAttempts:0,
          // Provider outages get another chance at the next scheduled refresh. Invalid
          // individual answers back off exponentially, so one poison item stays bounded.
          modelRetryAt:failures.has(message.id)?now+(failures.get(message.id)==='provider-unavailable'?30*60000
            :Math.min(86400000,60000*2**Math.min((cached.get(message.id)?.modelRetryVersion===currentAnalysisVersion?cached.get(message.id)?.modelAttempts||0:0)+1,10)))
            :stored?cached.get(message.id)?.modelRetryAt:undefined,
          modelRetryVersion:failures.has(message.id)?currentAnalysisVersion:stored?cached.get(message.id)?.modelRetryVersion:undefined,
          replyCheckedAt:cached.get(message.id)?.replyCheckedAt,
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
    for(const id of new Set([...unreadableIds,...busyIds]))if(cached.has(id))pageEmails.push({...cached.get(id)!,syncGeneration:generation});
    for(let i=0;i<pageEmails.length;i+=50){
      await renewLease();
      await e.DB.batch(pageEmails.slice(i,i+50).map(email=>
      // Every message Gmail returns is stored. Asking a newsletter to stop sending says
      // nothing about what this mailbox should show: the sender still controls delivery, and
      // its receipts and account notices must keep arriving normally. Preserve a successful
      // reply recorded concurrently.
      e.DB.prepare("INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,?,?,0) ON CONFLICT(account_id,message_id) DO UPDATE SET data=json_set(CASE WHEN mailbox_messages.replied=1 THEN json_set(excluded.data,'$.needsReply',json('false')) ELSE excluded.data END,'$.inboxGeneration',json_extract(mailbox_messages.data,'$.inboxGeneration')),received_at=excluded.received_at,scan_generation=excluded.scan_generation")
        .bind(user,accountId,email.id,JSON.stringify(email),email.receivedAt||0,generation)));
    }
    // Gmail replies written on another device never pass through this app's send route.
    // Check a few unanswered conversations by metadata only, giving recent mail a short
    // interval while older mail rotates through more slowly. Gmail's SENT label and its
    // internal timestamp, not a sender-supplied header, determine what was answered.
    const recentCutoff=now-14*86400000;
    const dueThreads=await e.DB.prepare(`SELECT json_extract(data,'$.threadId') AS thread_id
      FROM mailbox_messages WHERE account_id=? AND user_id=? AND replied=0 AND json_extract(data,'$.needsReply')=1
      AND json_extract(data,'$.threadId') IS NOT NULL
      AND COALESCE(json_extract(data,'$.replyCheckedAt'),0)<=CASE WHEN received_at>? THEN ? ELSE ? END
      GROUP BY json_extract(data,'$.threadId')
      ORDER BY MIN(COALESCE(json_extract(data,'$.replyCheckedAt'),0)),MAX(received_at) DESC LIMIT 8`)
      .bind(accountId,user,recentCutoff,now-30*60000,now-6*3600000).all<{thread_id:string}>();
    const threads=(dueThreads.results||[]).filter(row=>!!row.thread_id);
    for(let i=0;i<threads.length;i+=4){
      await renewLease();
      const chunk=threads.slice(i,i+4);
      const responses=await Promise.allSettled(chunk.map(row=>gmail<{messages?:{labelIds?:string[];internalDate?:string}[]}>(
        `threads/${encodeURIComponent(row.thread_id)}?format=metadata&fields=messages(internalDate,labelIds)`,token,
        {signal:AbortSignal.timeout(5000)})));
      for(const [index,row] of chunk.entries()){
        const response=responses[index];
        let checkedAt=Date.now();
        if(response.status==='fulfilled'){
          const sentAt=(response.value.messages||[]).reduce((latest,message)=>{
            const time=Number(message.internalDate);
            return Array.isArray(message.labelIds)&&message.labelIds.includes('SENT')&&Number.isSafeInteger(time)&&time>0&&time<=Date.now()+300000
              ?Math.max(latest,time):latest;
          },0);
          if(sentAt)await e.DB.prepare("UPDATE mailbox_messages SET replied=1,data=json_set(data,'$.needsReply',json('false')) WHERE account_id=? AND user_id=? AND json_extract(data,'$.threadId')=? AND received_at<=?")
            .bind(accountId,user,row.thread_id,sentAt).run();
        }else{
          // A failed metadata check is retryable without failing the inbox refresh.
          checkedAt-=30*60000;
        }
        await e.DB.prepare("UPDATE mailbox_messages SET data=json_set(data,'$.replyCheckedAt',?) WHERE account_id=? AND user_id=? AND json_extract(data,'$.threadId')=?")
          .bind(checkedAt,accountId,user,row.thread_id).run();
      }
    }
    // Reconcile the entire Inbox across refreshes. Unseen mail is cleared only after the
    // final page; rows fetched during the scan retain the marker that a prior page set.
    await renewLease();
    let inboxMirror=old?.inboxMirror;
    try{
      const cursor=inboxMirror&&typeof inboxMirror.pageToken==='string'&&typeof inboxMirror.generation==='string'&&Number.isSafeInteger(inboxMirror.started)?inboxMirror:undefined;
      const mirrorGeneration=cursor?.generation||crypto.randomUUID();
      const started=cursor?.started??now;
      const inbox=await gmail<{messages?:{id:string}[];nextPageToken?:string}>(
        `messages?labelIds=INBOX&maxResults=${INBOX_MIRROR}&fields=messages(id),nextPageToken${cursor?`&pageToken=${encodeURIComponent(cursor.pageToken)}`:''}`,token,{signal:AbortSignal.timeout(10000)});
      const ids=JSON.stringify((inbox.messages||[]).map(message=>message.id));
      await e.DB.prepare(`UPDATE mailbox_messages SET data=json_set(data,'$.inInbox',json('true'),'$.inboxGeneration',?)
        WHERE account_id=? AND user_id=? AND message_id IN (SELECT value FROM json_each(?))`)
        .bind(mirrorGeneration,accountId,user,ids).run();
      if(!inbox.nextPageToken)await e.DB.prepare(`UPDATE mailbox_messages SET data=json_set(data,'$.inInbox',json('false'))
        WHERE account_id=? AND user_id=? AND COALESCE(json_extract(data,'$.inboxGeneration'),'')<>?
        AND received_at<=?`)
        .bind(accountId,user,mirrorGeneration,started).run();
      inboxMirror=inbox.nextPageToken?{pageToken:inbox.nextPageToken,generation:mirrorGeneration,started}:undefined;
    }catch(error){
      if(error instanceof HttpError&&error.status===400)inboxMirror=undefined;
      console.error('Inbox listing failed; keeping the last known inbox.');
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
    // The digest is worded from everything stored for this mailbox, recent mail only. A problem
    // writing it must never stop the inbox from refreshing, so the earlier wording is kept.
    const stored=await loadMessages(user,accountId,e);
    let digest=old?.digest;
    try{digest=await buildDigest(stored.filter(email=>!email.receivedAt||email.receivedAt>now-60*86400000),e,old?.digest);}
    catch{console.error('Digest wording failed; keeping the previous digest.');}
    // Keep only this bounded page in the legacy snapshot for rolling compatibility. The
    // complete mailbox lives in `mailbox_messages` and is never serialized as one blob.
    const snapshot:Snapshot={emails:snapshotPage(pageEmails),ai:pending===0&&!!e.GEMINI_API_KEY,pending,skipped:totalSkipped,analysisVersion:currentAnalysisVersion,updated:Date.now(),limit:totals?.total||0,hasMore:!!list.nextPageToken,...(inboxMirror?{inboxMirror}:{}),...(digest?{digest}:{}),...(nextFetchRetry.size?{fetchRetry:[...nextFetchRetry].slice(-FETCH_RETRY_KEPT).map(([id,attempts])=>({id,attempts}))}:{})};
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
      e.DB.prepare('UPDATE connections SET last_sync=?,sync_lock=0,error=NULL,sync_page_token=?,sync_generation=?,sync_skipped=?,sync_full_scan=?,backfill_complete=?,last_full_scan=?,content_version=?,model_backfill_version=?,recovery_needed=MAX(recovery_needed-?,0) WHERE id=? AND user_id=? AND token=? AND sync_lock=? AND sync_lock>?')
        .bind(snapshot.updated,list.nextPageToken||null,list.nextPageToken?generation:null,list.nextPageToken?totalSkipped:0,fullScan?1:0,
          fullScan&&!list.nextPageToken?1:lock.backfill_complete,fullScan&&!list.nextPageToken?snapshot.updated:lock.last_full_scan,
          fullScan&&!list.nextPageToken?CONTENT_VERSION:lock.content_version,
          fullScan&&!list.nextPageToken||modelChanged&&!modelPass?modelVersion:lock.model_backfill_version,
          // Cleared only by a full scan that reached its last page, and only by the number
          // of requests it saw at the start. This write already requires the lease and the
          // credential to be unchanged, so an interrupted or superseded recovery leaves the
          // count and the next refresh resumes it.
          recovering&&fullScan&&!list.nextPageToken?lock.recovery_needed:0,
          accountId,user,lock.token,leaseUntil,snapshot.updated),
    ]);
    if(!writes[0].meta.changes)throw new HttpError(409,'This Gmail connection or refresh changed. Please refresh the inbox again.');
    return {...snapshot,emails:stored};
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
  // Emails scheduled for later are time-sensitive, so they go first and never block the inbox refresh.
  try{await sendDueScheduled(e);}catch{console.error('Scheduled email delivery failed; the next run will try again.');}
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
