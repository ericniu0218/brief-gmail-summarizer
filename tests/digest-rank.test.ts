import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digestItems, DIGEST_SHOWN } from '../lib/digest';
import { fromPerson, isBlast } from '../lib/digest-rank';
import { EMPTY_CLASSIFICATION, type Classification, type Obligation } from '../lib/classification';
import type { Email } from '../lib/mail';

/**
 * The brief keeps the few important emails that matter most: people the reader writes to,
 * work, and what is due soon, above system notices, routine codes and mass mailings.
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 3, 16);
const READER = 'reader@school.edu';
const request = (over: Partial<Obligation> = {}): Obligation => ({ id: 'o', kind: 'request', description: 'Do it', owner: 'recipient',
  ownerIsUser: true, required: true, evidence: 'Please do it.', state: 'open', ...over });
const dueToday = request({ kind: 'deadline', due: { phrase: 'today', date: new Date(NOW).toISOString().slice(0, 10), ambiguous: false } });
const classify = (obligations: Obligation[], over: Partial<Classification> = {}): Classification =>
  ({ ...EMPTY_CLASSIFICATION, context: 'work', disposition: 'useful', processingStatus: 'classified', obligations, ...over });
const email = (id: string, over: Partial<Email> = {}): Email => ({
  id, accountId: 'acct', accountEmail: READER, threadId: 't-' + id, sender: 'Sam Lee', address: 'sam.lee@partner.org', to: [READER], initials: 'SL',
  subject: 'Subject ' + id, summary: '', body: '', time: '', category: 'work', priority: 'normal', needsReply: false, unread: false, color: 'blue',
  receivedAt: NOW - 2 * HOUR, classification: classify([request()]), ...over,
});
const ids = (list: Email[]) => digestItems(list, NOW).slice(0, DIGEST_SHOWN).map(item => item.email.id);

void test('someone the reader writes to outranks a system deadline', () => {
  const known = email('friend', { address: 'luke@gmail.com', category: 'personal', senderFamiliarity: { status: 'previously-emailed', checkedAt: NOW, priorTo: NOW - DAY } });
  const system = email('canvas', { address: 'notifications@instructure.com', classification: classify([dueToday]) });
  assert.deepEqual(ids([system, known]), ['friend', 'canvas']);
});

void test('a person writing about work outranks an automated request for a reply', () => {
  const colleague = email('colleague', { needsReply: true });
  const vendor = email('vendor', { address: 'support@vendor.zendesk.com', needsReply: true });
  assert.equal(ids([vendor, colleague])[0], 'colleague');
  assert.ok(!ids([vendor, colleague]).includes('vendor') || ids([vendor, colleague]).indexOf('vendor') > 0);
});

void test('routine codes, resets and email checks do not take a place', () => {
  const code = email('code', { address: 'account-security-noreply@accounts.example.com', subject: 'Your single-use code', classification: classify([], { securityEvent: true }) });
  const reset = email('reset', { address: 'calnet@school.edu', subject: 'Your passphrase was reset', classification: classify([], { securityEvent: true }) });
  const verify = email('verify', { address: 'verify@sheerid.com', subject: 'Get verified for Barron’s', classification: classify([dueToday]) });
  assert.deepEqual(ids([code, reset, verify]), []);
  const alarm = email('alarm', { address: 'security@bank.com', subject: 'New sign-in from an unrecognized device', classification: classify([], { securityEvent: true }) });
  assert.deepEqual(ids([alarm]), ['alarm'], 'an alarming account event still qualifies');
});

void test('a mass mailing is not a person, but mail to named colleagues is', () => {
  const blast = email('blast', { address: 'unit3ha@school.edu', to: ['unit3ha@school.edu'], needsReply: true });
  const team = email('team', { address: 'zhuoting.tan@startup.bio', to: ['eric@school.edu', 'luke@school.edu'] });
  assert.equal(isBlast(blast), true);
  assert.equal(fromPerson(blast), false);
  assert.equal(isBlast(team), false, 'named colleagues, reached through an alias');
  assert.equal(fromPerson(team), true);
  assert.equal(fromPerson(email('role', { address: 'communications@school.edu' })), false);
  assert.equal(fromPerson(email('bulk', { address: 'pay@notification.bank.com' })), false);
  assert.deepEqual(ids([blast, team]), ['team']);
});

void test('a star and work lift an item; a quiet day shows fewer than five', () => {
  // Ten days old: still Important, no longer a recent request.
  const plain = email('plain', { category: 'personal', receivedAt: NOW - 10 * DAY });
  const starred = email('starred', { category: 'personal', receivedAt: NOW - 10 * DAY, gmailLabels: ['STARRED'] });
  const work = email('work', { receivedAt: NOW - 10 * DAY });
  assert.deepEqual(ids([plain, work, starred]), ['starred', 'work']);
  assert.ok(ids([plain, work, starred]).length < DIGEST_SHOWN);
});

void test('a decision about the reader counts whoever sends it, and outranks a vendor asking for a reply', () => {
  const decisions = email('tryouts', { address: 'clubteam@lists.school.edu', to: ['clubteam@lists.school.edu'], listId: 'clubteam.lists.school.edu',
    subject: 'B Team Tryout Decisions', classification: classify([request()]), receivedAt: NOW - 38 * HOUR, gmailLabels: ['IMPORTANT', 'CATEGORY_FORUMS'] });
  const vendor = email('vendor', { address: 'support@vendor.zendesk.com', needsReply: true, receivedAt: NOW - 2 * HOUR, gmailLabels: ['IMPORTANT', 'CATEGORY_PERSONAL'] });
  assert.equal(fromPerson(decisions), false, 'still a list, not a person');
  assert.deepEqual(ids([vendor, decisions]), ['tryouts', 'vendor']);
  assert.deepEqual(ids([email('grades', { address: 'notification@edstem.org', subject: 'Midterm 1 Grades Released', receivedAt: NOW - 3 * DAY })]), ['grades']);
  assert.deepEqual(ids([email('cutoff', { address: 'notification@edstem.org', subject: 'Add/drop cut-off reminder', receivedAt: NOW - 3 * DAY })]), [], 'ordinary notices are not outcomes');
});
