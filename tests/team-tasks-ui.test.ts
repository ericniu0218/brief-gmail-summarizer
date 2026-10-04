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
import { TeamTasks } from '../components/team-tasks';
import type { Task } from '../lib/tasks';
import type { Member } from '../lib/workspaces/contracts';

/**
 * The Tasks tab, from the reader's side: the groups answer who is on what, and a save that
 * lost a race says so instead of appearing to have worked.
 */

const members: Member[] = [
  { userId: 'luke', displayName: 'Luke', role: 'editor', joined: 1 },
  { userId: 'ethan', displayName: 'Ethan', role: 'editor', joined: 2 },
];
const DAY = 86400000;
const task = (over: Partial<Task>): Task => ({
  id: 'id',
  workspaceId: 'ws-1',
  title: 'Task',
  detail: '',
  status: 'todo',
  assigneeId: null,
  assigneeName: null,
  dueAt: null,
  dueKind: null,
  createdBy: 'user:luke',
  creatorName: 'Luke',
  created: 1,
  updated: 1,
  version: 1,
  completed: null,
  ...over,
});
type Call = { url: string; method: string; body: unknown };
/** A fetch stub that answers from a script and records what the component sent. */
function server(script: ((call: Call) => [number, unknown]) | undefined) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const [status, data] = script?.(call) ?? [200, { items: [], me: { userId: null } }];
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}
function choose(element: Element, value: string) {
  (element as unknown as HTMLSelectElement).value = value;
  element.dispatchEvent(new (screen().ownerDocument.defaultView as unknown as {
    Event: typeof Event;
  }).Event('change', { bubbles: true }));
}
const mount = (
  calls: Call[],
  over: Partial<Parameters<typeof TeamTasks>[0]> = {},
) => {
  const notices: string[] = [];
  const element = createElement(TeamTasks, {
    workspaceId: 'ws-1',
    members,
    canWrite: true,
    busy: false,
    // The real page runs every action through one busy-and-error wrapper; this is that
    // contract, so a failed save has to reach the notice to pass.
    act: (fn: () => Promise<void>) => {
      void fn().catch((error: unknown) =>
        notices.push((error as Error).message),
      );
    },
    notify: (message: string) => notices.push(message),
    ...over,
  });
  void calls;
  return { element, notices };
};

void test('the tasks tab groups work by person, with what is late called out', async () => {
  setupDom();
  const now = Date.now();
  const items = [
    task({
      id: 'late',
      title: 'Run the assay',
      assigneeId: 'luke',
      assigneeName: 'Luke',
      dueAt: now - DAY,
      dueKind: 'day',
    }),
    task({ id: 'open', title: 'Order reagents' }),
    task({ id: 'shipped', title: 'Book the microscope', status: 'done' }),
  ];
  const calls = server(() => [200, { items, me: { userId: 'luke' } }]);
  try {
    const { element } = mount(calls);
    await render(element);
    await settle();
    const text = screen().textContent ?? '';
    // Finished work is not counted as open.
    assert.match(text, /2 open · 1 overdue · 0 due today · 1 unassigned/);
    assert.match(text, /Unassigned/);
    assert.match(text, /Luke/);
    // Ethan has nothing, and is still listed: that is an answer about who is free.
    assert.match(text, /Ethan/);
    assert.match(text, /Nothing assigned/);
    assert.equal(allByText('.team-task-late', /Overdue/).length, 1);
    // Finished work is struck through rather than hidden.
    assert.equal(screen().querySelectorAll('.team-task.closed').length, 1);
  } finally {
    teardownDom();
  }
});

void test('changing a task sends the version it was showing, and a lost race is reported', async () => {
  setupDom();
  const mine = task({
    id: 'one',
    title: 'Run the assay',
    assigneeId: 'luke',
    assigneeName: 'Luke',
    version: 3,
  });
  // The server has already moved on: somebody else set it to blocked as version 4.
  const moved = { ...mine, status: 'blocked' as const, version: 4 };
  let saved = false;
  const calls = server((call) => {
    if (call.method === 'PATCH') {
      saved = true;
      return [409, { error: 'Someone else changed this task first.' }];
    }
    return [200, { items: [saved ? moved : mine], me: { userId: 'luke' } }];
  });
  try {
    const { element, notices } = mount(calls);
    await render(element);
    await settle();
    choose(byLabel('Status of Run the assay'), 'doing');
    await settle();
    const patch = calls.find((call) => call.method === 'PATCH');
    assert.deepEqual(patch?.body, { version: 3, status: 'doing' });
    assert.deepEqual(notices, ['Someone else changed this task first.']);
    // The refused change is not left on screen; the list shows what the server holds.
    await settle();
    assert.match(screen().textContent ?? '', /Blocked/);
    assert.equal(
      (byLabel('Status of Run the assay') as unknown as HTMLSelectElement).value,
      'blocked',
    );
  } finally {
    teardownDom();
  }
});

void test('a read-only member sees the work but is offered no controls', async () => {
  setupDom();
  const calls = server(() => [
    200,
    {
      items: [task({ id: 'one', title: 'Run the assay' })],
      me: { userId: 'viewer' },
    },
  ]);
  try {
    const { element } = mount(calls, { canWrite: false });
    await render(element);
    await settle();
    assert.match(screen().textContent ?? '', /Run the assay/);
    assert.equal(allByText('button', /Add task/).length, 0);
    assert.equal(screen().querySelectorAll('select').length, 0);
    assert.equal(
      calls.filter((call) => call.method !== 'GET').length,
      0,
      'a viewer never sends a change',
    );
  } finally {
    teardownDom();
  }
});
