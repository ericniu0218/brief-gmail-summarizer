import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferralMessage, syncFailureMessage, type InboxSnapshot } from '../lib/inbox-client';

/** A mailbox skipped for a harmless reason is a status, never a warning; a real failure still warns. */

const snapshot = (over: Partial<InboxSnapshot>): InboxSnapshot => ({ emails: [], updated: 1, ai: false, ...over }) as InboxSnapshot;

void test('a skipped mailbox reads as finishing, not as a failure', () => {
  const skipped = snapshot({ refreshed: 1, failed: 0, failures: [], deferred: [{ accountId: 'a', email: 'me@gmail.example', reason: 'busy' }] });
  assert.equal(syncFailureMessage(skipped), '');
  assert.equal(deferralMessage(skipped), 'Finishing me@gmail.example in the background…');
  assert.equal(deferralMessage(snapshot({ refreshed: 2, failed: 0 })), '', 'nothing skipped, nothing to say');
});

void test('a real failure still warns', () => {
  const broken = snapshot({ refreshed: 1, failed: 1, failures: [{ accountId: 'a', email: 'me@gmail.example', error: 'Your Gmail connection needs to be renewed.' }] });
  assert.match(syncFailureMessage(broken), /Some mail could not be refreshed \(me@gmail\.example\)/);
});
