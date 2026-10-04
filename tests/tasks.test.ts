import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { WorkspaceStore, type Principal } from '../server/workspaces/store';
import { GET, POST, PATCH, DELETE } from '../app/api/v1/[...path]/route';
import type { Runtime } from '../server/runtime';
import {
  byDeadline,
  byPerson,
  byStatus,
  dueBucket,
  dueLabel,
  sortTasks,
  taskDueAt,
  taskSummary,
  type Task,
} from '../lib/tasks';
import { obligationDueAt } from '../lib/classification';

/**
 * Team tasks: who is doing what, by when.
 *
 * A task is the first shared record that changes after it is written, so most of these
 * tests are about two people touching one task at once, and about a deadline meaning the
 * same thing here as it does for mail.
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
  const ethan = new WorkspaceStore(db, person('ethan'));
  const viewer = new WorkspaceStore(db, person('viewer'));
  const code = await owner.createJoinCode(ws.id, { role: 'editor' });
  await luke.join(code.code);
  await ethan.join(code.code);
  await viewer.join((await owner.createInvite(ws.id, 'viewer')).token);
  return {
    db,
    sql,
    ws,
    owner,
    luke,
    ethan,
    viewer,
    outsider: new WorkspaceStore(db, person('outsider')),
  };
}
let keys = 0;
const add = (store: WorkspaceStore, ws: string, task: Record<string, unknown>) =>
  store.createTask(ws, task, `task-${keys++}`);

void test('a task records who is doing it and when it is due, for everyone to see', async () => {
  const { ws, owner, luke, viewer } = await setup();
  const made = await add(owner, ws.id, {
    title: 'Run the binding assay',
    detail: 'Three replicates.',
    assigneeId: 'luke',
    due: '2026-10-09',
  });
  assert.equal(made.assigneeId, 'luke');
  assert.equal(made.assigneeName, 'Person luke');
  assert.equal(made.status, 'todo');
  assert.equal(made.version, 1);
  assert.equal(made.completed, null);
  // A deadline given as a day falls due when mail with that deadline falls due.
  assert.equal(made.dueKind, 'day');
  assert.equal(
    made.dueAt,
    obligationDueAt({
      kind: 'deadline',
      required: true,
      ownerIsUser: true,
      state: 'open',
      due: { phrase: 'Oct 9', date: '2026-10-09', ambiguous: false },
    } as Parameters<typeof obligationDueAt>[0]),
  );
  // The assignee and a read-only member see exactly the same record.
  for (const reader of [luke, viewer]) {
    const seen = (await reader.tasks(ws.id)).items;
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], made);
  }
  assert.equal((await luke.tasks(ws.id)).me.userId, 'luke');
});

void test('two people editing one task cannot overwrite each other', async () => {
  const { ws, owner, luke, ethan } = await setup();
  const made = await add(owner, ws.id, { title: 'Order reagents' });
  // Both are looking at version 1.
  const moved = await luke.updateTask(ws.id, made.id, {
    version: made.version,
    status: 'doing',
  });
  assert.equal(moved.version, 2);
  await assert.rejects(
    () =>
      ethan.updateTask(ws.id, made.id, {
        version: made.version,
        status: 'blocked',
      }),
    denied(409),
  );
  // Luke's change survived the refused write.
  assert.equal((await ethan.tasks(ws.id)).items[0].status, 'doing');
  // Editing different fields of the current version is not a conflict, and an update sends
  // only what it changes, so neither person reverts the other's field.
  const dated = await ethan.updateTask(ws.id, made.id, {
    version: moved.version,
    due: '2026-10-09',
  });
  const titled = await luke.updateTask(ws.id, made.id, {
    version: dated.version,
    title: 'Order reagents for the assay',
  });
  assert.equal(titled.title, 'Order reagents for the assay');
  assert.equal(titled.status, 'doing');
  assert.equal(titled.dueAt, dated.dueAt);
  assert.equal(titled.version, 4);
});

void test('work can only be given to someone who is in the workspace', async () => {
  const { ws, owner } = await setup();
  await assert.rejects(
    () => add(owner, ws.id, { title: 'Assay', assigneeId: 'outsider' }),
    denied(400),
  );
  const made = await add(owner, ws.id, { title: 'Assay', assigneeId: 'luke' });
  await assert.rejects(
    () =>
      owner.updateTask(ws.id, made.id, {
        version: made.version,
        assigneeId: 'nobody',
      }),
    denied(400),
  );
  // Removing a member leaves their work in place rather than deleting it.
  await owner.changeMember(ws.id, 'luke', null);
  const kept = (await owner.tasks(ws.id)).items[0];
  assert.equal(kept.assigneeId, 'luke');
  assert.equal(kept.assigneeName, 'Person luke');
  const groups = byPerson([kept], await owner.members(ws.id));
  assert.equal(
    groups.find((group) => group.key === 'luke')?.label,
    'Person luke (left)',
  );
  // Only that one group holds it; it did not also fall into Unassigned.
  assert.deepEqual(
    groups.filter((group) => group.tasks.length).map((group) => group.key),
    ['luke'],
  );
  // It can still be handed to somebody who is here.
  const reassigned = await owner.updateTask(ws.id, kept.id, {
    version: kept.version,
    assigneeId: 'ethan',
  });
  assert.equal(reassigned.assigneeName, 'Person ethan');
});

void test('a viewer reads the task list but changes nothing, and an outsider sees none of it', async () => {
  const { ws, owner, viewer, outsider } = await setup();
  const made = await add(owner, ws.id, { title: 'Assay', assigneeId: 'luke' });
  assert.equal((await viewer.tasks(ws.id)).items.length, 1);
  await assert.rejects(() => add(viewer, ws.id, { title: 'Mine' }), denied(403));
  await assert.rejects(
    () => viewer.updateTask(ws.id, made.id, { version: 1, status: 'done' }),
    denied(403),
  );
  await assert.rejects(() => viewer.deleteTask(ws.id, made.id), denied(403));
  await assert.rejects(() => outsider.tasks(ws.id), denied(404));
  await assert.rejects(
    () => outsider.updateTask(ws.id, made.id, { version: 1, status: 'done' }),
    denied(404),
  );
});

void test('finishing stamps the time, reopening clears it, and a retry adds one task', async () => {
  const { ws, owner } = await setup();
  const made = await owner.createTask(
    ws.id,
    { title: 'Write up results' },
    'same-key',
  );
  const again = await owner.createTask(
    ws.id,
    { title: 'Write up results' },
    'same-key',
  );
  assert.equal(again.id, made.id);
  assert.equal((await owner.tasks(ws.id)).items.length, 1);

  const done = await owner.updateTask(ws.id, made.id, {
    version: made.version,
    status: 'done',
  });
  assert.ok(done.completed !== null);
  // Editing something else must not restamp the completion time.
  const edited = await owner.updateTask(ws.id, made.id, {
    version: done.version,
    title: 'Write up the results',
  });
  assert.equal(edited.completed, done.completed);
  const reopened = await owner.updateTask(ws.id, made.id, {
    version: edited.version,
    status: 'doing',
  });
  assert.equal(reopened.completed, null);
});

void test('only an owner or the person who added a task can delete it', async () => {
  const { ws, owner, luke, ethan } = await setup();
  const mine = await add(luke, ws.id, { title: 'Luke task' });
  await assert.rejects(() => ethan.deleteTask(ws.id, mine.id), denied(403));
  await luke.deleteTask(ws.id, mine.id);
  const theirs = await add(ethan, ws.id, { title: 'Ethan task' });
  await owner.deleteTask(ws.id, theirs.id);
  assert.equal((await owner.tasks(ws.id)).items.length, 0);
  await assert.rejects(() => owner.deleteTask(ws.id, theirs.id), denied(404));
});

void test('a task belongs to one workspace and is invisible from another', async () => {
  const { ws, owner } = await setup();
  const other = await owner.createWorkspace('Antibody B');
  const made = await add(owner, ws.id, { title: 'Assay' });
  assert.equal((await owner.tasks(other.id)).items.length, 0);
  await assert.rejects(
    () => owner.updateTask(other.id, made.id, { version: 1, status: 'done' }),
    denied(404),
  );
  await assert.rejects(() => owner.deleteTask(other.id, made.id), denied(404));
});

void test('a deadline is taken as given, or refused rather than guessed at', async () => {
  const { ws, owner } = await setup();
  assert.deepEqual(taskDueAt(''), null);
  assert.deepEqual(taskDueAt(null), null);
  assert.equal(taskDueAt('2026-10-09')?.dueKind, 'day');
  assert.equal(taskDueAt('2026-10-09T15:30:00Z')?.dueKind, 'time');
  // A date that does not exist must not roll forward into the next month.
  assert.equal(taskDueAt('2026-02-30'), undefined);
  assert.equal(taskDueAt('next Friday'), undefined);
  assert.equal(taskDueAt('09/10/2026'), undefined);
  await assert.rejects(
    () => add(owner, ws.id, { title: 'Assay', due: '2026-02-30' }),
    denied(400),
  );
  const timed = await add(owner, ws.id, {
    title: 'Call',
    due: '2026-10-09T15:30:00Z',
  });
  assert.equal(timed.dueAt, Date.parse('2026-10-09T15:30:00Z'));
  // Clearing a deadline is a change like any other.
  const cleared = await owner.updateTask(ws.id, timed.id, {
    version: timed.version,
    due: null,
  });
  assert.equal(cleared.dueAt, null);
  assert.equal(cleared.dueKind, null);
});

void test('the views answer who is on what, what is late, and what is in progress', () => {
  // A fixed local morning, so "today" and "this week" do not depend on the test machine.
  const now = new Date(2026, 9, 9, 9, 0, 0).getTime();
  const at = (...parts: [number, number, number, number?, number?]) =>
    new Date(...(parts as [number, number, number])).getTime();
  const task = (over: Partial<Task>): Task => ({
    id: 'id',
    workspaceId: 'ws',
    title: 'Task',
    detail: '',
    status: 'todo',
    assigneeId: null,
    assigneeName: null,
    dueAt: null,
    dueKind: 'day',
    createdBy: 'user:owner',
    creatorName: 'Owner',
    created: 1,
    updated: 1,
    version: 1,
    completed: null,
    ...over,
  });
  const late = task({ id: 'late', dueAt: at(2026, 9, 8, 9), assigneeId: 'luke', assigneeName: 'Luke' });
  const today = task({ id: 'today', dueAt: at(2026, 9, 9, 17), assigneeId: 'luke', assigneeName: 'Luke' });
  const week = task({ id: 'week', dueAt: at(2026, 9, 12, 9), status: 'doing' });
  const later = task({ id: 'later', dueAt: at(2026, 9, 30, 9) });
  const undated = task({ id: 'undated', assigneeId: 'ethan', assigneeName: 'Ethan' });
  const finished = task({ id: 'finished', status: 'done', dueAt: at(2026, 9, 1, 9) });
  const all = [undated, finished, later, week, today, late];

  assert.equal(dueBucket(late, now), 'overdue');
  assert.equal(dueBucket(today, now), 'today');
  assert.equal(dueBucket(week, now), 'week');
  assert.equal(dueBucket(later, now), 'later');
  assert.equal(dueBucket(undated, now), 'none');
  // Finished work that was late is history, not a warning.
  assert.equal(dueBucket(finished, now), 'later');
  assert.match(dueLabel(late, now) ?? '', /^Overdue · /);
  assert.match(dueLabel(today, now) ?? '', /^Today · /);
  assert.equal(dueLabel(undated, now), undefined);
  // A day deadline shows no time of day, which it never had.
  assert.doesNotMatch(dueLabel(late, now) ?? '', /\d:\d/);
  assert.match(dueLabel(task({ dueAt: at(2026, 9, 12, 15), dueKind: 'time' }), now) ?? '', /\d:\d/);

  // Live work first, then the soonest deadline, with undated work ahead of finished work.
  assert.deepEqual(
    sortTasks(all).map((t) => t.id),
    ['late', 'today', 'week', 'later', 'undated', 'finished'],
  );
  assert.deepEqual(
    byDeadline(all, now).map((group) => [group.key, group.tasks.length]),
    [
      ['overdue', 1],
      ['today', 1],
      ['week', 1],
      ['later', 1],
      ['none', 1],
    ],
  );
  const people = byPerson(all, [
    { userId: 'luke', displayName: 'Luke' },
    { userId: 'ethan', displayName: 'Ethan' },
  ]);
  assert.deepEqual(
    people.map((group) => [group.label, group.tasks.map((t) => t.id)]),
    [
      ['Unassigned', ['week', 'later', 'finished']],
      ['Luke', ['late', 'today']],
      ['Ethan', ['undated']],
    ],
  );
  // A member with nothing on their plate is still listed; that is an answer too.
  assert.deepEqual(
    byPerson([], [{ userId: 'luke', displayName: 'Luke' }]).map((g) => g.label),
    ['Luke'],
  );
  assert.deepEqual(
    byStatus(all).map((group) => [group.key, group.tasks.length]),
    [
      ['todo', 4],
      ['doing', 1],
      ['done', 1],
    ],
  );
  assert.deepEqual(taskSummary(all, now), {
    open: 5,
    overdue: 1,
    today: 1,
    unassigned: 2,
  });
});

void test('HTTP flow: add a task, hand it on, finish it, and lose a stale save', async () => {
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
  const created = await POST(
    call(
      `workspaces/${ws.id}/tasks`,
      'POST',
      { title: 'Run the assay', assigneeId: 'luke', due: '2026-10-09' },
      { 'idempotency-key': 'http-task-1' },
    ),
  );
  assert.equal(created.status, 201);
  const task = (await created.json()) as Task;
  assert.equal(task.assigneeName, 'Person luke');

  globalThis.__briefTestHeaders = identity('luke');
  const taken = await PATCH(
    call(`workspaces/${ws.id}/tasks/${task.id}`, 'PATCH', {
      version: task.version,
      status: 'doing',
    }),
  );
  assert.equal(taken.status, 200);
  const live = (await taken.json()) as Task;
  // The owner saves from a page that has not refreshed since.
  globalThis.__briefTestHeaders = identity('owner');
  const stale = await PATCH(
    call(`workspaces/${ws.id}/tasks/${task.id}`, 'PATCH', {
      version: task.version,
      status: 'cancelled',
    }),
  );
  assert.equal(stale.status, 409);
  const listed = (await (
    await GET(call(`workspaces/${ws.id}/tasks`, 'GET'))
  ).json()) as { items: Task[]; me: { userId: string } };
  assert.equal(listed.items[0].status, 'doing');
  assert.equal(listed.me.userId, 'owner');
  assert.equal(
    (
      await PATCH(
        call(`workspaces/${ws.id}/tasks/${task.id}`, 'PATCH', {
          version: live.version,
          status: 'done',
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (await DELETE(call(`workspaces/${ws.id}/tasks/${task.id}`, 'DELETE'))).status,
    200,
  );
});
