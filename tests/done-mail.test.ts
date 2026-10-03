import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { byText, click, render, screen, settle, setupDom, teardownDom } from './dom';
import { PriorityEmailList } from '../components/priority-email-list';
import { useDoneMail } from '../hooks/use-done-mail';
import type { Email } from '../lib/mail';

/**
 * Done moves handled mail out of the list: the row leaves, an Undo bar names it, and it
 * waits in a collapsed Done section with Move back. Marks are remembered in this browser.
 */

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3600000;
function mail(id: string, over: Partial<Email> = {}): Email {
  return { id, accountId: 'acct-1', sender: `Sender ${id}`, address: `${id}@example.com`, initials: 'S', subject: `Subject ${id}`,
    summary: '', body: '', time: '', category: 'work', priority: 'normal', needsReply: false, unread: false, color: 'blue',
    receivedAt: NOW - HOUR, ...over } as Email;
}

function Harness({ emails }: { emails: Email[] }) {
  const done = useDoneMail('reader');
  const { open, done: finished } = done.split(emails);
  return createElement(PriorityEmailList, { emails: open, doneEmails: finished, onDone: done.markDone, onMoveBack: done.moveBack,
    now: NOW, sortMode: 'newest', busy: false, emptyTitle: 'All clear.', emptyBody: 'Nothing here.', onSelect: () => {} });
}

/** Lets the row's exit animation finish and the mark land. */
const leave = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
const subjects = () => [...screen().querySelectorAll('.email-row h3')].map(node => node.textContent);

void test('Done moves an email out of the list, names it, and Undo brings it back', async () => {
  setupDom();
  try {
    await render(createElement(Harness, { emails: [mail('a', { receivedAt: NOW - HOUR }), mail('b', { receivedAt: NOW - 2 * HOUR }), mail('c', { receivedAt: NOW - 3 * HOUR })] }));
    await settle();
    assert.deepEqual(subjects(), ['Subject a', 'Subject b', 'Subject c']);
    await click(screen().querySelector('button[aria-label="Mark Subject b as done"]')!);
    await leave();
    assert.deepEqual(subjects(), ['Subject a', 'Subject c'], 'the next email moves up');
    assert.match(screen().querySelector('.done-toast')!.textContent!, /Moved Subject b to Done/);
    assert.equal(screen().querySelector('.done-count')!.textContent, '1');
    await click(byText('button', /^Undo$/));
    assert.deepEqual(subjects(), ['Subject a', 'Subject b', 'Subject c']);
    assert.equal(screen().querySelector('.done-section'), null, 'nothing is left in Done');
  } finally { teardownDom(); }
});

void test('the Done section lists marked mail and Move back returns it', async () => {
  setupDom();
  try {
    await render(createElement(Harness, { emails: [mail('a'), mail('b')] }));
    await settle();
    await click(screen().querySelector('button[aria-label="Mark Subject a as done"]')!);
    await leave();
    const toggle = screen().querySelector('.done-toggle')!;
    assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'Done starts collapsed');
    await click(toggle);
    assert.match(screen().querySelector('.done-row')!.textContent!, /Sender a.*Subject a/);
    await click(byText('button', /Move back/));
    assert.deepEqual(subjects().sort(), ['Subject a', 'Subject b']);
  } finally { teardownDom(); }
});

void test('marks are remembered in this browser, and a fully done list says so', async () => {
  setupDom();
  try {
    const emails = [mail('a')];
    await render(createElement(Harness, { emails }));
    await settle();
    await click(screen().querySelector('button[aria-label="Mark Subject a as done"]')!);
    await leave();
    assert.match(screen().querySelector('.empty-state')!.textContent!, /All caught up/);
    const stored = JSON.parse(localStorage.getItem('brief:done-mail:reader') || '{}') as Record<string, number>;
    assert.deepEqual(Object.keys(stored), [JSON.stringify(['acct-1', 'a'])], 'keyed by account and message');
  } finally { teardownDom(); }
  setupDom();
  try {
    localStorage.setItem('brief:done-mail:reader', JSON.stringify({ [JSON.stringify(['acct-1', 'a'])]: NOW, bogus: 'yes' }));
    await render(createElement(Harness, { emails: [mail('a'), mail('a', { accountId: 'acct-2' })] }));
    await settle();
    assert.equal(subjects().length, 1, 'a reload keeps it done, and the same id in another account is untouched');
    assert.equal(screen().querySelector('.done-count')!.textContent, '1');
  } finally { teardownDom(); }
});

void test('Done on a folded group covers every message in it', async () => {
  setupDom();
  try {
    const thread = [mail('a', { threadId: 't1' }), mail('b', { threadId: 't1', receivedAt: NOW - 2 * HOUR }), mail('c')];
    await render(createElement(Harness, { emails: thread }));
    await settle();
    await click(screen().querySelector('.email-fold .done-button')!);
    await leave();
    assert.equal(screen().querySelector('.email-fold'), null);
    assert.deepEqual(subjects(), ['Subject c']);
    assert.equal(screen().querySelector('.done-count')!.textContent, '2');
  } finally { teardownDom(); }
});
