import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import {
  allByText,
  byLabel,
  render,
  screen,
  settle,
  setupDom,
  teardownDom,
} from './dom';
import { TeamChat } from '../components/team-chat';
import { MAX_MESSAGE_LENGTH, type Message } from '../lib/chat';

/** The conversation from the reader's side: it follows, it does not repeat, and it sends. */

const message = (over: Partial<Message>): Message => ({
  sequence: 1,
  id: 'm1',
  workspaceId: 'ws-1',
  authorId: 'user:luke',
  authorName: 'Luke',
  body: 'Starting the assay today.',
  created: Date.now(),
  deleted: null,
  ...over,
});
type Call = { url: string; method: string; body: unknown };
function server(script: (call: Call) => [number, unknown]) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const [status, data] = script(call);
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

const mount = (canWrite = true, followMs = 10) =>
  createElement(TeamChat, {
    workspaceId: 'ws-1',
    canWrite,
    onRead: () => {},
    followMs,
  });

void test('the conversation follows from where it left off, without repeating itself', async () => {
  setupDom();
  const first = message({ sequence: 4, id: 'a' });
  const second = message({
    sequence: 5,
    id: 'b',
    authorId: 'user:me',
    authorName: 'Me',
    body: 'Reagents are in.',
  });
  let delivered = false;
  const calls = server((call) => {
    if (call.method !== 'GET') return [405, {}];
    // The opening read returns the tail; the next one must ask from the newest held.
    if (!delivered) {
      delivered = true;
      return [200, { items: [first], latest: 4, me: 'user:me' }];
    }
    return [200, { items: [second], latest: 5, me: 'user:me' }];
  });
  try {
    await render(mount());
    await settle();
    assert.match(screen().textContent ?? '', /Starting the assay today/);
    // Drive the follow-up poll the way its timer would.
    await settle(10);
    const followed = calls.filter((call) => call.method === 'GET');
    assert.ok(
      followed.length >= 2,
      'the conversation is polled, not read once',
    );
    assert.match(followed[1].url, /after=4/);
    assert.equal(allByText('.team-chat-line p', /Starting the assay/).length, 1);
  } finally {
    teardownDom();
  }
});

void test('a writer gets a composer that will not send an empty message', async () => {
  setupDom();
  server(() => [200, { items: [], latest: 0, me: 'user:me' }]);
  try {
    await render(mount(true, 100000));
    await settle();
    assert.match(screen().textContent ?? '', /No messages yet/);
    const box = byLabel('Message') as unknown as { maxLength: number };
    assert.equal(box.maxLength, MAX_MESSAGE_LENGTH);
    // Nothing written yet, so there is nothing to send.
    assert.equal(
      (allByText('button', /Send/)[0] as unknown as { disabled: boolean })
        .disabled,
      true,
    );
  } finally {
    teardownDom();
  }
});

void test('a withdrawn message shows as withdrawn, and a reader is offered no composer', async () => {
  setupDom();
  server(() => [
    200,
    {
      items: [
        message({ sequence: 1, id: 'gone', body: '', deleted: Date.now() }),
        message({ sequence: 2, id: 'kept' }),
      ],
      latest: 2,
      me: 'user:someone-else',
    },
  ]);
  try {
    await render(mount(false));
    await settle();
    assert.match(screen().textContent ?? '', /Message withdrawn/);
    assert.equal(screen().querySelectorAll('textarea').length, 0);
    assert.equal(allByText('button', /Send/).length, 0);
    // Not their messages, so no withdraw control is offered either.
    assert.equal(screen().querySelectorAll('.team-chat-line button').length, 0);
  } finally {
    teardownDom();
  }
});
