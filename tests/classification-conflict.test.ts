import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveClassification, effectiveCategories, derivePriority,
  junkConflict, protectiveObligations, applyPolicy, reviewExplanation, isResolved,
  type Classification, type Obligation,
} from '../lib/classification';
import { applyOverride, type Override } from '../server/overrides';
import { selectEmails, sectionCount } from '../lib/categories';
import { isImportantEmail } from '../lib/inbox-priority';
import type { Email } from '../lib/mail';

const NOW = Date.UTC(2026, 8, 20);

const obligation = (over: Partial<Obligation> = {}): Obligation => ({
  id: 'o1', kind: 'request', description: 'Approve the invoice',
  owner: 'recipient', ownerIsUser: true, required: true,
  evidence: 'Could you approve the invoice by Friday?', state: 'open', ...over,
});

const classification = (over: Partial<Classification> = {}): Classification => ({
  context: 'work', topics: [], obligations: [], disposition: 'useful', replyRequired: false,
  securityEvent: false, processingStatus: 'classified', reason: 'r', version: 'test', ...over,
});

const junkWith = (...obligations: Obligation[]) =>
  classification({ disposition: 'junk', obligations });

const override = (over: Partial<Override> = {}): Override => ({
  messageId: 'm1', addTags: [], removeTags: [], notJunk: false, source: 'message', createdAt: 0, ...over,
});

/** Full end-to-end outcome, the way the application actually derives it. */
function outcome(input: Classification) {
  const { classification: effective, category, tags, priority } = applyPolicy(input, NOW);
  const email = { id: 'm1', category, tags, classification: effective, priority } as unknown as Email;
  return {
    disposition: effective.disposition,
    proposed: effective.proposedDisposition,
    status: effective.processingStatus,
    reviewReason: effective.reviewReason,
    category, tags, priority,
    inNoise: selectEmails([email], 'noise').length === 1,
    inInbox: selectEmails([email], 'inbox').length === 1,
    inOverview: isImportantEmail(email, NOW),
    obligations: effective.obligations,
  };
}

// ── A. Proposed junk that conflicts with a real task for the user ─────────────

void test('A: a junk prediction carrying an open request stays out of Noise', () => {
  const result = outcome(junkWith(obligation()));
  assert.equal(result.disposition, 'uncertain');
  assert.equal(result.proposed, 'junk', 'the original prediction is preserved');
  assert.equal(result.status, 'needs_review');
  assert.equal(result.reviewReason, 'junk-with-open-obligation');
  assert.equal(result.inNoise, false);
  assert.equal(result.inInbox, true);
  assert.notEqual(result.category, 'noise');
  assert.ok(!result.tags.includes('junk'));
  assert.equal(result.inOverview, true);
  // Priority tracks what the obligation says, not the review state. This request names no
  // date, so nothing is imminent and the label stays ordinary; it is Overview that keeps
  // the message in front of the user, which the assertion above already checks.
  assert.equal(result.priority, 'normal', 'review state alone does not raise priority');
});

void test('A: a payment obligation with a stated deadline survives a junk prediction', () => {
  const result = outcome(junkWith(obligation({
    kind: 'deadline', description: 'Pay invoice 4471',
    evidence: 'Payment of £420 is due on 2026-09-22.',
    due: { phrase: 'due on 2026-09-22', date: '2026-09-22', ambiguous: false },
  })));
  assert.equal(result.inNoise, false);
  assert.equal(result.inOverview, true);
  assert.ok(result.tags.includes('deadlines'));
  assert.equal(result.priority, 'high');
});

void test('A: a meeting the user must attend survives a junk prediction', () => {
  const result = outcome(junkWith(obligation({
    kind: 'meeting', meetingState: 'confirmed', description: 'Onboarding call',
    evidence: 'Your onboarding call is confirmed for Tuesday.',
  })));
  assert.equal(result.inNoise, false);
  assert.ok(result.tags.includes('meetings'));
  assert.equal(result.status, 'needs_review');
});

void test('A: the original evidence and obligations are never discarded', () => {
  const source = junkWith(obligation({ due: { phrase: 'by Friday', date: '2026-09-25', ambiguous: false } }));
  const result = outcome(source);
  assert.equal(result.obligations.length, 1);
  assert.equal(result.obligations[0].evidence, 'Could you approve the invoice by Friday?');
  assert.equal(result.obligations[0].due?.phrase, 'by Friday');
  assert.equal(result.obligations[0].ownerIsUser, true);
});

// ── B. Unclear ownership ─────────────────────────────────────────────────────

void test('B: a credible task with unclear ownership is protected but not claimed as the user’s', () => {
  const result = outcome(junkWith(obligation({ ownerIsUser: null })));
  assert.equal(result.inNoise, false);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.obligations[0].ownerIsUser, null, 'ownership is not upgraded to a confirmed assignment');
  assert.equal(result.priority, 'normal', 'unclear ownership does not earn high priority');
});

// ── C. Resolved or somebody else's work earns no protection ──────────────────

void test('C: a task assigned to somebody else does not protect a junk prediction', () => {
  const result = outcome(junkWith(obligation({ ownerIsUser: false, owner: 'Priya' })));
  assert.equal(result.inNoise, true, 'ordinary junk policy continues');
  assert.equal(result.disposition, 'junk');
});

void test('C: completed and superseded tasks do not protect a junk prediction', () => {
  for (const state of ['completed', 'superseded'] as const) {
    const result = outcome(junkWith(obligation({ state })));
    assert.equal(result.inNoise, true, `${state} must not trigger protection`);
  }
});

void test('C: a cancelled meeting does not protect, even with inconsistent state fields', () => {
  // state left open while meetingState says cancelled: the inconsistency must not revive it.
  const inconsistent = obligation({ kind: 'meeting', state: 'open', meetingState: 'cancelled' });
  assert.equal(isResolved(inconsistent), true, 'both state fields are consulted');
  assert.equal(outcome(junkWith(inconsistent)).inNoise, true);
  assert.equal(outcome(junkWith(obligation({ kind: 'meeting', state: 'cancelled', meetingState: 'cancelled' }))).inNoise, true);
});

// ── D. Promotional pressure is not an obligation ─────────────────────────────

void test('D: an optional promotional invitation does not protect a junk prediction', () => {
  const result = outcome(junkWith(obligation({ required: false, description: 'Join our webinar' })));
  assert.equal(result.inNoise, true);
  assert.equal(protectiveObligations(junkWith(obligation({ required: false }))).length, 0);
});

void test('D: a sales countdown does not become a personal deadline', () => {
  const countdown = junkWith(obligation({
    kind: 'deadline', required: false, description: 'Sale ends Friday',
    evidence: 'Sale ends Friday — buy now!',
    due: { phrase: 'Friday', date: '2026-09-25', ambiguous: false },
  }));
  assert.equal(outcome(countdown).inNoise, true);
});

void test('D: an obligation with no grounded evidence does not protect', () => {
  assert.equal(outcome(junkWith(obligation({ evidence: '   ' }))).inNoise, true);
});

// ── E/F/G. Explicit user intent ──────────────────────────────────────────────

void test('E: an explicit user move to Noise is honoured even against an open obligation', () => {
  const corrected = applyOverride(junkWith(obligation()), override({ category: 'noise' }));
  const result = outcome(corrected);
  assert.equal(result.inNoise, true, 'the user decided, so protection steps aside');
  assert.equal(junkConflict(corrected), undefined);
  assert.equal(corrected.override?.category, 'noise', 'the deliberate choice is recorded, not inferred');
});

void test('F: a not-junk correction keeps the message out of Noise through later syncs', () => {
  const corrected = applyOverride(junkWith(obligation()), override({ notJunk: true }));
  assert.equal(outcome(corrected).inNoise, false);
  // Re-applying the same correction to an already-protected classification is stable.
  const again = applyOverride(effectiveClassification(corrected), override({ notJunk: true }));
  assert.equal(outcome(again).inNoise, false);
  assert.equal(again.disposition, 'useful');
});

void test('G: an unrelated tag correction does not resolve the junk conflict', () => {
  const corrected = applyOverride(junkWith(obligation()), override({ addTags: ['research'] }));
  const result = outcome(corrected);
  assert.equal(result.inNoise, false, 'adding a tag is not permission to hide the message');
  assert.equal(result.status, 'needs_review', 'the conflict is still unresolved');
  assert.ok(result.tags.includes('research'), 'the requested tag is still applied');
});

void test('G: an override without an explicit section does not bypass protection', () => {
  const corrected = applyOverride(junkWith(obligation()), override({ addTags: ['deadlines'] }));
  assert.equal(junkConflict(corrected), 'junk-with-open-obligation');
});

// ── Security events ──────────────────────────────────────────────────────────

void test('a suspected security message is protected without being called genuine', () => {
  const suspect = classification({ disposition: 'junk', securityEvent: true });
  const result = outcome(suspect);
  assert.equal(result.inNoise, false);
  assert.equal(result.reviewReason, 'junk-with-security-event');
  const text = reviewExplanation(effectiveClassification(suspect))!;
  assert.match(text, /not been checked/i, 'the wording must not assert authenticity');
});

// ── Caches, fallbacks and repeated application ───────────────────────────────

void test('a cached conflicting classification is protected when it is read back', () => {
  // Simulates a snapshot stored before the policy existed: junk, with a live obligation.
  const stored = junkWith(obligation());
  assert.equal(effectiveCategories(stored).category !== 'noise', true, 'reading repairs it without another AI call');
  assert.equal(outcome(stored).status, 'needs_review');
});

void test('a deterministic fallback after AI failure is protected the same way', () => {
  const fallback = classification({
    disposition: 'junk', processingStatus: 'needs_review', uncertainty: 'provider-unavailable',
    obligations: [obligation()],
  });
  const result = outcome(fallback);
  assert.equal(result.inNoise, false);
  assert.equal(result.reviewReason, 'junk-with-open-obligation');
});

void test('applying the policy repeatedly changes nothing', () => {
  const once = effectiveClassification(junkWith(obligation()));
  const twice = effectiveClassification(once);
  const thrice = effectiveClassification(twice);
  assert.deepEqual(twice, once, 'idempotent');
  assert.deepEqual(thrice, once);
  assert.equal(twice.obligations.length, 1, 'obligations are not duplicated');
  assert.equal(twice.proposedDisposition, 'junk', 'the original prediction does not drift');
  assert.equal(twice, once, 'an already-settled classification is returned unchanged');
});

void test('protection is released once the obligation is resolved', () => {
  const protectedOnce = effectiveClassification(junkWith(obligation()));
  assert.equal(protectedOnce.disposition, 'uncertain');
  // The user marks the task done; the classifier's own proposal resumes.
  const resolved = effectiveClassification({
    ...protectedOnce,
    obligations: protectedOnce.obligations.map(o => ({ ...o, state: 'completed' as const })),
  });
  assert.equal(resolved.disposition, 'junk');
  assert.equal(resolved.proposedDisposition, undefined);
  assert.equal(resolved.reviewReason, undefined);
  assert.equal(effectiveCategories(resolved).category, 'noise');
});

// ── Counts and visibility ────────────────────────────────────────────────────

void test('a protected message is counted in its effective section, not in Noise', () => {
  const { category, tags, classification: effective } = applyPolicy(junkWith(obligation()), NOW);
  const email = { id: 'm1', category, tags, classification: effective } as unknown as Email;
  const noise = { id: 'm2', category: 'noise', tags: ['junk'] } as unknown as Email;
  const emails = [email, noise];
  assert.equal(sectionCount(emails, 'noise'), 1, 'only the genuine junk counts toward Noise');
  assert.equal(sectionCount(emails, category), 1);
  assert.equal(selectEmails(emails, 'inbox').length, 2, 'Inbox still shows everything');
});

void test('review status alone does not imply urgency', () => {
  // A protected message whose obligation carries no deadline and no direct request.
  const quiet = junkWith(obligation({ kind: 'action', ownerIsUser: null }));
  const result = outcome(quiet);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.priority, 'normal');
});

void test('a quoted historical request does not by itself protect a junk prediction', () => {
  // Nothing extracted from the live message means nothing to protect.
  const quotedOnly = classification({ disposition: 'junk', obligations: [] });
  assert.equal(outcome(quotedOnly).inNoise, true);
});

void test('derivePriority and Overview agree with the effective classification', () => {
  // Priority is earned by a date, never by a request existing: an undated request stays
  // ordinary no matter how long it waits, which is what stops old mail being permanently
  // urgent. A live due date is what makes this one high.
  const soon = { phrase: 'tomorrow', date: '2026-09-21', ambiguous: false };
  const conflicted = junkWith(obligation({ due: soon }));
  assert.equal(derivePriority(conflicted, NOW), 'high');
  assert.equal(outcome(conflicted).inOverview, true);
  assert.equal(derivePriority(junkWith(obligation()), NOW), 'normal', 'an undated request is not urgent by itself');
  const genuine = junkWith(obligation({ ownerIsUser: false, due: soon }));
  assert.equal(derivePriority(genuine, NOW), 'normal');
  assert.equal(outcome(genuine).inOverview, false);
});

// ── End-to-end through the real message pipeline ─────────────────────────────

void test('a Gmail message predicted junk with a real request is built as visible mail', async () => {
  const { emailFrom } = await import('../server/gmail');
  const { normalizeMessage } = await import('../server/message');
  const { encode } = await import('../server/runtime');
  const message = normalizeMessage({
    id: 'live', threadId: 't', snippet: '', internalDate: String(NOW), labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'From', value: 'Billing <billing@vendor.example>' }, { name: 'Subject', value: 'Invoice 4471' }],
      body: { data: encode('Could you approve the invoice by Friday?') },
    },
  });
  const email = emailFrom(message, junkWith(obligation()), NOW);
  assert.notEqual(email.category, 'noise', 'the built email must not be filed under Noise');
  assert.ok(!(email.tags || []).includes('junk'));
  assert.equal(email.classification?.processingStatus, 'needs_review');
  assert.equal(email.classification?.proposedDisposition, 'junk');
  // The request names no resolvable date, so it is ordinary Work rather than urgent. The
  // point of this test is that it was built as visible mail at all.
  assert.equal(email.label, 'Work');
  assert.equal(isImportantEmail(email, NOW), true, 'the dashboard shows it in Overview');
  // A genuine junk message with nobody's obligation still lands in Noise.
  const genuine = emailFrom(message, junkWith(obligation({ ownerIsUser: false })), NOW);
  assert.equal(genuine.category, 'noise');
  assert.equal(genuine.label, 'Junk');
});
