import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { GET as listDrafts, POST as draftAction } from '../app/api/drafts/route';
import { connect, origin, post, rig, type Rig } from './helpers/google';

/**
 * The Drafts tab reads Gmail's Drafts folder live: every account in the combined view, newest
 * first, with replies and attachments marked, and one account's failure kept to itself.
 */

let r: Rig;
beforeEach(async () => { r = rig(); await connect(r, 'user-a', 'acct-1', 'me@gmail.example'); });
afterEach(() => r.restore());

const b64 = (text: string) => Buffer.from(text).toString('base64url');
type Draft = { id: string; message: object };
function draft(id: string, over: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string; at: number; inReplyTo?: string; attachment?: boolean }): Draft {
  const headers = [['To', over.to ?? 'Sam Lee <sam@example.com>'], ['Subject', over.subject ?? 'Plan'],
    ...(over.cc ? [['Cc', over.cc]] : []), ...(over.bcc ? [['Bcc', over.bcc]] : []), ...(over.inReplyTo ? [['In-Reply-To', over.inReplyTo]] : [])]
    .map(([name, value]) => ({ name, value }));
  const text = { mimeType: 'text/plain', body: { data: b64(over.body ?? 'Hello') } };
  const payload = over.attachment
    ? { mimeType: 'multipart/mixed', headers, parts: [text, { mimeType: 'application/pdf', filename: 'plan.pdf', body: { attachmentId: 'att-1', size: 2048 } }] }
    : { ...text, headers };
  return { id, message: { id: 'msg-' + id, threadId: 'thread-' + id, internalDate: String(over.at), labelIds: ['DRAFT'], snippet: '', payload } };
}

/**
 * Serves Gmail's Drafts folder in front of the rig. Accounts are read one at a time, oldest
 * connection first, each starting with a token request, so that request marks the switch.
 */
function serveDrafts(byAccount: Record<string, Draft[] | 'fail'>) {
  const provider = globalThis.fetch;
  const order = Object.keys(byAccount);
  let turn = -1;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes('oauth2.googleapis.com/token')) turn = Math.min(turn + 1, order.length - 1);
    const account = order[Math.max(turn, 0)];
    const drafts = byAccount[account];
    if (/\/users\/me\/drafts\?maxResults=/.test(url)) {
      if (drafts === 'fail') return new Response('{}', { status: 500 });
      return Response.json({ drafts: (drafts || []).map(item => ({ id: item.id })) });
    }
    const wanted = /\/users\/me\/drafts\/([^?]+)\?format=full/.exec(url)?.[1];
    if (wanted && Array.isArray(drafts)) {
      const found = drafts.find(item => item.id === decodeURIComponent(wanted));
      return found ? Response.json(found) : new Response('{}', { status: 404 });
    }
    return provider(input, init);
  };
}

const read = async (accountId?: string) => {
  const response = await listDrafts(new Request(`${origin}/api/drafts${accountId ? `?accountId=${accountId}` : ''}`));
  assert.equal(response.status, 200);
  return await response.json() as { items: { id: string; accountEmail: string; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; reply: boolean; attachments: number; updatedAt: number }[]; failures: { email: string }[] };
};

void test('drafts are read from Gmail newest first, as written, with replies and attachments marked', async () => {
  serveDrafts({ 'acct-1': [
    draft('older', { at: 1_000, subject: 'Re: Budget', inReplyTo: '<m1@example.com>', attachment: true }),
    draft('newer', { at: 2_000, to: 'Sam Lee <sam@example.com>, ana@example.com', cc: 'lead@example.com', bcc: 'me@example.com', body: 'Hi Sam,\r\nDraft text.\r\n\r\n--\r\nEthan' }),
  ] });
  const { items, failures } = await read('acct-1');
  assert.deepEqual(failures, []);
  assert.deepEqual(items.map(item => item.id), ['newer', 'older']);
  const [fresh, reply] = items;
  assert.deepEqual([fresh.to, fresh.cc, fresh.bcc], [['sam@example.com', 'ana@example.com'], ['lead@example.com'], ['me@example.com']]);
  assert.equal(fresh.body, 'Hi Sam,\nDraft text.\n\n--\nEthan', 'the body keeps its signature, so editing it loses nothing');
  assert.equal(fresh.accountEmail, 'me@gmail.example');
  assert.equal(fresh.reply, false);
  assert.deepEqual([reply.reply, reply.attachments], [true, 1]);
});

void test('the combined view lists every account, and one failing account does not hide the others', async () => {
  await connect(r, 'user-a', 'acct-2', 'work@school.example');
  serveDrafts({ 'acct-1': [draft('a', { at: 5 })], 'acct-2': 'fail' });
  const { items, failures } = await read();
  assert.deepEqual(items.map(item => item.id), ['a']);
  assert.deepEqual(failures.map(item => item.email), ['work@school.example']);
});

void test('a draft is deleted from Gmail, and only from an account the user owns', async () => {
  const response = await draftAction(post('/api/drafts', { action: 'delete', accountId: 'acct-1', id: 'draft-9' }));
  assert.equal(response.status, 200);
  assert.ok(r.calls.some(call => call.method === 'DELETE' && call.url.endsWith('/users/me/drafts/draft-9')));
  assert.equal((await draftAction(post('/api/drafts', { action: 'delete', accountId: 'acct-1', id: '../labels' }))).status, 400);
  assert.equal((await draftAction(post('/api/drafts', { action: 'delete', accountId: 'someone-else', id: 'draft-9' }))).status, 404);
  const foreign = new Request(origin + '/api/drafts', { method: 'POST', headers: { origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await draftAction(foreign)).status, 403);
});
