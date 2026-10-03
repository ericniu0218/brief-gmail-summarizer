import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { foldGroups, foldMessageKey, foldSenderKey, isAutomatedSender, topicOf, TOPIC_WINDOW_MS } from '../lib/folding';
import { buildInboxRows } from '../lib/inbox-priority';
import { allByText, byText, click, render, screen, settle, setupDom, teardownDom } from './dom';
import { PriorityEmailList } from '../components/priority-email-list';
import type { Email } from '../lib/mail';

/** Folding: one conversation, one topic within a week, and the reader's own preferences. */

const NOW = Date.UTC(2026, 9, 2, 12);
const DAY = 86400000;
function mail(id: string, over: Partial<Email> = {}): Email {
  return { id, accountId: 'acct-1', sender: 'Sender', address: `${id}@example.com`, initials: 'S', subject: `Subject ${id}`,
    summary: '', body: '', time: '', category: 'work', priority: 'normal', needsReply: false, unread: false, color: 'blue',
    receivedAt: NOW - DAY, ...over } as Email;
}
const shop = (id: string, subject: string, daysAgo = 1, over: Partial<Email> = {}) =>
  mail(id, { sender: 'Shop', address: 'no-reply@shop.example', subject, receivedAt: NOW - daysAgo * DAY, ...over });
const byId = (a: string, b: string) => a.localeCompare(b);
const byFirst = (a: string[], b: string[]) => a[0].localeCompare(b[0]);
const grouped = (emails: Email[], preferences = {}) =>
  foldGroups(emails, preferences).map(group => group.members.map(index => emails[index].id).sort(byId)).sort(byFirst);

void test('a conversation folds across senders, whatever its age', () => {
  const thread = [mail('a', { threadId: 't1', sender: 'Maya Chen', address: 'maya@uni.edu' }),
    mail('b', { threadId: 't1', sender: 'Jordan Lee', address: 'jordan@uni.edu', receivedAt: NOW - 40 * DAY }),
    mail('c', { threadId: 't2', sender: 'Maya Chen', address: 'maya@uni.edu' })];
  assert.deepEqual(grouped(thread), [['a', 'b']]);
  const rows = buildInboxRows(thread, NOW);
  const fold = rows.find(row => row.kind === 'fold');
  assert.ok(fold && fold.kind === 'fold');
  assert.equal(fold.reason, 'conversation');
  assert.equal(fold.label, 'Conversation');
  assert.equal(fold.company, 'Maya, Jordan');
});

void test('automated mail folds by topic; unrelated topics from the same company stay apart', () => {
  const mailbox = [shop('ship1', 'Your order has shipped'), shop('ship2', 'Out for delivery today'),
    shop('bill1', 'Your payment was received'), shop('bill2', 'Your monthly statement is ready')];
  assert.deepEqual(grouped(mailbox), [['bill1', 'bill2'], ['ship1', 'ship2']]);
  const labels = buildInboxRows(mailbox, NOW).flatMap(row => row.kind === 'fold' ? [row.label] : []).sort(byId);
  assert.deepEqual(labels, ['Billing and payments', 'Shipping updates']);
  assert.equal(topicOf({ subject: 'Your weekly report for May 3', summary: '' }).key, topicOf({ subject: 'Your weekly report for May 10', summary: '' }).key,
    'a recurring subject is one topic');
  assert.notEqual(topicOf({ subject: 'Your weekly report', summary: '' }).key, topicOf({ subject: 'Team offsite photos', summary: '' }).key);
});

void test('a topic only folds messages within a week of its newest member', () => {
  const mailbox = [shop('new', 'Your package is on its way', 1), shop('recent', 'Your order has shipped', 1 + 6),
    shop('old', 'Your package was delivered', 1 + 6 + 2 + 7), shop('older', 'Your order shipped', 1 + 6 + 2 + 7 + 1)];
  assert.ok(TOPIC_WINDOW_MS === 7 * DAY);
  assert.deepEqual(grouped(mailbox), [['new', 'recent'], ['old', 'older']], 'older updates form their own group, not this one');
  assert.deepEqual(grouped([shop('x', 'Your order has shipped', 1), shop('y', 'Delivered', 30)]), [], 'a month apart, nothing folds');
});

void test('an old conversation cannot bridge an unrelated old topic into a fold', () => {
  const mailbox=[shop('new','Your order shipped',1,{threadId:'t'}),
    shop('thread-old','Your order shipped',90,{threadId:'t'}),
    shop('other-old','Your order shipped',92)];
  assert.deepEqual(grouped(mailbox),[['new','thread-old']]);
});

void test('people are never topic-grouped, and accounts never mix', () => {
  assert.equal(isAutomatedSender({ address: 'maya@uni.edu' }), false);
  assert.equal(isAutomatedSender({ address: 'notifications@github.com' }), true);
  assert.equal(isAutomatedSender({ address: 'no-reply@gmail.com' }), false, 'a personal mailbox provider is not a company');
  assert.deepEqual(grouped([mail('a', { address: 'maya@uni.edu', subject: 'Budget' }), mail('b', { address: 'maya@uni.edu', subject: 'Budget' })]), []);
  assert.deepEqual(grouped([shop('a', 'Your order has shipped'), shop('b', 'Out for delivery', 1, { accountId: 'acct-2' })]), []);
  assert.deepEqual(grouped([mail('a', { threadId: 't' }), mail('b', { threadId: 't', accountId: 'acct-2' })]), [], 'the same thread id in two mailboxes');
});

void test('“always group this sender” folds every message from it, across topics and time', () => {
  const colleague = (id: string, subject: string, daysAgo: number) => mail(id, { sender: 'Maya Chen', address: 'Maya@uni.edu', subject, receivedAt: NOW - daysAgo * DAY });
  const mailbox = [colleague('a', 'Budget', 1), colleague('b', 'Lunch?', 60), mail('other', { address: 'jordan@uni.edu' })];
  const preferences = { [foldSenderKey({ accountId: 'acct-1', address: 'maya@uni.edu' })]: 'group' as const };
  assert.deepEqual(grouped(mailbox, preferences), [['a', 'b']], 'matched without regard to capitalisation');
  const fold = buildInboxRows(mailbox, NOW, 'importance', preferences).find(row => row.kind === 'fold');
  assert.equal(fold?.kind === 'fold' && fold.label, 'Grouped sender');
});

void test('“keep separate” wins over every relation, for a sender or for chosen messages', () => {
  const mailbox = [shop('ship1', 'Your order has shipped', 1, { threadId: 't' }), shop('ship2', 'Out for delivery', 1, { threadId: 't' }), shop('ship3', 'Delivered', 2)];
  assert.deepEqual(grouped(mailbox, { [foldSenderKey(mailbox[0])]: 'separate' }), [], 'a separate sender never folds, not even by conversation');
  assert.deepEqual(grouped(mailbox, { [foldMessageKey(mailbox[2])]: 'separate' }), [['ship1', 'ship2']], 'only the chosen message leaves its group');
});

void test('folding stays linear on a large mailbox and never drops a message', () => {
  const mailbox = Array.from({ length: 12000 }, (_, index) => shop(`m${index}`, 'Your order has shipped', 0.5 + (index % 5) / 10, { threadId: `t${index % 50}` }));
  const started = performance.now();
  const rows = buildInboxRows(mailbox, NOW);
  assert.ok(performance.now() - started < 3000);
  assert.equal(rows.reduce((sum, row) => sum + (row.kind === 'fold' ? row.emails.length : 1), 0), 12000);
});

void test('an expanded fold offers to keep its messages separate', async () => {
  setupDom();
  const kept: string[][] = [];
  try {
    await render(createElement(PriorityEmailList, { emails: [shop('s1', 'Your order has shipped'), shop('s2', 'Out for delivery today')], now: NOW,
      busy: false, emptyTitle: 'x', emptyBody: 'y', onSelect: () => {}, onKeepSeparate: (emails: Email[]) => kept.push(emails.map(email => email.id)) }));
    assert.equal(byText('span', /^Shipping updates$/).className, 'folded-label');
    await click(screen().querySelector('.fold-expand')!);
    await click(byText('button', /Keep these messages separate/));
    await settle();
    assert.deepEqual(kept.map(ids => ids.sort(byId)), [['s1', 's2']]);
    assert.equal(allByText('button', /Stop always grouping/).length, 0);
  } finally { teardownDom(); }
});
