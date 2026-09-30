import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDate, weekdayOffset, inferYear } from '../lib/dates';
import { deterministicClassify, type ClassifiableMessage } from '../lib/deterministic';
import { emailDates, nextEmailEvent } from '../lib/calendar';
import { applyPolicy } from '../lib/classification';
import { evaluateImportance } from '../lib/importance';
import { validateItem, withPurpose } from '../server/classify';
import { htmlToText, normalizeMessage, parseCalendar, type NormalizedMessage } from '../server/message';
import { normalizeEmailText } from '../lib/email-text';
import { isCommercialSentence } from '../lib/purpose';
import { polishReply, replyOptions, SAMPLE_SIGNER } from '../server/ai';
import { replyAddress } from '../lib/reply-address';
import { readFileSync } from 'node:fs';
import type { Email } from '../lib/mail';

/**
 * Regressions for the defects found by the 2026-09-29 read-only audit. Each test states
 * the case that failed; the audit's own reproductions are the source of every input.
 */

const DAY = 86400000;
const USER = 'me@uni.edu';

type Mail = Partial<Omit<ClassifiableMessage, 'from'>> & { subject: string; text: string; from?: string };
function message(id: string, over: Mail): ClassifiableMessage {
  const from = over.from || 'dana@uni.edu';
  return { id, subject: over.subject, text: over.text, quoted: over.quoted || '',
    from: { name: from.split('@')[0], address: from }, to: over.to || [{ address: USER }], cc: over.cc || [],
    receivedAt: over.receivedAt ?? Date.UTC(2026, 8, 28, 9), labels: over.labels || ['INBOX'],
    attachments: over.attachments || [], contentComplete: over.contentComplete ?? true,
    calendar: over.calendar, distribution: over.distribution };
}

// ── Section 4: dates ─────────────────────────────────────────────────────────

void test('“tomorrow” resolves on every day of the year, including month ends', () => {
  for (let day = Date.UTC(2026, 0, 1, 12); day < Date.UTC(2027, 0, 1); day += DAY) {
    const expected = new Date(day + DAY).toISOString().slice(0, 10);
    const resolved = resolveDate('tomorrow', day);
    assert.equal(resolved.date, expected, new Date(day).toISOString());
    assert.equal(resolved.ambiguous, false);
  }
  // Tuesday 29 September: Friday is 2 October.
  assert.equal(resolveDate('Friday', Date.UTC(2026, 8, 29, 9)).date, '2026-10-02');
});

void test('“this Friday” on a Friday is today; a bare or “next” Friday is the coming one', () => {
  const friday = Date.UTC(2026, 8, 11, 9);
  assert.equal(resolveDate('this Friday', friday).date, '2026-09-11');
  assert.equal(resolveDate('Friday', friday).date, '2026-09-18');
  assert.equal(resolveDate('next Friday', friday).date, '2026-09-18');
  assert.equal(weekdayOffset('this friday', 5), 0);
  assert.equal(weekdayOffset('this monday', 5), 3, '“this Monday” said on a Friday is never in the past');
  assert.equal(weekdayOffset('birthday', 5), undefined);
});

void test('a date without a year rolls over at New Year and is uncertain when it could be either', () => {
  const newYearsEve = Date.UTC(2026, 11, 31, 9);
  assert.deepEqual(resolveDate('January 2', newYearsEve), { phrase: 'January 2', date: '2027-01-02', ambiguous: false });
  assert.equal(resolveDate('December 20', newYearsEve).date, '2026-12-20', 'a recent date keeps its year');
  const july = Date.UTC(2026, 6, 1, 9);
  const either = resolveDate('February 3', july);
  assert.equal(either.ambiguous, true);
  assert.equal(either.reason, 'year-uncertain');
  assert.deepEqual(inferYear(0, 2, newYearsEve), { year: 2027, uncertain: false });
  // The calendar applies the same rule.
  const mail = { id: 'nye', subject: 'Deadline', body: 'Forms are due January 2.', receivedAt: newYearsEve } as Email;
  assert.deepEqual(emailDates(mail), ['2027-01-02']);
});

void test('impossible 12-hour clock values are refused', () => {
  const received = Date.UTC(2026, 8, 1, 9);
  for (const phrase of ['September 30 at 13pm UTC', 'September 30 at 0am UTC']) {
    const resolved = resolveDate(phrase, received);
    assert.equal(resolved.ambiguous, true, phrase);
    assert.equal(resolved.time, undefined, phrase);
    assert.equal(resolved.reason, 'invalid-time', phrase);
  }
  assert.equal(resolveDate('September 30 at 12am UTC', received).time, '2026-09-30T00:00:00Z');
  assert.equal(resolveDate('September 30 at 21:15 UTC', received).time, '2026-09-30T21:15:00Z');
});

void test('an extracted date keeps its clock and timezone, and a birthday is not a weekday', () => {
  const received = Date.UTC(2026, 8, 28, 9); // Monday
  const dueOf = (text: string) => deterministicClassify(message('d', { subject: 'Upcoming meeting', text, receivedAt: received }), USER)
    .obligations.find((o) => o.kind === 'meeting')?.due;
  const wednesday = dueOf('The meeting is Wednesday at 9am UTC.');
  assert.equal(wednesday?.time, '2026-09-30T09:00:00Z');
  assert.equal(wednesday?.timezone, 'UTC');
  assert.equal(dueOf('The meeting is September 30 at 09:00 UTC.')?.time, '2026-09-30T09:00:00Z');
  const birthday = dueOf('The meeting is on my birthday, Thursday at 3pm UTC.');
  assert.equal(birthday?.time, '2026-10-01T15:00:00Z');
});

// ── Section 5: rule-based obligations and promotions ────────────────────────

const NOW = Date.UTC(2026, 8, 29, 12);
const probe = (subject: string, text: string, extra: Partial<ClassifiableMessage> = {}) =>
  ({ ...message('m', { subject, text, receivedAt: NOW, from: 'person@client.example' }), ...extra });
function rated(msg: ClassifiableMessage) {
  const classification = deterministicClassify(msg, USER);
  const policy = applyPolicy(classification, NOW);
  const email = { ...msg, body: msg.text, address: msg.from.address, ...policy, needsReply: classification.replyRequired } as unknown as Email;
  return { classification, category: policy.category, important: evaluateImportance(email, NOW).important };
}

void test('a real task after an optional one of the same kind is still found', () => {
  const request = rated(probe('Register for our product webinar',
    'Please confirm your place by September 30. Join our Zoom session to see the new platform. Could you review the attached client contract by September 30?'));
  const contract = request.classification.obligations.find((o) => /client contract/.test(o.evidence));
  assert.ok(contract, 'the contract request is extracted');
  assert.equal(contract.required, true);
  assert.equal(request.classification.replyRequired, true);

  const deadline = rated(probe('Two updates', 'Optional applications are due September 30. Your tax filing is due October 1.'));
  const tax = deadline.classification.obligations.find((o) => /tax filing/.test(o.evidence));
  assert.ok(tax, 'the tax deadline is extracted');
  assert.equal(tax.required, true);
  assert.equal(tax.due?.date, '2026-10-01');
  assert.equal(deadline.important, true);
});

void test('one meeting described in several sentences stays one meeting', () => {
  const one = deterministicClassify(probe('Team meeting',
    'Our team meeting is tomorrow at 3pm UTC. The meeting will be on Zoom. Join the Zoom meeting with the link below.'), USER);
  assert.equal(one.obligations.filter((o) => o.kind === 'meeting').length, 1);
  const courtesy = deterministicClassify(probe('Notes', 'Here are the notes from today. Let me know if you have any questions.'), USER);
  assert.equal(courtesy.obligations.length, 0, 'a closing courtesy is not a request');
});

void test('optional wording in one sentence does not demote a task in another', () => {
  const mixed = rated(probe('Work and community',
    'Please review the incident report by September 30. Applications are open for the volunteer board.'));
  const report = mixed.classification.obligations.find((o) => /incident report/.test(o.evidence));
  assert.equal(report?.required, true);
  assert.equal(mixed.important, true);
});

void test('a cancellation of another event does not cancel this meeting', () => {
  const dentist = rated(probe('Upcoming meeting',
    'Your dentist appointment is confirmed for September 30 at 9am UTC. The optional webinar has been cancelled.'));
  const appointment = dentist.classification.obligations.find((o) => o.kind === 'meeting');
  assert.equal(appointment?.meetingState, 'confirmed');
  assert.equal(dentist.important, true);
  const cancelled = deterministicClassify(probe('Meeting cancelled', 'Our meeting on September 30 at 9am UTC has been cancelled.'), USER);
  assert.equal(cancelled.obligations.find((o) => o.kind === 'meeting')?.meetingState, 'cancelled', 'its own cancellation still counts');
});

void test('“please review” and “please submit” do not turn a campaign into work', () => {
  for (const [subject, text] of [['50% off this week', 'Please review our exclusive offers and shop now for 50% off. Unsubscribe.'],
    ['Claim your discount', 'Please submit your email to unlock exclusive discounts. Shop now. Sale ends tonight.']]) {
    const result = rated(probe(subject, text));
    assert.equal(result.important, false, subject);
    assert.notEqual(result.category, 'work', subject);
    assert.equal(result.classification.replyRequired, false, subject);
  }
  // A genuine review request beside campaign copy is still work.
  assert.equal(deterministicClassify(probe('Contract', 'Please review the attached contract today. Our sale is 30% off, shop now.'), USER)
    .obligations.some((o) => o.kind === 'request' && o.required), true);
});

const padiText = readFileSync('tests/fixtures/padi-certification.txt', 'utf8');
const padiMessage = normalizeMessage({ id: 'padi', threadId: 'padi', snippet: '', internalDate: String(NOW), labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
  payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Ethan, Congratulations on Your New PADI Dive Certification!' },
    { name: 'From', value: 'padi@padi-mail.com' }, { name: 'To', value: 'diver@example.com' }],
  body: { data: Buffer.from(padiText).toString('base64url') } } });

void test('a coupon expiry does not become a deadline of today', () => {
  const fallback = deterministicClassify(padiMessage, 'diver@example.com');
  assert.equal(fallback.obligations.filter((o) => o.kind === 'deadline').length, 0, '“code expires 30 days from sign-up” borrows no date');
  assert.notEqual(fallback.context, 'work', 'nothing invented makes it work mail');
});

void test('an expiry counted from an undated event borrows no other sentence’s date', () => {
  const access = deterministicClassify(probe('Your access', 'Your access expires 30 days after activation. The workshop is on October 5.'), USER);
  assert.equal(access.obligations.filter((o) => o.kind === 'deadline').length, 0);
});

void test('an earned certification is kept out of Junk even inside a promotion', () => {
  const baseline = { context: 'personal' as const, topics: [], obligations: [], disposition: 'junk' as const, replyRequired: false,
    securityEvent: false, processingStatus: 'classified' as const, reason: 'Bulk promotion.', version: 'test' };
  const checked = withPurpose(baseline, padiMessage, 'diver@example.com');
  assert.match(checked.preservedEvidence || '', /Enriched Air Diver certification/);
  const policy = applyPolicy(checked, NOW);
  assert.notEqual(policy.category, 'noise', 'a model’s Junk proposal is held for review instead');
  assert.equal(policy.classification.reviewReason, 'junk-with-personal-record');
  assert.equal(evaluateImportance({ id: 'padi', subject: '', classification: checked, receivedAt: NOW } as unknown as Email, NOW).important, false,
    'but it does not become Important');
  // Congratulations on a purchase is not an achievement.
  assert.equal(withPurpose(baseline, { ...padiMessage, subject: 'Thanks!', text: 'Congratulations on completing your order! Shop now for 20% off.' },
    'diver@example.com').preservedEvidence, undefined);
});

// ── Section 6: calendar and importance ───────────────────────────────────────

function invite(ics: string, filename = '') {
  return normalizeMessage({ id: 'invite', threadId: 'thread', snippet: 'Invitation', internalDate: String(NOW), labelIds: ['INBOX'],
    payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Sender <team@client.example>' }, { name: 'To', value: USER },
      { name: 'Subject', value: 'Invitation' }],
    parts: [{ mimeType: 'text/calendar', filename, body: { data: Buffer.from(ics).toString('base64url'), size: ics.length } }] } });
}
const vevent = (start: string) =>
  `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Project review\r\n${start}\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const meetingOf = (m: ReturnType<typeof invite>) => deterministicClassify(m, USER).obligations.find((o) => o.kind === 'meeting');

void test('calendar invitations are read in the formats calendar files actually use', () => {
  assert.equal(meetingOf(invite(vevent('DTSTART:20260930T090000Z')))?.due?.time, '2026-09-30T09:00:00.000Z');
  // 9:00 in Los Angeles in September is 16:00 UTC.
  assert.equal(meetingOf(invite(vevent('DTSTART;TZID=America/Los_Angeles:20260930T090000')))?.due?.time, '2026-09-30T16:00:00.000Z');
  assert.equal(meetingOf(invite(vevent('DTSTART;TZID="America/New_York":20260115T090000')))?.due?.time, '2026-01-15T14:00:00.000Z',
    'standard time applies in January');
  const named = invite(vevent('DTSTART:20260930T090000Z'), 'invite.ics');
  assert.equal(named.attachments.length, 0, 'a named invitation is read, not listed as an unread file');
  assert.equal(meetingOf(named)?.due?.time, '2026-09-30T09:00:00.000Z');
  const allDay = meetingOf(invite(vevent('DTSTART;VALUE=DATE:20260930')));
  assert.deepEqual(allDay?.due, { phrase: '2026-09-30', date: '2026-09-30', ambiguous: false });
  const floating = meetingOf(invite(vevent('DTSTART:20260930T090000')));
  assert.equal(floating?.due?.date, '2026-09-30');
  assert.equal(floating?.due?.reason, 'timezone-unknown', 'no zone, no invented instant');
});

void test('a VTIMEZONE block before the event does not supply its start', () => {
  const ics = 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:America/Los_Angeles\r\nBEGIN:STANDARD\r\nDTSTART:19701101T020000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n'
    + 'BEGIN:VEVENT\r\nUID:two\r\nSUMMARY:Planning\r\nDTSTART;TZID=America/Los_Angeles:20260930T090000\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.equal(invite(ics).calendar?.start, '2026-09-30T16:00:00Z');
});

void test('a cancelled meeting does not come back through the calendar’s text scan', () => {
  const body = 'Our meeting on September 30 at 9am UTC has been cancelled.';
  const classification = deterministicClassify(probe('Meeting cancelled', body), USER);
  const email = { id: 'cancelled', subject: 'Meeting cancelled', body, receivedAt: NOW, address: 'team@example.com', category: 'work', classification } as unknown as Email;
  assert.deepEqual(emailDates(email, undefined, NOW), []);
  assert.equal(nextEmailEvent([email], new Date(NOW)), undefined);
  // A live event in another sentence of the same message is still found.
  const mixed = { ...email, body: `${body} The review on October 5 goes ahead.` } as Email;
  assert.deepEqual(emailDates(mixed, undefined, NOW), ['2026-10-05']);
});

void test('an appointment tomorrow stays Important when its timezone is unknown', () => {
  const july = Date.UTC(2026, 6, 1);
  const msg = probe('Conference date', 'Your appointment is confirmed for September 30 at 9am.', { receivedAt: july });
  const classification = deterministicClassify(msg, USER);
  const due = classification.obligations.find((o) => o.kind === 'meeting')?.due;
  assert.equal(due?.reason, 'timezone-unknown', 'the instant is still not claimed');
  const email = { ...msg, body: msg.text, classification } as unknown as Email;
  assert.equal(evaluateImportance(email, NOW).important, true);
  assert.equal(evaluateImportance(email, Date.UTC(2026, 9, 3)).important, false, 'and it passes like any meeting');
});

// ── Section 7: model result validation ───────────────────────────────────────

const normalizedProbe = (subject: string, text: string, quoted = '') =>
  ({ ...probe(subject, text), quoted, threadId: 't', signature: '', headers: {}, messageId: '', labels: ['INBOX'], attachments: [],
    htmlOnly: false, incompleteReasons: [] }) as unknown as NormalizedMessage;
const modelRequest = (evidence: string, datePhrase: string) => ({ id: 'm', context: 'work', topics: [], disposition: 'useful',
  replyRequired: true, securityEvent: false, summary: 'Review', reason: 'Request', obligations: [{ kind: 'request', description: 'Review',
    evidence, required: true, owner: 'recipient', ownerIsUser: 'yes', state: 'open', datePhrase }] });

void test('a request found only in quoted history is not revived as current work', () => {
  const result = validateItem(modelRequest('Please review the report by September 30.', 'September 30'),
    normalizedProbe('Thanks, this is finished.', 'The task is complete.', 'Please review the report by September 30.'), USER);
  assert.ok(result.ok);
  const [task] = result.classification.obligations;
  assert.equal(task.required, false);
  assert.equal(result.classification.replyRequired, false);
  assert.equal(result.classification.processingStatus, 'needs_review');
  assert.equal(result.classification.uncertainty, 'quoted-history-obligation');
  // The same words in the current message are an ordinary request.
  const current = validateItem(modelRequest('Please review the report by September 30.', 'September 30'),
    normalizedProbe('Report', 'Please review the report by September 30.'), USER);
  assert.ok(current.ok);
  assert.equal(current.classification.obligations[0].required, true);
  assert.equal(current.classification.obligations[0].due?.date, '2026-09-30');
});

void test('a model cannot give a task the date of an unrelated sale', () => {
  const sale = validateItem(modelRequest('Please review the report.', 'September 30'),
    normalizedProbe('Two unrelated updates', 'Please review the report. Shop now for 50% off until September 30.'), USER);
  assert.ok(sale.ok);
  assert.equal(sale.classification.obligations[0].due, undefined);
  // A date stated in the neighbouring, non-commercial sentence still belongs to the task.
  const beside = validateItem(modelRequest('Please send it to me.', 'Friday'),
    normalizedProbe('Report', 'The report is due Friday. Please send it to me.'), USER);
  assert.ok(beside.ok);
  assert.equal(beside.classification.obligations[0].due?.date, '2026-10-02');
});

// ── Section 8: malformed HTML ────────────────────────────────────────────────

void test('malformed HTML is converted in time proportional to its size', () => {
  // Each of these took seconds, or never finished, when every unmatched `<` rescanned the rest.
  const inputs = ['<'.repeat(300_000), '<script>'.repeat(100_000), '<title>'.repeat(100_000), '<!--'.repeat(100_000),
    '<a href="https://x.example/a">'.repeat(30_000)];
  for (const html of inputs) {
    const started = performance.now();
    normalizeMessage({ id: 'm', threadId: 't', internalDate: '1', snippet: '', labelIds: [],
      payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } } });
    assert.ok(performance.now() - started < 1500, `${html.slice(0, 12)}… took ${Math.round(performance.now() - started)}ms`);
  }
  const started = performance.now();
  normalizeEmailText(' '.repeat(500_000) + 'x');
  assert.ok(performance.now() - started < 500, 'a long run of spaces before text is trimmed in linear time');
});

void test('ordinary HTML still reads the same', () => {
  assert.equal(htmlToText('<p>Hello <b>there</b></p><p>Second&nbsp;line</p>'), 'Hello there\nSecond line');
  assert.equal(htmlToText('See <a href="https://ex.example/doc?a=1&amp;b=2">the doc</a>.'), 'See the doc (https://ex.example/doc?a=1&b=2).');
  assert.equal(htmlToText('<a href="javascript:alert(1)">Click</a>'), 'Click');
  assert.equal(htmlToText('<head><style>p{color:red}</style></head><script>x()</script>Visible<ul><li>One</li><li>Two</li></ul>'), 'Visible\n- One\n\n- Two', 'unchanged from the previous converter');
  assert.equal(htmlToText('a < b and c > d'), 'a d');
  assert.equal(htmlToText('Start <!-- hidden --> end'), 'Start end');
  assert.equal(htmlToText('<A HREF="https://x.example">Upper</A><BR>Next<SCRIPT>bad()</SCRIPT>'), 'Upper (https://x.example)\nNext');
});

// ── Section 9: reply identity and addresses ──────────────────────────────────

void test('replies for a connected mailbox are never signed with somebody else’s name', async () => {
  const instructions: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(init?.body as string) as { systemInstruction: { parts: { text: string }[] }; generationConfig: { responseJsonSchema: { properties: Record<string, unknown> } } };
    instructions.push(request.systemInstruction.parts[0].text);
    const output = request.generationConfig.responseJsonSchema.properties.options ? { options: ['a', 'b', 'c'] } : { reply: 'reply' };
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output) }] } }] });
  }) as typeof fetch;
  try {
    const email = { id: 'e', subject: 'Proposal', body: 'Please review the proposal.', sender: 'Client' } as Email;
    const env = { GEMINI_API_KEY: 'fake' } as never;
    await replyOptions(email, 'Concise', 0, env);
    await polishReply(email, 'I will review it.', 'Concise', env);
    await replyOptions(email, 'Concise', 0, env, SAMPLE_SIGNER);
    assert.ok(!instructions[0].includes('Alex') && !instructions[1].includes('Alex'), 'connected replies carry no invented name');
    assert.match(instructions[0], /no name/);
    assert.match(instructions[2], /signed as Alex/, 'the sample inbox keeps its persona');
  } finally { globalThis.fetch = original; }
});

void test('international reply addresses are accepted and nothing that could inject a header is', () => {
  assert.equal(replyAddress([], 'josé@correo.example'), 'josé@correo.example');
  assert.equal(replyAddress([], 'user@münchen.de'), 'user@xn--mnchen-3ya.de');
  assert.equal(replyAddress([], 'user@example.xn--p1ai'), 'user@example.xn--p1ai');
  assert.equal(replyAddress([{ name: 'Reply-To', value: '"Ana" <ana@例え.jp>' }], 'from@example.com'), 'ana@xn--r8jz45g.jp');
  for (const bad of ['a b@example.com', 'a@b@example.com', 'a,b@example.com', 'a@example', 'a@exa mple.com', 'a\r\nBcc: x@y.com@example.com', '<a>@example.com', '.a@example.com'])
    assert.equal(replyAddress([], bad), undefined, JSON.stringify(bad));
});

// ── Second review pass ───────────────────────────────────────────────────────

void test('“last Friday” is the past, not the coming Friday', () => {
  assert.equal(resolveDate('last Friday', NOW).reason, 'past-reference');
  assert.equal(resolveDate('this past Friday', NOW).date, undefined);
  const recap = deterministicClassify(probe('Recap', 'Thanks for meeting with me last Friday.'), USER);
  assert.ok(!recap.obligations.some((o) => o.due?.date), 'a recap creates no future meeting');
  const mail = { id: 'r', subject: 'Recap', body: 'We met this past Friday.', receivedAt: NOW } as Email;
  assert.deepEqual(emailDates(mail, undefined, NOW), []);
});

void test('a quoted TZID containing a colon does not corrupt the start', () => {
  const start = parseCalendar('BEGIN:VEVENT\r\nDTSTART;TZID="(UTC-08:00) Pacific Time (US & Canada)":20260930T090000\r\nSUMMARY:x\r\nEND:VEVENT')?.start;
  assert.equal(start, '2026-09-30T09:00:00', 'an unknown zone keeps the written day and time, with no zone');
});

void test('removing a cancelled event from the calendar keeps a live one on a bare weekday', () => {
  const classification = { obligations: [{ kind: 'meeting', state: 'cancelled', meetingState: 'cancelled', required: true,
    evidence: 'The Friday lunch is cancelled.', due: { phrase: 'Friday', date: '2026-10-02', ambiguous: false } }] };
  const mail = { id: 'e', subject: 'Updates', body: 'The Friday lunch is cancelled. Board review Friday as planned.', receivedAt: NOW, classification } as unknown as Email;
  assert.deepEqual(emailDates(mail, undefined, NOW), ['2026-10-02']);
});

void test('a real review task keeps its place beside sales copy in the same sentence', () => {
  assert.equal(isCommercialSentence('Please review the sales report today, shop now for 30% off.'), false);
  assert.equal(isCommercialSentence('Please review our exclusive offers and shop now for 50% off.'), true);
  assert.equal(isCommercialSentence('Please submit your email to unlock exclusive discounts.'), true);
  assert.equal(isCommercialSentence('Please submit your timesheet to get paid, and shop now for 20% off.'), false);
});
