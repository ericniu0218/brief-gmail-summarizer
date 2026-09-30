import { getOwnedConnection, accessToken, gmail, type GmailMessage } from '@/server/gmail';
import { normalizeMessage } from '@/server/message';
import { describeUnsubscribe } from '@/server/unsubscribe';
import { failure, HttpError, json, mutation, runtime, userId, inputObject, type Runtime } from '@/server/runtime';
import { gmailThreadUrl } from '@/lib/mail';
import { asOutcome, reasonFor, requestKey, scopeDescription, type UnsubscribeCapability, type UnsubscribeOutcome } from '@/lib/unsubscribe';

/**
 * Submits a verified one-click unsubscribe, or explains what the person has to do instead.
 *
 * The browser sends only which message it is acting on and which mailbox received it. The
 * account is verified against the signed-in user, the combined "All inboxes" selection is
 * refused as an action account by `getOwnedConnection`, and the message is re-read from that
 * account's Gmail — so the destination is always the sender's own, never one the browser
 * supplied.
 *
 * Nothing here hides mail. The row it writes is history, and an accepted response means only
 * that the newsletter service took the request.
 */

/** How long one attempt may hold a request before another may take it over. */
const ATTEMPT_LEASE = 60000;

type Row = { outcome: string; detail: string | null };

/**
 * Write the result, but only if this attempt still owns the row.
 *
 * A slow attempt that wakes after its lease expired finds the row owned by a newer one and
 * writes nothing, so the newer result stands. Returns whether the write landed.
 */
async function finish(e: Runtime, key: string, user: string, attempt: string,
  outcome: UnsubscribeOutcome, detail: string) {
  try {
    const written = await e.DB.prepare(
      'UPDATE unsubscribe_requests SET outcome=?, detail=?, updated=? WHERE id=? AND user_id=? AND attempt=?')
      .bind(outcome, detail, Date.now(), key, user, attempt).run();
    return !!written.meta.changes;
  } catch {
    console.error('An unsubscribe request completed, but its record could not be written.');
    return false;
  }
}

export async function POST(request: Request) {
  try {
    mutation(request); const user = await userId(); const e = runtime();
    const { id, accountId, confirmRetry } = await inputObject(request);
    // A cast validates nothing: an array id would pass the pattern once coerced to a string.
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new HttpError(400, 'Choose a valid message.');
    const owned = await getOwnedConnection(user, typeof accountId === 'string' ? accountId : '', e);
    let message;
    try {
      message = normalizeMessage(await gmail<GmailMessage>(
        'messages/' + encodeURIComponent(id) + '?format=full', await accessToken(user, owned.id, e)));
    } catch (error) {
      // A credential problem is something the person can fix, so it is reported next to the
      // button as its own reason rather than as a generic failure.
      const status = error instanceof HttpError ? error.status : 0;
      const capability: UnsubscribeCapability = 'unavailable';
      const reason = status === 401 || status === 403 ? 'account-disconnected' : 'unreadable';
      return json({ capability, outcome: 'none' satisfies UnsubscribeOutcome, reason,
        gmailUrl: gmailThreadUrl(owned.email, id) });
    }
    // Eligibility is decided here even though the browser already showed a button: what the
    // browser knows came from an earlier sync and may be stale or tampered with.
    const plan = describeUnsubscribe(message, e);
    const gmailUrl = gmailThreadUrl(owned.email, message.threadId || id);
    const identity = plan.identity;
    const scope = identity.scope;
    const answer = (outcome: UnsubscribeOutcome, extra: { recordSaved?: boolean } & Record<string, unknown> = {}) => {
      const { recordSaved = true, ...rest } = extra;
      return json({ capability: plan.capability, outcome,
        // One stable code per situation. The browser owns the wording.
        reason: reasonFor(plan.capability, outcome, recordSaved),
        page: plan.page, mailto: plan.mailto, gmailUrl, scope,
        scopeDetail: scopeDescription(scope), ...rest });
    };

    if (plan.capability !== 'one-click') return answer('none');

    const key = requestKey(owned.id, identity);
    const attempt = crypto.randomUUID();
    const now = Date.now();
    // Claiming and recording are one statement, so two tabs cannot both believe they won.
    // The row is never deleted and re-inserted: a concurrent retry would slip between the
    // two halves of that and replace whichever result finished first. A claim is granted
    // only from a state a new request may be made from — nothing submitted yet, or the
    // service definitely refused — or when a previous attempt has held the row past its
    // lease and is presumed lost.
    //
    // The account is checked again inside the claim. It was verified before the Gmail read,
    // but a disconnect can land while that read is in flight; without this the request would
    // still reach the provider and write history for an account that no longer exists.
    const claim = await e.DB.prepare(`INSERT INTO unsubscribe_requests
        (id,user_id,account_id,message_id,list_id,address,scope,outcome,detail,attempt,created,updated)
        SELECT ?,?,?,?,?,?,?,'pending',NULL,?,?,?
        WHERE EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=?)
      ON CONFLICT(id) DO UPDATE SET outcome='pending',detail=NULL,attempt=excluded.attempt,
        message_id=excluded.message_id,updated=excluded.updated
      WHERE unsubscribe_requests.outcome IN ('none','failed')
         OR (unsubscribe_requests.outcome='unknown' AND ?=1)
         OR (unsubscribe_requests.outcome='pending' AND unsubscribe_requests.updated <= ?)`)
      .bind(key, user, owned.id, identity.messageId, identity.listId ?? null, message.from.address,
        scope, attempt, now, now, owned.id, user, confirmRetry===true?1:0, now - ATTEMPT_LEASE).run();

    if (!claim.meta.changes) {
      // Another attempt holds this request, or it already has an answer. Report what is
      // stored rather than sending a second request: repeating a POST whose outcome is
      // merely uncertain could unsubscribe a list the person has since rejoined.
      const existing = await e.DB.prepare(
        'SELECT outcome, detail FROM unsubscribe_requests WHERE id=? AND user_id=?')
        .bind(key, user).first<Row>();
      if (!existing) {
        // No row and no claim: the connection disappeared after it was verified.
        const capability: UnsubscribeCapability = 'unavailable';
        return json({ capability, outcome: 'none' satisfies UnsubscribeOutcome, reason: 'account-disconnected', gmailUrl });
      }
      const stored = asOutcome(existing?.outcome) ?? 'unknown';
      return answer(stored, { detail: existing?.detail ?? undefined, saved: true });
    }

    let response: Response;
    try {
      response = await fetch(plan.automatic!, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click', redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
    } catch {
      // The request may have arrived and its answer been lost. Recording a failure here
      // would invite a retry of something that may already have happened.
      await finish(e, key, user, attempt, 'unknown', 'The connection to the newsletter service was interrupted.');
      return answer('unknown');
    }

    // `redirect:'manual'` means a 3xx arrives here instead of being followed. A service
    // answering with one is asking for a step this app cannot take for the person, and no
    // confirmation page is ever fetched or scraped to discover what that step is.
    const outcome: UnsubscribeOutcome = response.ok ? 'accepted'
      : response.status >= 300 && response.status < 400 ? 'action-required'
      // Only a 4xx is a definite refusal. A 5xx says the service is broken, not that it
      // rejected the request, so the outcome stays uncertain and is not retried by itself.
      : response.status >= 400 && response.status < 500 ? 'failed' : 'unknown';
    // The status code is recorded; the URL never is, because it carries a token that
    // identifies this subscriber.
    const saved = await finish(e, key, user, attempt, outcome,
      `The newsletter service answered ${response.status}.`);
    // The provider has already acted. A database failure afterwards is this app's problem
    // and is reported as one — calling it a rejection would tell the person the opposite of
    // what actually happened.
    return answer(outcome, saved ? {} : { recordSaved: false });
  } catch (error) { return failure(error); }
}
