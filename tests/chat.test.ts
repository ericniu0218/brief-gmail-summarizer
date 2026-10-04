import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { WorkspaceStore, type Principal } from '../server/workspaces/store';
import { GET, POST, DELETE } from '../app/api/v1/[...path]/route';
import type { Runtime } from '../server/runtime';
import {
  dayLabel,
  messageTurns,
  sendsOnKey,
  startsNewDay,
  unreadCount,
  type Message,
} from '../lib/chat';

/**
 * The workspace conversation.
 *
 * What matters here is that a reader following by cursor sees every message exactly once,
 * that a retried send says a thing once, and that reading and writing follow the same
 * roles as the rest of the workspace.
 */

const person = (id: string): Principal => ({
  type: 'user',
  id,
  name: `Person ${id}`,
});
const denied = (status: number) => (error: unknown) => {
  assert.equal((error as { status: number }).status, status);
  return true;
};
async function setup() {
  const { db, sql } = database();
  const owner = new WorkspaceStore(db, person('owner'));
  const ws = await owner.createWorkspace('Antibody A');
  const luke = new WorkspaceStore(db, person('luke'));
  const viewer = new WorkspaceStore(db, person('viewer'));
  await luke.join((await owner.createJoinCode(ws.id, { role: 'editor' })).code);
  await viewer.join((await owner.createInvite(ws.id, 'viewer')).token);
  return {
    db,
    sql,
    ws,
    owner,
    luke,
    viewer,
    outsider: new WorkspaceStore(db, person('outsider')),
  };
}
let keys = 0;
const say = (store: WorkspaceStore, ws: string, body: string) =>
  store.postMessage(ws, { body }, `say-${keys++}`);
const from = (params = '') => new URLSearchParams(params);

void test('a reader following by cursor sees each message once, in order', async () => {
  const { ws, owner, luke, viewer } = await setup();
  await say(owner, ws.id, 'Starting the assay today.');
  const second = await say(luke, ws.id, 'I have the reagents.');

  const opening = await viewer.messages(ws.id, from(''));
  assert.deepEqual(
    opening.items.map((m) => m.body),
    ['Starting the assay today.', 'I have the reagents.'],
  );
  assert.equal(opening.latest, second.sequence);
  // Nothing new since: an empty answer, not a repeat of what is already held.
  const caughtUp = await viewer.messages(
    ws.id,
    from(`after=${opening.latest}`),
  );
  assert.deepEqual(caughtUp.items, []);
  assert.equal(caughtUp.latest, second.sequence);
  await say(owner, ws.id, 'Great, starting now.');
  const next = await viewer.messages(ws.id, from(`after=${opening.latest}`));
  assert.deepEqual(
    next.items.map((m) => m.body),
    ['Great, starting now.'],
  );
  // Opening the conversation shows the most recent messages, still oldest first.
  const limited = await viewer.messages(ws.id, from('limit=2'));
  assert.deepEqual(
    limited.items.map((m) => m.body),
    ['I have the reagents.', 'Great, starting now.'],
  );
});

void test('a retried send says it once', async () => {
  const { ws, owner } = await setup();
  const first = await owner.postMessage(ws.id, { body: 'Ready?' }, 'send-1');
  const retry = await owner.postMessage(ws.id, { body: 'Ready?' }, 'send-1');
  assert.deepEqual(retry, first);
  assert.equal((await owner.messages(ws.id, from(''))).items.length, 1);
});

void test('reading and writing the conversation follow the workspace roles', async () => {
  const { ws, owner, viewer, outsider } = await setup();
  const message = await say(owner, ws.id, 'Anyone there?');
  assert.equal((await viewer.messages(ws.id, from(''))).items.length, 1);
  await assert.rejects(() => say(viewer, ws.id, 'Me'), denied(403));
  await assert.rejects(
    () => viewer.deleteMessage(ws.id, message.id),
    denied(403),
  );
  await assert.rejects(() => outsider.messages(ws.id, from('')), denied(404));
  await assert.rejects(() => say(outsider, ws.id, 'Hello'), denied(404));
  // Empty and oversized messages are not messages.
  await assert.rejects(() => say(owner, ws.id, '   '), denied(400));
  await assert.rejects(() => say(owner, ws.id, 'x'.repeat(4001)), denied(400));
});

void test('a withdrawn message loses its words but keeps its place in the order', async () => {
  const { ws, owner, luke } = await setup();
  const mine = await say(luke, ws.id, 'Wrong channel, sorry.');
  const after = await say(owner, ws.id, 'No problem.');
  await assert.rejects(
    () => owner.deleteMessage(ws.id, 'no-such-message'),
    denied(404),
  );
  await luke.deleteMessage(ws.id, mine.id);
  const seen = (await owner.messages(ws.id, from(''))).items;
  assert.deepEqual(
    seen.map((m) => [m.body, m.deleted === null]),
    [
      ['', false],
      ['No problem.', true],
    ],
  );
  // The cursor still means what it meant: the later message did not shift.
  assert.equal(seen[1].sequence, after.sequence);
  // An owner can withdraw somebody else's message; a second withdrawal is harmless.
  const theirs = await say(owner, ws.id, 'Said too much.');
  await owner.deleteMessage(ws.id, theirs.id);
  await owner.deleteMessage(ws.id, theirs.id);
});

void test('one author cannot flood the workspace', async () => {
  const { ws, owner, luke } = await setup();
  for (let count = 0; count < 30; count++) await say(owner, ws.id, `m${count}`);
  await assert.rejects(() => say(owner, ws.id, 'one more'), denied(429));
  // The limit is per person: everybody else is still talking.
  await say(luke, ws.id, 'Still here.');
});

void test('retrying a send that already went through is not mistaken for flooding', async () => {
  const { ws, owner } = await setup();
  let last = await owner.postMessage(ws.id, { body: 'm0' }, 'flood-0');
  for (let count = 1; count < 30; count++)
    last = await owner.postMessage(ws.id, { body: `m${count}` }, `flood-${count}`);
  // At the limit, a brand new message is refused...
  await assert.rejects(() => say(owner, ws.id, 'one more'), denied(429));
  // ...but the connection dropping after the last one landed must not turn its retry
  // into an error: that message was sent, and the retry gets it back.
  const retry = await owner.postMessage(ws.id, { body: 'm29' }, 'flood-29');
  assert.deepEqual(retry, last);
  assert.equal((await owner.messages(ws.id, from('limit=100'))).items.length, 30);
});

void test('one workspace never reads another workspace\u2019s conversation', async () => {
  const { ws, owner } = await setup();
  const other = await owner.createWorkspace('Antibody B');
  await say(owner, ws.id, 'Only for Antibody A.');
  await say(owner, other.id, 'Only for Antibody B.');
  assert.deepEqual(
    (await owner.messages(ws.id, from())).items.map((m) => m.body),
    ['Only for Antibody A.'],
  );
  assert.deepEqual(
    (await owner.messages(other.id, from())).items.map((m) => m.body),
    ['Only for Antibody B.'],
  );
  // The cursor is per workspace too: B's sequence number does not hide A's messages.
  const a = await owner.messages(ws.id, from());
  const b = await owner.messages(other.id, from());
  assert.ok(b.latest > a.latest);
  assert.deepEqual(
    (await owner.messages(ws.id, from(`after=${a.latest - 1}`))).items.map((m) => m.body),
    ['Only for Antibody A.'],
  );
  // Withdrawing needs the right workspace as well as the right id.
  const mine = await say(owner, ws.id, 'Withdraw me.');
  await assert.rejects(() => owner.deleteMessage(other.id, mine.id), denied(404));
});

void test('a member who changes their name is shown by the name they use now', async () => {
  const { db, ws, owner } = await setup();
  const renamed = new WorkspaceStore(db, {
    type: 'user',
    id: 'luke',
    name: 'Luke Li',
  });
  await say(renamed, ws.id, 'Renamed.');
  const members = await owner.members(ws.id);
  assert.equal(
    members.find((m) => m.userId === 'luke')?.displayName,
    'Luke Li',
  );
  assert.equal(
    (await owner.messages(ws.id, from(''))).items[0].authorName,
    'Luke Li',
  );
});

void test('the conversation reads as turns, days and an unread count', () => {
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...(parts as unknown as [number, number, number])).getTime();
  const message = (over: Partial<Message>): Message => ({
    sequence: 1,
    id: 'm1',
    workspaceId: 'ws',
    authorId: 'user:luke',
    authorName: 'Luke',
    body: 'Hello',
    created: at(2026, 9, 4, 9, 0),
    deleted: null,
    ...over,
  });
  const messages = [
    message({ sequence: 1, id: 'a', created: at(2026, 9, 3, 16, 0) }),
    message({ sequence: 2, id: 'b', created: at(2026, 9, 4, 9, 0) }),
    // One minute later from the same person: the same turn.
    message({ sequence: 3, id: 'c', created: at(2026, 9, 4, 9, 1) }),
    // An hour later: a new turn, same day.
    message({ sequence: 4, id: 'd', created: at(2026, 9, 4, 10, 1) }),
    message({
      sequence: 5,
      id: 'e',
      authorId: 'user:owner',
      authorName: 'Owner',
      created: at(2026, 9, 4, 10, 2),
    }),
  ];
  const turns = messageTurns(messages);
  assert.deepEqual(
    turns.map((turn) => turn.messages.map((m) => m.id)),
    [['a'], ['b', 'c'], ['d'], ['e']],
  );
  // Order is by sequence, whatever order they arrived in.
  assert.deepEqual(
    messageTurns([...messages].reverse()).map((t) => t.key),
    turns.map((t) => t.key),
  );
  assert.equal(startsNewDay(turns, 0), true);
  assert.equal(startsNewDay(turns, 1), true);
  assert.equal(startsNewDay(turns, 2), false);
  const now = at(2026, 9, 4, 11, 0);
  assert.equal(dayLabel(at(2026, 9, 4, 9, 0), now), 'Today');
  assert.equal(dayLabel(at(2026, 9, 3, 16, 0), now), 'Yesterday');
  assert.match(dayLabel(at(2026, 8, 1, 16, 0), now), /Sep/);
  // Two messages three minutes apart but either side of midnight are two turns, so the
  // date separator can never land in the middle of one.
  const midnight = messageTurns([
    message({ sequence: 10, id: 'x', created: at(2026, 9, 3, 23, 58) }),
    message({ sequence: 11, id: 'y', created: at(2026, 9, 4, 0, 1) }),
  ]);
  assert.deepEqual(
    midnight.map((turn) => turn.messages.map((m) => m.id)),
    [['x'], ['y']],
  );
  assert.equal(startsNewDay(midnight, 1), true);
  // Enter sends; Shift+Enter writes a second line.
  assert.equal(sendsOnKey('Enter', false), true);
  assert.equal(sendsOnKey('Enter', true), false);
  assert.equal(sendsOnKey('a', false), false);
  // Unread counts other people's live messages only.
  assert.equal(unreadCount(messages, 2, 'user:luke'), 1);
  assert.equal(unreadCount(messages, 0, 'user:owner'), 4);
  assert.equal(unreadCount(messages, 5, null), 0);
  assert.equal(
    unreadCount([message({ sequence: 9, id: 'z', deleted: 1 })], 0, null),
    0,
  );
});

void test('HTTP flow: post, follow by cursor, withdraw, and refuse an outsider', async () => {
  const { db, ws } = await setup();
  globalThis.__briefTestEnv = {
    DB: db,
    APP_URL: 'https://brief.example',
  } as Runtime;
  const call = (
    path: string,
    method: string,
    data?: unknown,
    extra?: Record<string, string>,
  ) =>
    new Request(`https://brief.example/api/v1/${path}`, {
      method,
      headers: {
        origin: 'https://brief.example',
        'content-type': 'application/json',
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const identity = (id: string) =>
    new Headers({
      'x-brief-identity-secret': 'test-ingress-secret-for-authenticated-proxy',
      'oai-authenticated-user-id': id,
      'oai-authenticated-user-email': `${id}@example.com`,
    });

  globalThis.__briefTestHeaders = identity('owner');
  const posted = await POST(
    call(`workspaces/${ws.id}/messages`, 'POST', { body: 'Morning all.' }, {
      'idempotency-key': 'http-say-1',
    }),
  );
  assert.equal(posted.status, 201);
  const message = (await posted.json()) as Message;

  globalThis.__briefTestHeaders = identity('luke');
  const followed = (await (
    await GET(call(`workspaces/${ws.id}/messages?after=0`, 'GET'))
  ).json()) as { items: Message[]; latest: number; me: string };
  assert.deepEqual(followed.items.map((m) => m.body), ['Morning all.']);
  assert.equal(followed.me, 'user:luke');
  // Luke did not write it, so he cannot withdraw it.
  assert.equal(
    (
      await DELETE(
        call(`workspaces/${ws.id}/messages/${message.id}`, 'DELETE'),
      )
    ).status,
    403,
  );
  globalThis.__briefTestHeaders = identity('owner');
  assert.equal(
    (
      await DELETE(
        call(`workspaces/${ws.id}/messages/${message.id}`, 'DELETE'),
      )
    ).status,
    200,
  );
  globalThis.__briefTestHeaders = identity('stranger');
  assert.equal(
    (await GET(call(`workspaces/${ws.id}/messages`, 'GET'))).status,
    404,
  );
});
