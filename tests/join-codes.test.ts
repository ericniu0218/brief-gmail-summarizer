import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { WorkspaceStore, type Principal } from '../server/workspaces/store';
import { GET, POST, DELETE } from '../app/api/v1/[...path]/route';
import type { Runtime } from '../server/runtime';

/**
 * Reusable group codes, the way a team actually joins a workspace: one code typed by
 * everyone rather than one invitation link per person.
 *
 * A code is short enough to read down a phone, so these tests care most about the limits
 * that make a short secret safe — a single live code per workspace, a bounded role, a
 * refusal that reveals nothing, and a cap on guessing.
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
/** A well-formed code that was never issued. */
const unissued = (n: number) => `ZZZZZZ${'AB'[n % 2]}${'CDEFGHJKMN'[n % 10]}`;

async function setup() {
  const { db, sql } = database();
  const owner = new WorkspaceStore(db, person('owner'));
  const ws = await owner.createWorkspace('Antibody A');
  return {
    db,
    sql,
    owner,
    ws,
    luke: new WorkspaceStore(db, person('luke')),
    ethan: new WorkspaceStore(db, person('ethan')),
    stranger: new WorkspaceStore(db, person('stranger')),
  };
}
/** The exact refusal, so separate reasons can be compared for indistinguishability. */
async function refusal(store: WorkspaceStore, code: string) {
  try {
    await store.join(code);
  } catch (error) {
    const failure = error as { status: number; message: string };
    return `${failure.status}: ${failure.message}`;
  }
  return assert.fail('The code was accepted.');
}

void test('one group code admits the whole team, however they type it', async () => {
  const { owner, ws, luke, ethan } = await setup();
  const code = await owner.createJoinCode(ws.id, { role: 'editor' });
  assert.match(code.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  // The characters people confuse when a code is read aloud are not in the alphabet.
  assert.doesNotMatch(code.code, /[OIL0U1]/);
  assert.deepEqual(await luke.join(code.code), {
    workspaceId: ws.id,
    joined: true,
  });
  // Lower case, spaces for the dash: the same code.
  assert.deepEqual(await ethan.join(code.code.toLowerCase().replace('-', ' ')), {
    workspaceId: ws.id,
    joined: true,
  });
  const roles = new Map(
    (await owner.members(ws.id)).map((m) => [m.userId, m.role]),
  );
  assert.equal(roles.size, 3);
  assert.equal(roles.get('owner'), 'owner');
  assert.equal(roles.get('luke'), 'editor');
  assert.equal(roles.get('ethan'), 'editor');
  assert.equal((await owner.joinCode(ws.id))?.uses, 2);
});

void test('joining again spends no use and never changes an existing role', async () => {
  const { owner, ws, luke } = await setup();
  const code = await owner.createJoinCode(ws.id, { role: 'viewer' });
  await luke.join(code.code);
  assert.deepEqual(await luke.join(code.code), {
    workspaceId: ws.id,
    joined: false,
  });
  // An owner typing the group code must not be demoted to the code's role.
  assert.deepEqual(await owner.join(code.code), {
    workspaceId: ws.id,
    joined: false,
  });
  const roles = new Map(
    (await owner.members(ws.id)).map((m) => [m.userId, m.role]),
  );
  assert.equal(roles.get('owner'), 'owner');
  assert.equal(roles.get('luke'), 'viewer');
  assert.equal((await owner.joinCode(ws.id))?.uses, 1);
});

void test('a revoked, expired, exhausted or unknown code is refused identically', async () => {
  const { owner, ws, luke, ethan, sql } = await setup();
  const limited = await owner.createJoinCode(ws.id, {
    role: 'viewer',
    maxUses: 1,
  });
  await luke.join(limited.code);
  const exhausted = await refusal(ethan, limited.code);
  const unknown = await refusal(ethan, unissued(0));
  assert.equal(exhausted, unknown);

  const fresh = await owner.createJoinCode(ws.id, { role: 'viewer' });
  sql
    .prepare('UPDATE workspace_join_codes SET expires = ? WHERE code = ?')
    .run(Date.now() - 1000, fresh.code.replace('-', ''));
  assert.equal(await refusal(ethan, fresh.code), unknown);

  const live = await owner.createJoinCode(ws.id, { role: 'viewer' });
  await owner.revokeJoinCode(ws.id);
  assert.equal(await refusal(ethan, live.code), unknown);
  assert.equal(await owner.joinCode(ws.id), null);
  // Nobody joined on any of those paths.
  assert.equal((await owner.members(ws.id)).length, 2);
});

void test('replacing the code retires the old one and leaves exactly one live code', async () => {
  const { owner, ws, luke, sql } = await setup();
  const first = await owner.createJoinCode(ws.id, { role: 'editor' });
  const second = await owner.createJoinCode(ws.id, { role: 'viewer' });
  assert.notEqual(first.code, second.code);
  await assert.rejects(() => luke.join(first.code), denied(404));
  assert.deepEqual(await luke.join(second.code), {
    workspaceId: ws.id,
    joined: true,
  });
  assert.equal(
    (await owner.members(ws.id)).find((m) => m.userId === 'luke')?.role,
    'viewer',
  );
  assert.equal((await owner.joinCode(ws.id))?.code, second.code);
  assert.equal(
    (
      sql
        .prepare(
          'SELECT COUNT(*) AS live FROM workspace_join_codes WHERE workspace_id = ? AND revoked IS NULL',
        )
        .get(ws.id) as { live: number }
    ).live,
    1,
  );
});

void test('a removed member can be let back in with the current code', async () => {
  const { owner, ws, luke } = await setup();
  const code = await owner.createJoinCode(ws.id, { role: 'editor' });
  await luke.join(code.code);
  await owner.changeMember(ws.id, 'luke', null);
  assert.equal((await owner.members(ws.id)).length, 1);
  assert.deepEqual(await luke.join(code.code), {
    workspaceId: ws.id,
    joined: true,
  });
  assert.equal((await owner.joinCode(ws.id))?.uses, 2);
});

void test('only an owner handles the code, and it cannot grant more than editor', async () => {
  const { owner, ws, luke, stranger } = await setup();
  const code = await owner.createJoinCode(ws.id, { role: 'viewer' });
  await luke.join(code.code);
  await assert.rejects(() => luke.joinCode(ws.id), denied(403));
  await assert.rejects(
    () => luke.createJoinCode(ws.id, { role: 'editor' }),
    denied(403),
  );
  await assert.rejects(() => luke.revokeJoinCode(ws.id), denied(403));
  // A non-member is told the workspace does not exist, not that they lack a role.
  await assert.rejects(() => stranger.joinCode(ws.id), denied(404));
  await assert.rejects(
    () => owner.createJoinCode(ws.id, { role: 'owner' }),
    denied(400),
  );
  await assert.rejects(
    () => owner.createJoinCode(ws.id, { role: 'viewer', days: 365 }),
    denied(400),
  );
  await assert.rejects(
    () => owner.createJoinCode(ws.id, { role: 'viewer', maxUses: 0 }),
    denied(400),
  );
  // Every rejection happened before the batch, so the working code still works.
  assert.equal((await owner.joinCode(ws.id))?.code, code.code);
});

void test('guessing is capped, while a mistyped code is not counted as a guess', async () => {
  const { owner, ws, luke, ethan, sql } = await setup();
  const code = await owner.createJoinCode(ws.id, { role: 'editor' });
  // The wrong shape is a typo, answered by describing a code and charged to nobody.
  for (let attempt = 0; attempt < 15; attempt++)
    await assert.rejects(() => luke.join('nope'), denied(400));
  assert.deepEqual(await luke.join(code.code), {
    workspaceId: ws.id,
    joined: true,
  });
  // Real guesses are counted, and the lockout then refuses even the correct code.
  for (let attempt = 0; attempt < 10; attempt++)
    await assert.rejects(() => ethan.join(unissued(attempt)), denied(404));
  await assert.rejects(() => ethan.join(code.code), denied(429));
  assert.equal((await owner.members(ws.id)).length, 2);
  // The count is a window, not a permanent ban.
  sql
    .prepare('UPDATE join_attempts SET window_start = ? WHERE user_id = ?')
    .run(Date.now() - 11 * 60000, 'ethan');
  assert.deepEqual(await ethan.join(code.code), {
    workspaceId: ws.id,
    joined: true,
  });
});

void test('HTTP flow: an owner issues a code, a teammate joins with it, and it is turned off', async () => {
  const { db, ws } = await setup();
  globalThis.__briefTestEnv = {
    DB: db,
    APP_URL: 'https://brief.example',
  } as Runtime;
  const headers = (id: string) =>
    new Headers({
      'x-brief-identity-secret':
        'test-ingress-secret-for-authenticated-proxy',
      'oai-authenticated-user-id': id,
      'oai-authenticated-user-email': `${id}@example.com`,
    });
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

  globalThis.__briefTestHeaders = headers('owner');
  const empty = await GET(call(`workspaces/${ws.id}/code`, 'GET'));
  assert.deepEqual(await empty.json(), { code: null });
  // A browser request from another origin cannot mint a code.
  assert.equal(
    (
      await POST(
        call(`workspaces/${ws.id}/code`, 'POST', { role: 'editor' }, {
          origin: 'https://evil.example',
        }),
      )
    ).status,
    403,
  );
  const created = await POST(
    call(`workspaces/${ws.id}/code`, 'POST', { role: 'editor' }),
  );
  assert.equal(created.status, 201);
  const { code } = (await created.json()) as { code: string };

  globalThis.__briefTestHeaders = headers('luke');
  const joined = await POST(call('join', 'POST', { token: code }));
  assert.equal(joined.status, 200);
  assert.deepEqual(await joined.json(), { workspaceId: ws.id, joined: true });
  // A member who is not the owner cannot read the code out of the workspace.
  assert.equal((await GET(call(`workspaces/${ws.id}/code`, 'GET'))).status, 403);

  globalThis.__briefTestHeaders = headers('owner');
  const seen = (await (
    await GET(call(`workspaces/${ws.id}/code`, 'GET'))
  ).json()) as { code: { uses: number; role: string } };
  assert.equal(seen.code.uses, 1);
  assert.equal(seen.code.role, 'editor');
  assert.equal(
    (await DELETE(call(`workspaces/${ws.id}/code`, 'DELETE'))).status,
    200,
  );

  globalThis.__briefTestHeaders = headers('ethan');
  const refused = await POST(call('join', 'POST', { token: code }));
  assert.equal(refused.status, 404);
});
