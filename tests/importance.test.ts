import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInboxRows, isImportantEmail, sortInboxEmails } from '../lib/inbox-priority';
import { evaluateImportance, IMPORTANCE, isUpcomingMeeting, obligationDueAt, receivedAtOf } from '../lib/importance';
import { byEventTime, dateKey, emailDates, eventMinutes, nextEmailEvent } from '../lib/calendar';
import type { Classification, Obligation } from '../lib/classification';
import type { Email } from '../lib/mail';

/**
 * Time-dependent importance.
 *
 * Every case fixes `now` explicitly. Nothing here reads the real clock, so a test that
 * passes today still passes in November.
 */

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0); // 2026-09-24T12:00:00Z
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ago = (ms: number) => NOW - ms;
const ahead = (ms: number) => NOW + ms;
const isoDate = (at: number) => new Date(at).toISOString().slice(0, 10);

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    id: 'o1', kind: 'request', description: 'Approve the invoice', owner: 'you',
    ownerIsUser: true, required: true, evidence: 'Please approve invoice 42.',
    state: 'open', ...over,
  };
}

function classification(over: Partial<Classification> = {}): Classification {
  return {
    context: 'work', topics: [], obligations: [], disposition: 'useful', replyRequired: false,
    securityEvent: false, processingStatus: 'classified', reason: 'test', version: 'test', ...over,
  };
}

/** A mail record carrying only the fields importance is allowed to read. */
function email(id: string, over: Partial<Email> = {}): Email {
  return {
    id, accountId: 'acct-1', sender: 'Sender', address: `${id}@example.com`, initials: 'S',
    subject: `Subject ${id}`, summary: '', body: '', time: '', category: 'work',
    priority: 'normal', needsReply: false, unread: false, color: 'blue',
    receivedAt: ago(DAY), ...over,
  } as Email;
}

// ── Reproduction: the reported November ranking failure ─────────────────────

/** An unresolved direct request from last November, with no due date and no new activity. */
const novemberRequest = email('november', {
  subject: 'Re: contract paperwork',
  receivedAt: Date.UTC(2025, 10, 12, 9, 0, 0),
  needsReply: true,
  priority: 'high',
  classification: classification({ replyRequired: true, obligations: [obligation()] }),
});

/** A direct request that arrived this morning and is genuinely waiting on the user. */
const todayRequest = email('today', {
  subject: 'Sign-off needed on the September report',
  receivedAt: ago(4 * HOUR),
  needsReply: true,
  classification: classification({ replyRequired: true, obligations: [obligation({ id: 'o-today' })] }),
});

void test('an old request with no current reason for attention leaves Important now', () => {
  assert.equal(isImportantEmail(todayRequest, NOW), true, 'this morning’s request still matters');
  assert.equal(
    isImportantEmail(novemberRequest, NOW), false,
    'a ten-month-old dateless request is no longer Important now',
  );
});

void test('a current request outranks an old one in the list', () => {
  const order = sortInboxEmails([novemberRequest, todayRequest], NOW).map(item => item.id);
  assert.deepEqual(order, ['today', 'november'], 'the current request comes first');
});

void test('an old email whose obligation falls due tomorrow is still important', () => {
  // Age alone must not disqualify: the deadline, not the arrival date, is what matters.
  const oldButDue = email('old-due', {
    receivedAt: Date.UTC(2025, 10, 12, 9, 0, 0),
    classification: classification({
      obligations: [obligation({ kind: 'deadline', due: { phrase: 'tomorrow', date: isoDate(ahead(DAY)), ambiguous: false } })],
    }),
  });
  assert.equal(isImportantEmail(oldButDue, NOW), true, 'a live deadline keeps an old email important');
  const order = sortInboxEmails([todayRequest, oldButDue], NOW).map(item => item.id);
  assert.deepEqual(order, ['old-due', 'today'], 'an imminent deadline outranks a same-day request');
});

void test('a stored high priority does not outlive the reason for it', () => {
  // The only signal is a cached flag from a classification long past; nothing about the
  // message is still actionable.
  const stale = email('stale-flag', {
    receivedAt: Date.UTC(2025, 10, 12, 9, 0, 0),
    priority: 'high',
    classification: classification({ obligations: [obligation({ state: 'completed' })] }),
  });
  assert.equal(isImportantEmail(stale, NOW), false, 'a resolved task carries no urgency');
});

// ── Boundaries of each threshold ───────────────────────────────────────────

const deadline = (dueAt: number, over: Partial<Obligation> = {}) =>
  obligation({ kind: 'deadline', due: { phrase: 'by then', time: new Date(dueAt).toISOString(), ambiguous: false }, ...over });

const withObligations = (id: string, obligations: Obligation[], over: Partial<Email> = {}) =>
  email(id, { classification: classification({ obligations }), ...over });

void test('the 72-hour window is measured in elapsed time, not calendar dates', () => {
  const inside = withObligations('inside', [deadline(ahead(IMPORTANCE.dueSoon - 1000))]);
  const exactly = withObligations('exactly', [deadline(ahead(IMPORTANCE.dueSoon))]);
  const outside = withObligations('outside', [deadline(ahead(IMPORTANCE.dueSoon + 1000))]);
  assert.equal(evaluateImportance(inside, NOW).important, true, 'just inside the window');
  assert.equal(evaluateImportance(exactly, NOW).important, true, 'exactly on the boundary');
  assert.equal(evaluateImportance(outside, NOW).important, false, 'just outside the window');
  assert.equal(evaluateImportance(outside, NOW).tier, 'routine');
});

void test('an overdue deadline is urgent for a week, shown for a month, then retired', () => {
  const justOverdue = evaluateImportance(withObligations('a', [deadline(ago(HOUR))]), NOW);
  assert.equal(justOverdue.tier, 'overdue');
  assert.equal(justOverdue.important, true);
  assert.equal(justOverdue.overdue, true);

  const edge = evaluateImportance(withObligations('b', [deadline(ago(IMPORTANCE.overdueGrace))]), NOW);
  assert.equal(edge.important, true, 'exactly at the grace boundary');

  // Past the grace period it drops a tier but stays in Important. Rating a labelled set of
  // real and constructed mail put every aging obligation in the top band: a fine that is
  // still accruing, or a form the university is still waiting for, has not stopped mattering.
  const longPast = evaluateImportance(withObligations('c', [deadline(ago(IMPORTANCE.overdueGrace + 1000))]), NOW);
  assert.equal(longPast.tier, 'aging', 'below work that is due now');
  assert.equal(longPast.important, true, 'but still shown');
  assert.equal(longPast.overdue, true, 'and still says it is unresolved');

  // One horizon retires everything, dated or not. This is what keeps last year's deadlines
  // out of Important, which is the whole reason the ranking was reworked.
  const stale = evaluateImportance(withObligations('d', [deadline(ago(IMPORTANCE.agingRequest + DAY))]), NOW);
  assert.equal(stale.tier, 'aging');
  assert.equal(stale.important, false, 'a long-dead deadline is history, not work');
  assert.equal(stale.reasonCode, 'stale-overdue');
});

void test('an undated direct request drops a tier after a week and retires after a month', () => {
  const fresh = withObligations('fresh', [obligation()], { receivedAt: ago(IMPORTANCE.recentRequest - 1000) });
  const edge = withObligations('edge', [obligation()], { receivedAt: ago(IMPORTANCE.recentRequest) });
  const older = withObligations('older', [obligation()], { receivedAt: ago(IMPORTANCE.recentRequest + 1000) });
  const ancient = withObligations('ancient', [obligation()], { receivedAt: ago(IMPORTANCE.agingRequest + DAY) });
  assert.equal(evaluateImportance(fresh, NOW).important, true);
  assert.equal(evaluateImportance(edge, NOW).important, true, 'exactly seven days still counts');
  assert.equal(evaluateImportance(older, NOW).tier, 'aging', 'it stays an unresolved item');
  assert.equal(evaluateImportance(older, NOW).important, true, 'ranked lower, still shown');
  assert.equal(evaluateImportance(ancient, NOW).tier, 'routine');
  assert.equal(evaluateImportance(ancient, NOW).important, false, 'a month with no date retires it');
  // Nothing was marked done: the task is quieter, not finished.
  for (const message of [older, ancient])
    assert.equal(message.classification!.obligations[0].state, 'open', 'the record is untouched');
});

// ── What must never become urgent ──────────────────────────────────────────

void test('marketing language confers no urgency at any age', () => {
  const promo = email('promo', {
    subject: 'URGENT: our meeting-room sale ends soon — deadline tonight!',
    body: 'Act now before the deal ends. Order now!',
    category: 'noise',
    receivedAt: ago(4 * HOUR),
    classification: classification({ disposition: 'junk' }),
  });
  assert.equal(evaluateImportance(promo, NOW).important, false, 'keywords are not evidence');
  // The same wording with no classification at all must not be promoted either.
  const legacyPromo = email('legacy-promo', {
    subject: 'URGENT: deadline tonight', category: 'noise', priority: 'high', needsReply: true,
    receivedAt: ago(HOUR), classification: undefined,
  });
  assert.equal(evaluateImportance(legacyPromo, NOW).important, false, 'Noise is excluded outright');
});

void test('work that belongs to somebody else, or is optional, is not the user’s urgency', () => {
  const someoneElse = withObligations('theirs', [deadline(ahead(HOUR), { ownerIsUser: false, owner: 'Alex' })]);
  assert.equal(evaluateImportance(someoneElse, NOW).important, false, 'a task assigned to another person');

  const optional = withObligations('optional', [obligation({ kind: 'meeting', required: false, due: { phrase: 'Friday', time: new Date(ahead(HOUR)).toISOString(), ambiguous: false } })]);
  assert.equal(evaluateImportance(optional, NOW).important, false, 'an optional invitation');

  const newsletter = email('research', {
    receivedAt: ago(2 * HOUR),
    classification: classification({ topics: ['research'], obligations: [] }),
  });
  assert.equal(evaluateImportance(newsletter, NOW).important, false, 'research content with no request');
  assert.equal(evaluateImportance(newsletter, NOW).reasonCode, 'no-current-obligation');
});

void test('ambiguous dates and unclear ownership do not confer urgency by themselves', () => {
  const ambiguous = withObligations('ambiguous', [obligation({
    kind: 'deadline', due: { phrase: 'next quarter', date: isoDate(ahead(DAY)), ambiguous: true },
  })], { receivedAt: ago(60 * DAY) });
  // The date could not be resolved, so it is treated as no date and aged accordingly.
  assert.equal(evaluateImportance(ambiguous, NOW).important, false);

  const unclearOwner = withObligations('unclear', [deadline(ahead(HOUR), { ownerIsUser: null })]);
  // Unclear is not the same as somebody else's: it still counts, and review explains why.
  assert.equal(evaluateImportance(unclearOwner, NOW).important, true);
});

// ── Meetings ───────────────────────────────────────────────────────────────

void test('only a meeting that is still going to happen carries urgency', () => {
  const meeting = (over: Partial<Obligation>) => obligation({
    kind: 'meeting', meetingState: 'confirmed',
    due: { phrase: 'tomorrow', time: new Date(ahead(DAY)).toISOString(), ambiguous: false }, ...over,
  });
  assert.equal(evaluateImportance(withObligations('confirmed', [meeting({})]), NOW).important, true);
  assert.equal(evaluateImportance(withObligations('cancelled', [meeting({ meetingState: 'cancelled' })]), NOW).important, false);
  assert.equal(evaluateImportance(withObligations('called-off', [meeting({ state: 'cancelled' })]), NOW).important, false);

  const ended = withObligations('ended', [meeting({ due: { phrase: 'yesterday', time: new Date(ago(DAY)).toISOString(), ambiguous: false } })]);
  const rated = evaluateImportance(ended, NOW);
  assert.equal(rated.important, false, 'a meeting that already happened is history');
  assert.equal(rated.overdue, false, 'and is not reported as an overdue task');

  // Within 24 hours a meeting outranks other work due in the same window.
  const soon = withObligations('soon', [meeting({ due: { phrase: 'in an hour', time: new Date(ahead(HOUR)).toISOString(), ambiguous: false } })]);
  assert.equal(evaluateImportance(soon, NOW).reasonCode, 'meeting-within-24h');
});

void test('calendar eligibility keeps its own window, wider than Important now', () => {
  const nextWeek = obligation({ kind: 'meeting', meetingState: 'confirmed',
    due: { phrase: 'next week', time: new Date(ahead(5 * DAY)).toISOString(), ambiguous: false } });
  // Absent from today's Important now, but still a real upcoming meeting.
  assert.equal(evaluateImportance(withObligations('next-week', [nextWeek]), NOW).important, false);
  assert.equal(isUpcomingMeeting(nextWeek, NOW), true);
  assert.equal(isUpcomingMeeting({ ...nextWeek, meetingState: 'cancelled' }, NOW), false);
  // A meeting next month is outside the default window but visible when that range is asked for.
  const nextMonth = { ...nextWeek, due: { phrase: 'next month', time: new Date(ahead(35 * DAY)).toISOString(), ambiguous: false } };
  assert.equal(isUpcomingMeeting(nextMonth, NOW), false);
  assert.equal(isUpcomingMeeting(nextMonth, NOW, 60 * DAY), true);
});

// ── Resolution, corrections and replies ────────────────────────────────────

void test('a resolved task loses urgency and a separate open task keeps it', () => {
  const due = { phrase: 'today', time: new Date(ahead(HOUR)).toISOString(), ambiguous: false };
  for (const state of ['completed', 'cancelled', 'superseded'] as const)
    assert.equal(evaluateImportance(withObligations(state, [obligation({ kind: 'deadline', due, state })]), NOW).important,
      false, `${state} work is not urgent`);

  // A reply was sent, clearing reply-needed, but the submission itself is still open.
  const replied = withObligations('replied', [
    obligation({ id: 'ask', kind: 'request', state: 'completed' }),
    obligation({ id: 'submit', kind: 'deadline', due, state: 'open' }),
  ], { needsReply: false });
  assert.equal(evaluateImportance(replied, NOW).important, true, 'answering is not finishing');
  assert.equal(evaluateImportance(replied, NOW).reasonCode, 'due-within-72h');
});

void test('an email is rated by its most pressing live obligation, not its worst one', () => {
  const stale = obligation({ id: 'stale', kind: 'deadline',
    due: { phrase: 'last year', time: new Date(ago(300 * DAY)).toISOString(), ambiguous: false } });
  const meetingTomorrow = obligation({ id: 'meet', kind: 'meeting', meetingState: 'confirmed',
    due: { phrase: 'tomorrow', time: new Date(ahead(DAY)).toISOString(), ambiguous: false } });
  const mixed = withObligations('mixed', [stale, meetingTomorrow], { receivedAt: ago(200 * DAY) });
  const rated = evaluateImportance(mixed, NOW);
  assert.equal(rated.important, true, 'the live meeting surfaces the message');
  assert.equal(rated.reasonCode, 'meeting-within-24h');
  assert.equal(rated.dueAt, ahead(DAY), 'and the reported due time is the live one');
});

// ── Dates that cannot be trusted ───────────────────────────────────────────

void test('an unusable received date is unknown, never today', () => {
  const values: unknown[] = [undefined, null, Number.NaN, 0, -1, 'yesterday'];
  for (const value of values) {
    const broken = withObligations(`broken-${String(value)}`, [obligation()], { receivedAt: value as number });
    assert.equal(receivedAtOf(broken,NOW), undefined, `${String(value)} is not a usable timestamp`);
    const rated = evaluateImportance(broken, NOW);
    assert.ok(Number.isFinite(rated.rank), 'ranking stays a real number');
    assert.equal(rated.reasonCode, 'undated-direct-request', 'the unaged rule applies');
  }
  // An unknown date must not let an old message claim to be new.
  const order = sortInboxEmails([withObligations('unknown', [obligation()], { receivedAt: undefined }), todayRequest], NOW);
  assert.equal(order[0].id, 'today', 'a message with a real recent timestamp comes first');
});

void test('a far-future arrival cannot create importance or jump ahead of real mail',()=>{
  const forged=withObligations('future',[obligation()],{receivedAt:ahead(400*DAY)});
  const recent=withObligations('recent',[obligation()],{receivedAt:ago(HOUR)});
  assert.equal(receivedAtOf(forged,NOW),undefined,'the future timestamp is not a usable arrival');
  const rated=evaluateImportance(forged,NOW);
  assert.equal(rated.important,false);
  assert.equal(rated.reasonCode,'future-received-date');
  assert.deepEqual(sortInboxEmails([forged,recent],NOW).map(item=>item.id),['recent','future']);

  const drift=withObligations('clock-drift',[obligation()],{receivedAt:ahead(IMPORTANCE.futureSkew)});
  assert.equal(evaluateImportance(drift,NOW).important,true,'the tolerance boundary remains usable');
  assert.equal(receivedAtOf({...drift,receivedAt:ahead(IMPORTANCE.futureSkew+1)},NOW),undefined,
    'one millisecond beyond the tolerance is rejected');
});

void test('a deadline earlier today is overdue, not upcoming', () => {
  const earlier = withObligations('earlier', [deadline(ago(2 * HOUR))]);
  const rated = evaluateImportance(earlier, NOW);
  assert.equal(rated.overdue, true);
  assert.equal(rated.tier, 'overdue');
});

void test('a date-only deadline is resolved with one stated timezone policy', () => {
  // Date-only deadlines end at 23:59:59Z. The last day is therefore still live all day.
  const today = obligation({ kind: 'deadline', due: { phrase: 'today', date: isoDate(NOW), ambiguous: false } });
  assert.equal(obligationDueAt(today), Date.parse(`${isoDate(NOW)}T23:59:59Z`));
  assert.equal(evaluateImportance(withObligations('date-only', [today]), NOW).important, true);
  // A November date from a previous year stays in that year; it is never rolled forward.
  const november = obligation({ kind: 'deadline', due: { phrase: 'November 12', date: '2025-11-12', ambiguous: false } });
  assert.equal(new Date(obligationDueAt(november)!).getUTCFullYear(), 2025);
  assert.equal(evaluateImportance(withObligations('november', [november]), NOW).important, false);
});

void test('a leap day and a month boundary resolve to the dates they name', () => {
  const leap = obligation({ kind: 'deadline', due: { phrase: 'Feb 29', date: '2028-02-29', ambiguous: false } });
  assert.equal(new Date(obligationDueAt(leap)!).toISOString().slice(0, 10), '2028-02-29');
  const yearEnd = obligation({ kind: 'deadline', due: { phrase: 'Dec 31', date: '2026-12-31', ambiguous: false } });
  assert.equal(new Date(obligationDueAt(yearEnd)!).toISOString().slice(0, 10), '2026-12-31');
  // An impossible date yields nothing rather than rolling into the following month.
  assert.equal(obligationDueAt(obligation({ kind: 'deadline', due: { phrase: 'Feb 30', date: '2026-02-30', ambiguous: false } })), undefined);
  assert.equal(obligationDueAt(obligation({ kind: 'deadline', due: { phrase: 'Feb 30 at 10', time: '2026-02-30T10:00:00Z', ambiguous: false } })), undefined,
    'an impossible date-time cannot roll into March');
  const offset='2026-02-28T23:00:00-05:00';
  assert.equal(obligationDueAt(obligation({ kind: 'deadline', due: { phrase: '11 pm', time: offset, ambiguous: false } })),Date.parse(offset),
    'a valid explicit offset keeps its absolute instant');
});

void test('calendar timestamps use the viewer local day and time consistently', () => {
  const previous=process.env.TZ;
  process.env.TZ='America/Los_Angeles';
  try{
    const item=withObligations('timezone',[deadline(Date.parse('2026-10-15T02:00:00Z'))]);
    assert.ok(emailDates(item).includes('2026-10-14'),'02:00Z is still October 14 in Los Angeles');
  }finally{process.env.TZ=previous;}
});

// ── Ordering ───────────────────────────────────────────────────────────────

void test('the list order follows the stated tiers and is deterministic', () => {
  const dueSoon = withObligations('due-soon', [deadline(ahead(2 * HOUR))], { receivedAt: ago(200 * DAY) });
  const dueSooner = withObligations('due-sooner', [deadline(ahead(HOUR))], { receivedAt: ago(300 * DAY) });
  const recent = withObligations('recent-ask', [obligation()], { receivedAt: ago(HOUR) });
  const overdue = withObligations('overdue', [deadline(ago(2 * DAY))], { receivedAt: ago(9 * DAY) });
  const aging = withObligations('aging', [obligation()], { receivedAt: ago(20 * DAY) });
  const routine = email('routine', { receivedAt: ago(HOUR), classification: classification({ obligations: [] }) });
  const input = [routine, aging, overdue, recent, dueSoon, dueSooner];

  const order = sortInboxEmails(input, NOW).map(item => item.id);
  // Only what needs the reader now is pinned; an older unresolved item follows newer mail.
  assert.deepEqual(order, ['due-sooner', 'due-soon', 'recent-ask', 'overdue', 'routine', 'aging']);
  assert.deepEqual(sortInboxEmails(input, NOW, 'reply').map(item => item.id),
    ['due-sooner', 'due-soon', 'recent-ask', 'overdue', 'aging', 'routine'], 'the reply tab still ranks every tier');

  // Same input in another arrangement gives the same answer.
  assert.deepEqual(sortInboxEmails([...input].reverse(), NOW).map(item => item.id), order,
    'the comparator does not depend on input order');
  // And it does not mutate what it was given.
  assert.equal(input[0].id, 'routine');
});

void test('newest-first really means newest first', () => {
  const old = withObligations('old-urgent', [deadline(ahead(HOUR))], { receivedAt: ago(300 * DAY) });
  const fresh = email('fresh-routine', { receivedAt: ago(HOUR), classification: classification({ obligations: [] }) });
  assert.deepEqual(sortInboxEmails([old, fresh], NOW, 'newest').map(item => item.id), ['fresh-routine', 'old-urgent']);
  assert.deepEqual(sortInboxEmails([old, fresh], NOW, 'importance').map(item => item.id), ['old-urgent', 'fresh-routine']);
});

void test('untimed calendar mail with an unknown arrival sorts after known arrivals',()=>{
  const unknown=email('unknown-arrival',{receivedAt:undefined});
  const known=email('known-arrival',{receivedAt:ago(DAY)});
  const future=email('future-arrival',{receivedAt:ahead(400*DAY)});
  assert.deepEqual([future,unknown,known].sort(byEventTime('2026-10-14',NOW)).map(item=>item.id),
    ['known-arrival','future-arrival','unknown-arrival'],
    'the explicit clock prevents a forged future arrival from becoming a valid tie-breaker');
});

void test('the next event uses live importance instead of a stale cached priority',()=>{
  const due=withObligations('live-due',[deadline(ahead(HOUR))],{subject:'Due today',priority:'normal',body:`Due ${isoDate(NOW)}`});
  const stale=email('stale-high',{subject:'Routine today',priority:'high',body:`Scheduled ${isoDate(NOW)}`,
    classification:classification({obligations:[]})});
  assert.equal(nextEmailEvent([stale,due],new Date(NOW))?.email.id,'live-due');
});

void test('the same message id in two accounts is ranked separately and ordered stably', () => {
  const first = withObligations('shared', [obligation()], { accountId: 'acct-1', receivedAt: ago(HOUR) });
  const second = withObligations('shared', [obligation({ state: 'completed' })], { accountId: 'acct-2', receivedAt: ago(HOUR) });
  assert.equal(evaluateImportance(first, NOW).important, true);
  assert.equal(evaluateImportance(second, NOW).important, false, 'resolving one does not resolve the other');
  const order = sortInboxEmails([second, first], NOW).map(item => `${item.accountId}:${item.id}`);
  assert.deepEqual(order, ['acct-1:shared', 'acct-2:shared'], 'both survive and sort by identity');
});

void test('a group is placed and headed by its most important message', () => {
  const routine = email('gh-routine', {
    sender: 'GitHub', address: 'noreply@github.com', subject: 'Your GitHub verification code',
    summary: 'Use this code to sign in.', receivedAt: ago(2 * DAY),
    classification: classification({ obligations: [obligation({ id: 'ask' })] }),
  });
  const urgent = email('gh-urgent', {
    sender: 'GitHub', address: 'security@github.com', subject: 'Complete your two-factor setup',
    summary: 'Finish account security setup.', receivedAt: ago(2 * HOUR),
    classification: classification({ obligations: [deadline(ahead(HOUR))] }),
  });
  const rows = buildInboxRows([routine, urgent], NOW);
  const fold = rows.find(row => row.kind === 'fold');
  assert.ok(fold && fold.kind === 'fold', 'the two operational messages folded together');
  assert.equal(fold.lead.id, 'gh-urgent', 'the group is headed by the message that earned its place');
  assert.equal(fold.emails.length, 2, 'and still contains both');
});

void test('routine operational messages from one company still fold together',()=>{
  const items=[1,2,3].map(index=>email(`code-${index}`,{
    sender:'GitHub',address:'noreply@github.com',subject:'Your GitHub verification code',
    summary:'Use this code to sign in.',receivedAt:ago((20+index)*DAY),
    classification:classification({obligations:[]}),
  }));
  assert.ok(items.every(item=>!isImportantEmail(item,NOW)),'the fixtures are routine now');
  const rows=buildInboxRows(items,NOW);
  assert.equal(rows.length,1);
  assert.equal(rows[0].kind,'fold');
  if(rows[0].kind==='fold')assert.equal(rows[0].emails.length,3);
});

// ── Before the browser clock is known ──────────────────────────────────────

void test('an unknown clock withholds urgency rather than inventing a 1970 one', () => {
  // The server render and the first client paint have no browser time. Substituting a
  // placeholder instant would date every message from 1970: a months-old request would
  // look fresh and a deadline an hour away would look distant — the exact inversion this
  // policy exists to prevent.
  const soon = withObligations('due', [deadline(ahead(HOUR))]);
  assert.equal(isImportantEmail(soon, NOW), true);
  assert.equal(isImportantEmail(novemberRequest, NOW), false);

  // Without a clock the only evidence is what the server already stored, so that is what
  // is used — provisionally, and only until the first effect supplies the real time.
  assert.equal(isImportantEmail(soon, null), false, 'nothing is claimed from a date it cannot read');
  const flagged = email('flagged', { needsReply: true, classification: undefined });
  assert.equal(isImportantEmail(flagged, null), true, 'a stored flag is still honoured');
  assert.equal(isImportantEmail({ ...flagged, category: 'noise' } as Email, null), false, 'Noise is still excluded');

  // The future-date guard now contains one half of that bad placeholder outcome, while
  // the explicit null path is still required so real deadlines are not dated from 1970.
  assert.equal(evaluateImportance(novemberRequest, 0).important, false, 'a future arrival cannot manufacture recency');
  assert.equal(evaluateImportance(soon, 0).important, false, 'and buries the genuinely urgent one');
  assert.equal(evaluateImportance(novemberRequest, NOW).important, false, 'the real clock gets both right');
  assert.equal(evaluateImportance(soon, NOW).important, true);
});

void test('an unknown clock preserves the server order instead of trusting a future date', () => {
  const oldUrgent = withObligations('old-urgent', [deadline(ahead(HOUR))], { receivedAt: ago(300 * DAY) });
  const freshRoutine = email('fresh', { receivedAt: ago(HOUR), classification: classification({ obligations: [] }) });
  const forged = email('forged',{receivedAt:ahead(400*DAY),classification:classification({obligations:[]})});
  // With a clock the live deadline wins. Without one, preserve the already validated
  // server order so a timestamp that cannot yet be checked cannot jump to the top.
  assert.deepEqual(sortInboxEmails([freshRoutine, oldUrgent], NOW).map(m => m.id), ['old-urgent', 'fresh']);
  assert.deepEqual(sortInboxEmails([freshRoutine,oldUrgent,forged],null).map(m=>m.id),
    ['fresh','old-urgent','forged']);
});

// ── Calendar extraction shares the validated date policy ───────────────────

const inviteAt = (iso: string, over: Partial<Obligation> = {}) =>
  obligation({ kind: 'meeting', meetingState: 'confirmed', due: { phrase: 'then', time: iso, ambiguous: false }, ...over });
const calendarEmail = (obligations: Obligation[], over: Partial<Email> = {}) =>
  email('cal', { classification: classification({ obligations }), body: '', ...over });

void test('the calendar refuses dates the importance policy would reject', () => {
  // 30 February is not a date. It must not reappear as 2 March on the grid.
  const impossible = calendarEmail([inviteAt('2026-02-30T10:00:00Z')]);
  assert.deepEqual(emailDates(impossible), [], 'an impossible timestamp yields no day');
  assert.equal(nextEmailEvent([impossible], new Date(NOW), false), undefined);
});

void test('cancelled and resolved work leaves the calendar', () => {
  const tomorrow = new Date(ahead(DAY)).toISOString();
  const cancelled = calendarEmail([inviteAt(tomorrow, { meetingState: 'cancelled' })]);
  const called = calendarEmail([inviteAt(tomorrow, { state: 'cancelled' })]);
  const done = calendarEmail([inviteAt(tomorrow, { state: 'completed' })]);
  for (const [label, message] of [['cancelled meeting', cancelled], ['cancelled state', called], ['completed', done]] as const)
    assert.deepEqual(emailDates(message), [], `${label} is not an upcoming event`);

  // And it cannot become the next event, alone or alongside a real one.
  const live = calendarEmail([inviteAt(new Date(ahead(2 * DAY)).toISOString())], { id: 'live' });
  assert.equal(nextEmailEvent([cancelled], new Date(NOW), false), undefined);
  assert.equal(nextEmailEvent([cancelled, live], new Date(NOW), false)?.email.id, 'live');
});

void test('a date-only obligation still appears, without the body repeating it', () => {
  const dated = calendarEmail([obligation({ kind: 'deadline', due: { phrase: 'Oct 15', date: '2026-10-15', ambiguous: false } })],
    { body: 'Nothing here names a date.' });
  const day = dateKey(new Date(2026, 9, 15));
  assert.deepEqual(emailDates(dated), [day], 'the structured date is used as written');
  assert.equal(nextEmailEvent([dated], new Date(NOW), false)?.date, day);
  // The UTC end-of-day the resolver gives it must not push it onto the following day.
  assert.equal(day, '2026-10-15');
});

void test('the next-event panel keeps legitimate long-range dates but rejects absurd ones',()=>{
  const within=calendarEmail([inviteAt(new Date(Date.UTC(2027,9,24,12)).toISOString())],{id:'within'});
  const distant=calendarEmail([inviteAt('9999-01-01T12:00:00Z')],{id:'distant'});
  assert.equal(nextEmailEvent([distant,within],new Date(NOW),false)?.email.id,'within');
  assert.equal(nextEmailEvent([distant],new Date(NOW),false),undefined);
});

void test('an email listing several times is placed by its earliest', () => {
  const later = '2026-10-14T15:00:00Z', earlier = '2026-10-14T09:00:00Z';
  // Written later-first on purpose: the order in the message must not decide the day.
  const both = calendarEmail([inviteAt(later, { id: 'pm' }), inviteAt(earlier, { id: 'am' })]);
  const day = dateKey(new Date(earlier));
  const at = new Date(earlier);
  assert.equal(eventMinutes(both, day), at.getHours() * 60 + at.getMinutes(), 'the 9 AM event decides the time');
});

void test('folding stays linear and loses nothing on a large single-sender mailbox', () => {
  const operational = (index: number) => email(`m${index}`, {
    sender: 'GitHub', address: 'noreply@github.com', subject: 'Your GitHub verification code',
    summary: 'Use this code to sign in.', receivedAt: ago(index * 1000), needsReply: true,
    classification: classification({ obligations: [] }),
  });
  const mailbox = Array.from({ length: 12000 }, (_, index) => operational(index));
  const rows = buildInboxRows(mailbox, NOW);
  assert.equal(rows.length, 1, 'one organisation collapses to one group');
  assert.equal(rows[0].kind, 'fold');
  // Every message survives; grouping must never be a way of dropping mail.
  assert.equal(rows[0].kind === 'fold' ? rows[0].emails.length : 0, 12000);
});

void test('a stale obligation cannot mask another aging but important obligation',()=>{
  const c=classification({obligations:[obligation({due:{phrase:'old',date:isoDate(ago(40*DAY)),ambiguous:false}}),
    obligation({id:'newer',due:{phrase:'recent',date:isoDate(ago(10*DAY)),ambiguous:false}})]});
  assert.equal(evaluateImportance(email('mixed',{classification:c}),NOW).important,true);
  const stale=email('stale',{classification:classification({obligations:[c.obligations[0]]})});
  assert.equal(sortInboxEmails([stale,email('mixed',{classification:c})],NOW)[0].id,'mixed');
});

void test('folds keep humans and accounts separate',()=>{
  const make=(id:string,address:string,accountId='acct-1')=>email(id,{address,accountId,subject:'Please confirm your setup'});
  for(const pair of [[make('a','alice@gmail.com'),make('b','bob@gmail.com')],
    [make('a','professor@school.edu'),make('b','it@school.edu')],
    [make('a','security@github.com'),make('b','security@github.com','acct-2')]])
    assert.ok(buildInboxRows(pair,NOW).every(row=>row.kind==='email'));
});

void test('the calendar orders a written local meeting time without inventing a timezone',()=>{
  const timed=email('clock',{classification:classification({obligations:[obligation({kind:'meeting',
    due:{phrase:'September 24 at 9:00am',date:'2026-09-24',ambiguous:true,reason:'timezone-unknown'}})]})});
  assert.equal(eventMinutes(timed,'2026-09-24'),9*60);
  assert.equal(eventMinutes(timed,'2026-09-25'),undefined);
  assert.equal(timed.classification?.obligations[0].due?.time,undefined);
});
