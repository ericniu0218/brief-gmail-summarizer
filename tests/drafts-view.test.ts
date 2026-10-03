import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { byText, click, render, screen, settle, setupDom, teardownDom } from './dom';
import { DraftsView, editableHere, gmailDraftUrl } from '../components/drafts-view';
import type { DraftItem } from '../server/drafts';

/** The Drafts tab: edit here what was written here, open replies and files in Gmail, delete with a check. */

const draft = (id: string, over: Partial<DraftItem> = {}): DraftItem => ({ id, messageId: 'msg-' + id, threadId: 't-' + id, accountId: 'acct-1',
  accountEmail: 'me@gmail.example', to: ['sam@example.com'], cc: [], bcc: [], subject: 'Subject ' + id, body: 'Hi Sam,\nThe plan.', updatedAt: 1_790_000_000_000,
  reply: false, attachments: 0, ...over });
const state = (items: DraftItem[], over: object = {}) => ({ items, failures: [], loading: false, error: '', count:0,loaded: true,
  reload: async () => {}, remove: async () => {}, ...over });

void test('a draft written here opens in Compose; a reply or a draft with files opens in Gmail', async () => {
  assert.equal(editableHere(draft('plain')), true);
  assert.equal(editableHere(draft('reply', { reply: true })), false);
  assert.equal(editableHere(draft('files', { attachments: 2 })), false);
  assert.equal(gmailDraftUrl(draft('x')), 'https://mail.google.com/mail/u/?authuser=me%40gmail.example#drafts?compose=msg-x');
  setupDom();
  const edited: string[] = [];
  try {
    await render(createElement(DraftsView, { drafts: state([draft('plain'), draft('reply', { reply: true, subject: 'Re: Budget' })]), now: 1, connected: true,
      showAccount: false, onEdit: (item: DraftItem) => edited.push(item.id), onCompose: () => {} }));
    await click(byText('button', /^Edit$/));
    assert.deepEqual(edited, ['plain']);
    const open = byText('a', /Open in Gmail/) as HTMLAnchorElement;
    assert.equal(open.getAttribute('href'), gmailDraftUrl(draft('reply')));
    assert.equal(open.getAttribute('target'), '_blank');
    assert.match(screen().textContent!, /To sam@example\.com/);
    assert.match(screen().textContent!, /Hi Sam,/, 'the first line previews the draft');
  } finally { teardownDom(); }
});

void test('delete asks first, and Keep leaves the draft alone', async () => {
  setupDom();
  const deleted: string[] = [];
  try {
    await render(createElement(DraftsView, { drafts: state([draft('a')], { remove: async (item: DraftItem) => { deleted.push(item.id); } }), now: 1,
      connected: true, showAccount: false, onEdit: () => {}, onCompose: () => {} }));
    await click(screen().querySelector('button[aria-label="Delete draft Subject a"]')!);
    await click(byText('button', /^Keep$/));
    assert.deepEqual(deleted, []);
    await click(screen().querySelector('button[aria-label="Delete draft Subject a"]')!);
    await click(byText('button', /^Delete$/));
    await settle();
    assert.deepEqual(deleted, ['a']);
  } finally { teardownDom(); }
});

void test('the tab explains itself when empty, loading, failing, or not connected', () => {
  const view = (drafts: ReturnType<typeof state>, connected = true) => renderToStaticMarkup(createElement(DraftsView,
    { drafts, now: 1, connected, showAccount: false, onEdit: () => {}, onCompose: () => {} }));
  assert.match(view(state([])), /No drafts\./);
  assert.match(view(state([], { count:0,loaded: false, loading: true })), /Loading your drafts/);
  assert.match(view(state([], { failures: [{ accountId: 'b', email: 'work@school.example', error: 'Gmail is busy.' }] })), /Could not load drafts for work@school\.example/);
  assert.match(view(state([]), false), /Connect Gmail to see your drafts/);
});
