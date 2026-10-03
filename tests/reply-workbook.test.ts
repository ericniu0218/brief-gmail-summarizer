import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicClassify } from '../lib/deterministic';
import { interpretRecipientContext, replySentences } from '../lib/reply';
import { validateItem } from '../server/classify';
import { expectsReply, precision, recall, score, workbookMessage, workbookRows, WORKBOOK_RECIPIENT, type WorkbookRow } from './reply-workbook';

/**
 * The 100-example review workbook, run through the production fallback classifier.
 *
 * Two modes, kept apart:
 *   - message-only: exactly what production has — the email, the recipient address, the
 *     arrival time;
 *   - context-aware: the same, plus the workbook's "Recipient context" as a separate trusted
 *     input. Production has no source for that context today.
 *
 * The expected label, rationale and suggested action are never given to the classifier.
 * Every remaining disagreement is listed by ID with its reason, so a change in either
 * direction fails here and has to be looked at rather than averaged away.
 *
 * Set REPLY_REPORT=1 to print the full per-example table.
 */

function run(row: WorkbookRow, withContext: boolean) {
  return deterministicClassify(workbookMessage(row), WORKBOOK_RECIPIENT,
    withContext ? interpretRecipientContext(row.recipientContext) : undefined);
}

function evaluate(withContext: boolean) {
  const decided = new Map(workbookRows.map(row => [row.id, run(row, withContext)]));
  const predicted = new Map([...decided].map(([id, result]) => [id, result.replyRequired]));
  // Prompt versus routine, for examples both sides agree need a reply.
  const urgencyMisses = workbookRows.filter(row => expectsReply(row) && predicted.get(row.id)
    && (row.expected === 'yes') !== (decided.get(row.id)!.reply?.urgency === 'prompt')).map(row => row.id);
  if (process.env.REPLY_REPORT) {
    for (const row of workbookRows) {
      const reply = decided.get(row.id)!.reply!;
      console.log(`${withContext ? 'context' : 'message'} ${row.id} expected=${row.expected} got=${reply.status}/${reply.urgency} ${reply.reasonCode} — ${reply.explanation}`);
    }
  }
  return { decided, score: score(predicted), urgencyMisses };
}

void test('workbook, message only: no false positives; the two misses need context production lacks', () => {
  const { decided, score: result, urgencyMisses } = evaluate(false);
  assert.deepEqual(result.falsePositives, []);
  // E023: a vendor asks "are you still evaluating, or should I close the opportunity?" — a
  //   reply only because the recipient asked for this follow-up (Recipient context). From the
  //   message alone it is a sales follow-up, so it is held as uncertain for review rather
  //   than shown as a confident "no reply".
  // E095: "if you would like to join that group, reply" — an optional early-access offer. It
  //   needs a reply only because the recipient wants early access (Recipient context).
  assert.deepEqual(result.falseNegatives, ['E023', 'E095']);
  assert.equal(decided.get('E023')!.reply?.status, 'uncertain');
  assert.equal(decided.get('E023')!.processingStatus, 'needs_review');
  assert.equal(decided.get('E095')!.reply?.reasonCode, 'optional_engagement');
  assert.ok(precision(result) === 1 && recall(result) > 0.95, JSON.stringify(result));
  // E054 asks for two references with no stated deadline or blocker; the workbook rates it
  // prompt (final hiring stage), which nothing in the message itself states.
  assert.deepEqual(urgencyMisses, ['E054']);
});

void test('workbook, with trusted recipient context: every label agrees', () => {
  const { score: result, urgencyMisses } = evaluate(true);
  assert.deepEqual(result.falsePositives, []);
  assert.deepEqual(result.falseNegatives, []);
  assert.deepEqual(urgencyMisses, ['E054']);
});

void test('both workbook reply labels land in the tab, and “No” never does', () => {
  const { decided } = evaluate(true);
  for (const row of workbookRows) {
    const result = decided.get(row.id)!;
    if (row.expected === 'no') assert.equal(result.replyRequired, false, row.id);
    else assert.equal(result.replyRequired, true, `${row.id} (${row.expected})`);
  }
  // Routine replies are not promoted to prompt to make them visible.
  const routine = workbookRows.filter(row => row.expected === 'routine').map(row => decided.get(row.id)!.reply?.urgency);
  assert.ok(routine.every(urgency => urgency === 'routine'), JSON.stringify(routine));
});

void test('every decision carries evidence-grounded wording, not keyword noise', () => {
  const { decided } = evaluate(false);
  for (const [id, result] of decided) {
    const reply = result.reply!;
    assert.ok(reply.explanation.length > 10 && reply.explanation.length <= 200, id);
    assert.doesNotMatch(reply.explanation, /question mark|contains ['"“]|confidence|important sender/i, id);
    if (reply.status === 'required') assert.ok(reply.evidence && workbookRows.find(row => row.id === id)!.email.replace(/\s+/g, ' ').includes(reply.evidence.replace(/\s+/g, ' ').slice(0, 40)), id);
  }
});

void test('the classifier is not handed the answer', () => {
  // The workbook's label, rationale and suggested action never reach the message builder.
  for (const row of workbookRows.slice(0, 10)) {
    const message = workbookMessage(row);
    const seen = `${message.subject}\n${message.text}\n${message.quoted}`;
    assert.ok(!seen.includes(row.why.slice(0, 40)) && !seen.includes(row.action.slice(0, 40)), row.id);
  }
});

// ── Mocked model output through the real validation path ────────────────────
// No live model is called. Two simulated models show what the shared policy does with
// model answers: one that says "reply" whenever it sees a question or "please", and one
// that answers exactly as the workbook does.

function modelItem(row: WorkbookRow, required: boolean, evidence: string) {
  return { id: row.id, context: 'work', topics: [], disposition: 'useful', replyRequired: required, securityEvent: false, reason: 'r', summary: 's', obligations: [],
    reply: { status: required ? 'required' : 'not_required', urgency: 'unknown', channel: required ? 'email' : 'none',
      reasonCode: required ? 'information_requested' : 'no_request', evidence, explanation: 'Model answer.' } };
}
function throughValidation(claim: (row: WorkbookRow, ask: string) => boolean) {
  const predicted = new Map<string, boolean>();
  for (const row of workbookRows) {
    const message = workbookMessage(row);
    const sentences = replySentences(message.text);
    const ask = sentences.find(sentence => /\?|\bplease\b/i.test(sentence)) || '';
    const result = validateItem(modelItem(row, claim(row, ask), ask || sentences[0] || ''), message, WORKBOOK_RECIPIENT);
    assert.ok(result.ok, row.id);
    predicted.set(row.id, result.classification.replyRequired);
  }
  return score(predicted);
}

void test('mocked model: a careless “reply” is overruled where the message settles it', () => {
  const result = throughValidation((_row, ask) => !!ask);
  assert.deepEqual(result.falsePositives, [], 'portal approvals, conditional notes, offers, scams and auto-replies stay out');
  // E019 has no question or "please", so this model says no reply while the rules find a
  // handoff: the disagreement is held as uncertain. E095 is the context-dependent offer.
  assert.deepEqual(result.falseNegatives, ['E019', 'E095']);
});

void test('mocked model: answers that match the workbook are never overruled', () => {
  const result = throughValidation(row => expectsReply(row));
  assert.deepEqual([result.falsePositives, result.falseNegatives], [[], []]);
});
