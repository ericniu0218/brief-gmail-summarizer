import { appliesToUser, DUE_SOON_MS, effectiveClassification, isResolved, MEETING_SOON_MS, obligationDueAt, type Classification, type Obligation } from './classification';
import type { Email } from './mail';

/**
 * How important a message is *right now*.
 *
 * This is deliberately separate from the classification, which records what a message
 * says and does not change as time passes. Importance is recomputed from that record on
 * every read, so an obligation can fall due, come overdue and go quiet without another
 * classification request and without rewriting anything stored.
 *
 * `now` is always passed in. Nothing here reads the clock, so every rule is testable at a
 * fixed instant and the server and browser cannot disagree about what "today" means.
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;

/** Thresholds kept together so the policy can be tuned in one place. */
export const IMPORTANCE = {
  /** An unresolved obligation this close to its due time needs attention today. */
  dueSoon: DUE_SOON_MS,
  /** A meeting this close is emphasised above other work due in the same window. */
  meetingSoon: MEETING_SOON_MS,
  /** How far ahead a meeting still counts as upcoming for calendar purposes. */
  meetingWindow: 7 * DAY,
  /** How long a direct request counts as recent after it arrives. */
  recentRequest: 7 * DAY,
  /** Beyond this, an undated unresolved item drops out of the ranking by age alone. */
  agingRequest: 30 * DAY,
  /** A missed deadline is shown as overdue for this long, then it stops being urgent. */
  overdueGrace: 7 * DAY,
  /** Allow ordinary clock drift without trusting timestamps far in the future. */
  futureSkew: 5 * 60 * 1000,
} as const;

export type ImportanceTier = 'due-now' | 'recent-request' | 'overdue' | 'aging' | 'routine';

/** Lower sorts first. Tiers are ordered, so the list never needs an opaque score. */
const TIER_RANK: Record<ImportanceTier, number> = {
  'due-now': 0, 'recent-request': 1, overdue: 2, aging: 3, routine: 4,
};

export type Importance = {
  tier: ImportanceTier;
  /** Sort position of the tier; see TIER_RANK. */
  rank: number;
  /** Whether this belongs in Important now. */
  important: boolean;
  /** The due time driving this result, when the message supported one. */
  dueAt?: number;
  overdue: boolean;
  /** Stable code for tests and display; `reason` is the sentence for a reader. */
  reasonCode: string;
  reason: string;
};

function at(tier: ImportanceTier, important: boolean, reasonCode: string, reason: string,
  extra: { dueAt?: number; overdue?: boolean } = {}): Importance {
  return { tier, rank: TIER_RANK[tier], important, overdue: false, reasonCode, reason, ...extra };
}

export { obligationDueAt } from './classification';

/**
 * The message's own timestamp, or undefined when it is missing or unusable.
 *
 * Never substituted with the current time: doing so is what makes an old message look
 * newly arrived, and an unknown age should withhold urgency rather than invent it.
 */
export function receivedAtOf(email: Pick<Email, 'receivedAt'>, now:number|null): number | undefined {
  const value = email?.receivedAt;
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0)return undefined;
  if(now!==null&&Number.isFinite(now)&&value>now+IMPORTANCE.futureSkew)return undefined;
  return value;
}

function hasFutureReceivedAt(email:Pick<Email,'receivedAt'>,now:number){
  const value=email?.receivedAt;
  return typeof value==='number'&&Number.isFinite(value)&&value>now+IMPORTANCE.futureSkew;
}

/**
 * Calendar eligibility. It shares the validity checks used for urgency but keeps its own
 * window, so a confirmed meeting next month stays visible when that month is browsed even
 * though it is nowhere near today's Important now.
 */
export function isUpcomingMeeting(obligation: Obligation, now: number, windowMs: number = IMPORTANCE.meetingWindow) {
  if (!obligation || obligation.kind !== 'meeting') return false;
  if (isResolved(obligation) || obligation.meetingState === 'cancelled') return false;
  const due = obligationDueAt(obligation);
  return due !== undefined && due >= now && due - now <= windowMs;
}

/** Rates one live obligation. Callers filter out resolved and other people's work first. */
function rateObligation(obligation: Obligation, received: number | undefined, now: number, futureReceived=false): Importance {
  const due = obligationDueAt(obligation);
  const meeting = obligation.kind === 'meeting';

  if (due !== undefined) {
    const until = due - now;
    if (until >= 0) {
      if (meeting) {
        if (until <= IMPORTANCE.meetingSoon)
          return at('due-now', true, 'meeting-within-24h', 'Meeting within 24 hours.', { dueAt: due });
        if (until <= IMPORTANCE.dueSoon)
          return at('due-now', true, 'meeting-soon', 'Meeting in the next three days.', { dueAt: due });
        return at('routine', false, 'meeting-later', 'Meeting further ahead.', { dueAt: due });
      }
      if (until <= IMPORTANCE.dueSoon)
        return at('due-now', true, 'due-within-72h', 'Due within 72 hours.', { dueAt: due });
      return at('routine', false, 'due-later', 'Due further ahead.', { dueAt: due });
    }
    // Past its due time. A meeting that has already happened is history, not a task.
    if (meeting) return at('routine', false, 'meeting-passed', 'This meeting has already taken place.', { dueAt: due, overdue: false });
    if (-until <= IMPORTANCE.overdueGrace)
      return at('overdue', true, 'recently-overdue', 'Overdue.', { dueAt: due, overdue: true });
    // Still unresolved, and still recent enough to act on. It ranks below work that is
    // actually due now, but it is shown: rating a labelled set of real and constructed mail
    // put every aging item in the top band, because an institutional obligation does not
    // stop mattering after a week.
    if (-until <= IMPORTANCE.agingRequest)
      return at('aging', true, 'long-overdue', 'Overdue for more than a week.', { dueAt: due, overdue: true });
    // Past the same horizon that retires an undated item. This is what keeps last year's
    // deadlines out of Important: permanent urgency is indistinguishable from none.
    return at('aging', false, 'stale-overdue', 'Overdue for a long time.', { dueAt: due, overdue: true });
  }

  // No supported date, so recency is the only evidence of current relevance.
  if (received === undefined) {
    if(futureReceived)
      return at('routine',false,'future-received-date','Arrival date is too far in the future to establish recency.');
    // The age cannot be assessed at all, so the unaged rule applies rather than a guess
    // in either direction: a direct request still counts, anything weaker waits. An
    // unknown timestamp is not evidence of staleness, and substituting one would be the
    // very thing that makes old mail look new.
    if (obligation.kind === 'request' && obligation.ownerIsUser === true)
      return at('recent-request', true, 'undated-direct-request', 'A direct request, with no date to age it by.');
    return at('aging', false, 'undated-unknown-age', 'Unresolved, with no date to judge it by.');
  }
  const age = now - received;
  if (obligation.kind === 'request' && obligation.ownerIsUser === true && age <= IMPORTANCE.recentRequest)
    return at('recent-request', true, 'recent-direct-request', 'A direct request from the last week.');
  if (age <= IMPORTANCE.agingRequest)
    return at('aging', true, 'aging-obligation', 'Unresolved, but not recent.');
  return at('routine', false, 'old-undated-obligation', 'Unresolved for over a month, with no date.');
}

/**
 * Importance for a message with no structured classification: old snapshots and the
 * sample workspace.
 *
 * There is nothing to re-evaluate here, so the stored flag is honoured — but it is aged
 * like everything else, which is what stops a cached `priority: 'high'` lasting forever.
 * A record with no timestamp keeps its flag, because an unknown age is not evidence of
 * staleness either; the sample workspace has no timestamps and depends on this.
 */
function legacyImportance(email: Email, now: number): Importance {
  const flagged = email?.category !== 'noise' && (!!email?.needsReply || email?.priority === 'high');
  if (!flagged) return at('routine', false, 'legacy-routine', 'Nothing marks this for attention.');
  const received = receivedAtOf(email,now);
  if(hasFutureReceivedAt(email,now))
    return at('routine',false,'legacy-future-date','Arrival date is too far in the future to establish recency.');
  if (received === undefined)
    return at('recent-request', true, 'legacy-undated', 'Marked for attention.');
  if (now - received <= IMPORTANCE.recentRequest)
    return at('recent-request', true, 'legacy-recent', 'Recently marked for attention.');
  return at('aging', false, 'legacy-stale', 'Marked for attention some time ago.');
}

/**
 * Whether a message looks worth attention *without* consulting a clock.
 *
 * Used only while the browser's time is still unknown: the server render and the first
 * client paint. It reads the flags already on the record instead of feeding a placeholder
 * timestamp into the time-based policy — an epoch-zero "now" dates every message from
 * 1970 and inverts the answer, reading a months-old request as fresh and a deadline an
 * hour away as far off. The live policy replaces this the moment the clock arrives.
 */
export function cachedImportance(email: Email): boolean {
  return email?.category !== 'noise' && (email?.priority === 'high' || !!email?.needsReply);
}

/**
 * The single answer to "does this matter now?", used by Overview, the counts, the list
 * order, the daily brief and grouped rows so they cannot drift apart.
 *
 * The classification passed in is expected to be the effective one, with any manual
 * corrections already composed in — that is what `readMailbox` stores on each message. A
 * completed or cancelled obligation therefore loses urgency the moment it is corrected,
 * with no separate path through this function.
 */
export function evaluateImportance(email: Email, now: number): Importance {
  const stored = email?.classification;
  if (!stored || typeof stored !== 'object') return legacyImportance(email, now);

  // Runtime-guarded: a snapshot written by an older version may be missing fields.
  const classification: Classification = effectiveClassification(stored);
  if (classification.disposition === 'junk')
    return at('routine', false, 'noise', 'Filed as Noise.');

  const received = receivedAtOf(email,now);
  const futureReceived=hasFutureReceivedAt(email,now);
  const live = (Array.isArray(classification.obligations) ? classification.obligations : [])
    .filter(obligation => obligation && typeof obligation === 'object'
      && obligation.required && appliesToUser(obligation) && !isResolved(obligation));

  let best: Importance | undefined;
  // Rated per obligation, not per message: an email holding a stale deadline *and* a
  // meeting tomorrow must surface for the meeting.
  for (const obligation of live) {
    const candidate = rateObligation(obligation, received, now, futureReceived);
    const better = !best || candidate.rank < best.rank
      || (candidate.rank === best.rank && (candidate.dueAt ?? Infinity) < (best.dueAt ?? Infinity));
    if (better) best = candidate;
  }

  // A security notice deserves attention while it is fresh. It is not evidence the
  // message is genuine, and an old one is history like anything else.
  if (classification.securityEvent && received !== undefined && now - received <= IMPORTANCE.recentRequest) {
    const security = at('recent-request', true, 'recent-security-event', 'A recent account or security notice.');
    if (!best || security.rank < best.rank) best = security;
  }

  return best ?? at('routine', false, 'no-current-obligation', 'Nothing here needs attention now.');
}
