import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import {
  WorkspaceStore,
  integrationPrincipal,
  type Principal,
} from '../server/workspaces/store';
import { compressText, foldCorpus } from '../server/workspaces/processors';
import { canonical, hash } from '../server/workspaces/validation';
import { gmailPreview } from '../server/workspaces/gmail-adapter';
import { GET, POST, DELETE } from '../app/api/v1/[...path]/route';
import type { Runtime } from '../server/runtime';
import { WorkspaceClient, WorkspaceApiError } from '../lib/workspaces/client';

/** SQL-backed D1 adapter: executes real generated migrations, constraints, queries, and atomic batches. */
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync('drizzle')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(`drizzle/${name}`, 'utf8'));
  class Statement {
    values: (string | number | null)[] = [];
    constructor(readonly query: string) {}
    bind(...values: (string | number | null)[]) {
      this.values = values;
      return this;
    }
    execute() {
      const statement = sql.prepare(this.query);
      const results = statement.columns().length
        ? statement.all(...this.values)
        : [];
      const change = statement.columns().length
        ? { changes: 0, lastInsertRowid: 0 }
        : statement.run(...this.values);
      return {
        results,
        success: true,
        meta: {
          changes: Number(change.changes),
          last_row_id: Number(change.lastInsertRowid),
          duration: 0,
        },
      };
    }
    async first() {
      return this.execute().results[0] ?? null;
    }
    async all() {
      return this.execute();
    }
    async run() {
      return this.execute();
    }
  }
  const db = {
    prepare: (q: string) => new Statement(q),
    async batch(statements: Statement[]) {
      sql.exec('BEGIN');
      try {
        const result = statements.map((s) => s.execute());
        sql.exec('COMMIT');
        return result;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { db, sql };
}
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
  const ws = await owner.createWorkspace('Launch team');
  const editor = new WorkspaceStore(db, person('editor'));
  const viewer = new WorkspaceStore(db, person('viewer'));
  await editor.join((await owner.createInvite(ws.id, 'editor')).token);
  await viewer.join((await owner.createInvite(ws.id, 'viewer')).token);
  return {
    db,
    sql,
    owner,
    editor,
    viewer,
    ws,
    outsider: new WorkspaceStore(db, person('outsider')),
  };
}
const corpus = () =>
  compressText(
    'Research corpus',
    'First passage with launch evidence.\n\nSecond passage with supporting evidence.',
  );

void test('two users share the same immutable corpus and fold across independent clients', async () => {
  const { owner, editor, viewer, ws } = await setup();
  const saved = await owner.publish(ws.id, corpus(), 'capture-1');
  const read = await editor.getArtifact(ws.id, saved.artifact.id);
  assert.deepEqual(read, saved.artifact);
  const folded = await editor.publish(ws.id, foldCorpus(read), 'fold-1');
  assert.equal(folded.artifact.createdBy, 'user:editor');
  assert.deepEqual(folded.artifact.parentIds, [read.id]);
  const teammate = await viewer.getArtifact(ws.id, folded.artifact.id);
  assert.equal(teammate.checksum, folded.artifact.checksum);
  assert.equal(
    (await viewer.listArtifacts(ws.id, new URLSearchParams())).items.length,
    2,
  );
  assert.equal(await hash(canonical(teammate.content)), teammate.checksum);
});

void test('membership, role checks, and parent links prevent cross-workspace access', async () => {
  const { owner, editor, viewer, ws, outsider } = await setup();
  const item = (await owner.publish(ws.id, corpus(), 'one')).artifact;
  await assert.rejects(outsider.getArtifact(ws.id, item.id), denied(404));
  await assert.rejects(viewer.publish(ws.id, corpus(), 'two'), denied(403));
  await assert.rejects(editor.createInvite(ws.id, 'editor'), denied(403));
  const other = await outsider.createWorkspace('Other');
  await assert.rejects(
    outsider.publish(other.id, { ...corpus(), parentIds: [item.id] }, 'parent'),
    denied(404),
  );
  await assert.rejects(owner.changeMember(ws.id, 'owner', null), denied(409));
});

void test('idempotency canonicalizes object keys and rejects changed payloads without duplicate events', async () => {
  const { owner, ws } = await setup();
  const input = corpus();
  const responses = await Promise.all([
    owner.publish(ws.id, input, 'same'),
    owner.publish(
      ws.id,
      {
        ...input,
        content: Object.fromEntries(Object.entries(input.content).reverse()),
      },
      'same',
    ),
  ]);
  assert.equal(responses[0].artifact.id, responses[1].artifact.id);
  assert.equal(responses.filter((r) => r.replayed).length, 1);
  await assert.rejects(
    owner.publish(ws.id, { ...input, title: 'Changed' }, 'same'),
    denied(409),
  );
  assert.equal(
    (await owner.events(ws.id, new URLSearchParams())).items.filter(
      (e) => e.type === 'artifact.created',
    ).length,
    1,
  );
});

void test('artifact and activity event roll back together when a statement fails', async () => {
  const { owner, ws, sql } = await setup();
  sql.exec(
    "CREATE TRIGGER reject_artifact_event BEFORE INSERT ON workspace_events WHEN NEW.type = 'artifact.created' BEGIN SELECT RAISE(ABORT, 'forced event failure'); END",
  );
  await assert.rejects(owner.publish(ws.id, corpus(), 'rollback'));
  assert.equal(
    (await owner.listArtifacts(ws.id, new URLSearchParams())).items.length,
    0,
  );
});

void test('invites are single-use under concurrent redemption and cannot restore a removed member', async () => {
  const { owner, ws, db } = await setup();
  const invite = await owner.createInvite(ws.id, 'viewer');
  const a = new WorkspaceStore(db, person('a'));
  const b = new WorkspaceStore(db, person('b'));
  const result = await Promise.allSettled([
    a.join(invite.token),
    b.join(invite.token),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = result[0].status === 'fulfilled' ? a : b;
  assert.equal((await winner.join(invite.token)).workspaceId, ws.id);
  await owner.changeMember(ws.id, winner.actor.id, null);
  await assert.rejects(winner.join(invite.token), denied(409));
  await assert.rejects(
    winner.listArtifacts(ws.id, new URLSearchParams()),
    denied(404),
  );
});

void test('revoked and expired invites fail; a new invite does not downgrade existing roles', async () => {
  const { owner, editor, ws, sql } = await setup();
  const existing = await owner.createInvite(ws.id, 'viewer');
  await editor.join(existing.token);
  assert.equal((await editor.listWorkspaces())[0].role, 'editor');
  const revoked = await owner.createInvite(ws.id, 'viewer');
  await owner.revokeInvite(ws.id, revoked.id);
  await assert.rejects(editor.join(revoked.token), denied(404));
  const expired = await owner.createInvite(ws.id, 'viewer');
  sql
    .prepare('UPDATE workspace_invites SET expires = 1 WHERE id = ?')
    .run(expired.id);
  await assert.rejects(editor.join(expired.token), denied(404));
});

void test('integration keys are hashed, scoped, workspace-bound, expiring and revocable', async () => {
  const { owner, ws, db, sql } = await setup();
  const read = await owner.createToken(ws.id, {
    name: 'Reader',
    scope: 'read',
  });
  const stored = sql
    .prepare('SELECT token_hash FROM workspace_tokens WHERE id = ?')
    .get(read.id)!;
  assert.notEqual(stored.token_hash, read.token);
  assert.equal(String(stored.token_hash).length, 64);
  const client = new WorkspaceStore(
    db,
    await integrationPrincipal(db, read.token),
  );
  assert.deepEqual(
    (await client.listArtifacts(ws.id, new URLSearchParams())).items,
    [],
  );
  await assert.rejects(client.publish(ws.id, corpus(), 'blocked'), denied(403));
  await assert.rejects(client.createInvite(ws.id, 'editor'), denied(403));
  const other = await owner.createWorkspace('Elsewhere');
  await assert.rejects(
    client.listArtifacts(other.id, new URLSearchParams()),
    denied(403),
  );
  const write = await owner.createToken(ws.id, {
    name: 'Writer',
    scope: 'write',
  });
  const writer = new WorkspaceStore(
    db,
    await integrationPrincipal(db, write.token),
  );
  assert.equal(
    (await writer.publish(ws.id, corpus(), 'write')).artifact.createdBy,
    `integration:${write.id}`,
  );
  await owner.revokeToken(ws.id, read.id);
  await assert.rejects(integrationPrincipal(db, read.token), denied(401));
  sql
    .prepare('UPDATE workspace_tokens SET expires = 1 WHERE id = ?')
    .run(write.id);
  await assert.rejects(integrationPrincipal(db, write.token), denied(401));
});

void test('role changes and member removal affect the next request', async () => {
  const { owner, editor, ws } = await setup();
  await owner.changeMember(ws.id, 'editor', 'viewer');
  await assert.rejects(editor.publish(ws.id, corpus(), 'denied'), denied(403));
  await owner.changeMember(ws.id, 'editor', null);
  assert.deepEqual(await editor.listWorkspaces(), []);
  await assert.rejects(
    editor.events(ws.id, new URLSearchParams()),
    denied(404),
  );
});

void test('pagination uses stable tie breakers, literal search, metadata-only lists, and resumable event cursors', async () => {
  const { owner, ws, sql } = await setup();
  for (let i = 0; i < 4; i++)
    await owner.publish(
      ws.id,
      { ...corpus(), title: `Research ${i}` },
      `page-${i}`,
    );
  sql
    .prepare(
      'UPDATE workspace_artifacts SET created = 1000 WHERE workspace_id = ?',
    )
    .run(ws.id);
  const first = await owner.listArtifacts(
    ws.id,
    new URLSearchParams({ limit: '2' }),
  );
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.ok(!('content' in first.items[0]));
  const second = await owner.listArtifacts(
    ws.id,
    new URLSearchParams({ limit: '2', cursor: first.nextCursor }),
  );
  assert.equal(
    new Set([...first.items, ...second.items].map((i) => i.id)).size,
    4,
  );
  assert.equal(second.nextCursor, null);
  assert.equal(
    (await owner.listArtifacts(ws.id, new URLSearchParams({ q: '%' }))).items
      .length,
    0,
  );
  const feed = await owner.events(ws.id, new URLSearchParams({ limit: '2' }));
  assert.equal(feed.hasMore, true);
  const next = await owner.events(
    ws.id,
    new URLSearchParams({ after: String(feed.nextAfter) }),
  );
  assert.ok(next.items.every((e) => e.sequence > feed.nextAfter));
  await assert.rejects(
    owner.listArtifacts(ws.id, new URLSearchParams({ cursor: 'bad' })),
    denied(400),
  );
});

void test('custom kinds round-trip while reserved schemas, oversized requests, and invalid citations are rejected', async () => {
  const { owner, ws } = await setup();
  const custom = {
    ...corpus(),
    kind: 'research.summary',
    schemaVersion: 8,
    content: { findings: ['Evidence'], score: 0.8 },
  };
  assert.deepEqual(
    (await owner.publish(ws.id, custom, 'custom')).artifact.content,
    custom.content,
  );
  await assert.rejects(
    owner.publish(ws.id, { ...custom, kind: 'brief.unknown' }, 'unknown'),
    denied(400),
  );
  await assert.rejects(
    owner.publish(ws.id, { ...corpus(), schemaVersion: 2 }, 'v2'),
    denied(400),
  );
  const parent = (await owner.publish(ws.id, corpus(), 'parent')).artifact;
  const fold = foldCorpus(parent);
  await assert.rejects(
    owner.publish(
      ws.id,
      {
        ...fold,
        content: {
          method: 'custom',
          groups: [
            { source: 'Text', text: 'Made up', documentIds: ['nonexistent'] },
          ],
        },
      },
      'citation',
    ),
    denied(400),
  );
  await assert.rejects(
    owner.publish(
      ws.id,
      { ...custom, content: { text: 'x'.repeat(270000) } },
      'huge',
    ),
    denied(413),
  );
});

void test('Gmail adapter shares selected summaries only and requires ownership of the account snapshot', async () => {
  const { db } = await setup();
  const email = {
    id: 'mail-1',
    subject: 'Selected',
    summary: 'Safe summary',
    sender: 'Colleague',
    body: 'Private raw body',
    address: 'private@example.com',
    unsubscribe: 'https://secret.example',
  };
  await db
    .prepare('INSERT INTO snapshots (user_id, data, updated) VALUES (?, ?, ?)')
    .bind('owner', JSON.stringify({ emails: [email], ai: true }), 1000)
    .run();
  const preview = await gmailPreview(db, 'owner', {
    accountId: 'default',
    messageIds: ['mail-1'],
    title: 'Team summary',
  });
  assert.ok(!JSON.stringify(preview).includes('Private raw body'));
  assert.ok(!JSON.stringify(preview).includes('private@example.com'));
  assert.ok(!JSON.stringify(preview).includes('secret.example'));
  await assert.rejects(
    gmailPreview(db, 'other', {
      accountId: 'default',
      messageIds: ['mail-1'],
      title: 'Stolen',
    }),
    denied(404),
  );
  await assert.rejects(
    gmailPreview(db, 'owner', {
      accountId: 'default',
      messageIds: ['missing'],
      title: 'Missing',
    }),
    denied(409),
  );
});

void test('HTTP flow: auth, CSRF, preview, idempotent publish, fold, viewer read, key revocation and size limits', async () => {
  const { db, ws, owner } = await setup();
  globalThis.__briefTestEnv = {
    DB: db,
    APP_URL: 'https://brief.example',
  } as Runtime;
  const headers = (id: string) =>
    new Headers({
      'oai-authenticated-user-id': id,
      'oai-authenticated-user-email': `${id}@example.com`,
    });
  const call = (path: string, data?: unknown, extra?: Record<string, string>) =>
    new Request(`https://brief.example/api/v1/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        origin: 'https://brief.example',
        'content-type': 'application/json',
        ...extra,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  globalThis.__briefTestHeaders = new Headers();
  assert.equal((await GET(call('workspaces'))).status, 401);
  globalThis.__briefTestHeaders = headers('owner');
  assert.equal(
    (
      await POST(
        call(
          'workspaces',
          { name: 'Rejected' },
          { origin: 'https://evil.example' },
        ),
      )
    ).status,
    403,
  );
  const preview = await POST(
    call(`workspaces/${ws.id}/preview`, {
      title: 'Review',
      text: 'Private source paragraph.',
    }),
  );
  assert.equal(preview.status, 200);
  const input = await preview.json();
  assert.equal(
    (await owner.listArtifacts(ws.id, new URLSearchParams())).items.length,
    0,
  );
  const publishRequest = () =>
    call(`workspaces/${ws.id}/artifacts`, input, {
      'idempotency-key': 'http-1',
    });
  const saved = await POST(publishRequest());
  assert.equal(saved.status, 201);
  const item = ((await saved.json()) as { artifact: { id: string } }).artifact;
  assert.equal((await POST(publishRequest())).status, 200);
  const folded = await POST(
    call(
      `workspaces/${ws.id}/artifacts/${item.id}/fold`,
      {},
      { 'idempotency-key': 'http-fold' },
    ),
  );
  assert.equal(folded.status, 201);
  globalThis.__briefTestHeaders = headers('viewer');
  assert.equal(
    (await GET(call(`workspaces/${ws.id}/artifacts/${item.id}`))).status,
    200,
  );
  assert.equal((await POST(publishRequest())).status, 403);
  const token = await owner.createToken(ws.id, {
    name: 'HTTP reader',
    scope: 'read',
  });
  globalThis.__briefTestHeaders = new Headers();
  const authorized = () =>
    new Request(`https://brief.example/api/v1/workspaces/${ws.id}/artifacts`, {
      headers: { authorization: `Bearer ${token.token}` },
    });
  assert.equal((await GET(authorized())).status, 200);
  await owner.revokeToken(ws.id, token.id);
  assert.equal((await GET(authorized())).status, 401);
  globalThis.__briefTestHeaders = headers('owner');
  assert.equal(
    (
      await POST(
        call(`workspaces/${ws.id}/artifacts`, { large: 'x'.repeat(270000) }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await DELETE(
        new Request(
          `https://brief.example/api/v1/workspaces/${ws.id}/artifacts/${item.id}`,
          { method: 'DELETE', headers: { origin: 'https://brief.example' } },
        ),
      )
    ).status,
    404,
  );
});

void test('HTTP Gmail publication rejects a changed preview without sharing it', async () => {
  const { db, ws, owner } = await setup();
  globalThis.__briefTestEnv = {
    DB: db,
    APP_URL: 'https://brief.example',
  } as Runtime;
  globalThis.__briefTestHeaders = new Headers({
    'oai-authenticated-user-id': 'owner',
    'oai-authenticated-user-email': 'owner@example.com',
  });
  const snapshot = {
    emails: [
      {
        id: 'mail',
        subject: 'Hello',
        summary: 'Summary',
        sender: 'Sender',
        body: 'Body',
      },
    ],
  };
  await db
    .prepare('INSERT INTO snapshots (user_id, data, updated) VALUES (?, ?, ?)')
    .bind('owner', JSON.stringify(snapshot), 100)
    .run();
  const req = (body: unknown) =>
    new Request(`https://brief.example/api/v1/workspaces/${ws.id}/capture`, {
      method: 'POST',
      headers: {
        origin: 'https://brief.example',
        'content-type': 'application/json',
        'idempotency-key': 'capture',
      },
      body: JSON.stringify(body),
    });
  const data = { accountId: 'default', messageIds: ['mail'], title: 'Inbox' };
  const preview = (await (await POST(req(data))).json()) as {
    previewHash: string;
  };
  assert.equal(
    (await owner.listArtifacts(ws.id, new URLSearchParams())).items.length,
    0,
  );
  await db
    .prepare('UPDATE snapshots SET updated = 101 WHERE user_id = ?')
    .bind('owner')
    .run();
  assert.equal(
    (
      await POST(
        req({ ...data, publish: true, previewHash: preview.previewHash }),
      )
    ).status,
    409,
  );
  const fresh = (await (await POST(req(data))).json()) as {
    previewHash: string;
  };
  assert.equal(
    (
      await POST(
        req({ ...data, publish: true, previewHash: fresh.previewHash }),
      )
    ).status,
    201,
  );
});

void test('integration client sends both host and application credentials and reports structured errors', async () => {
  const client = new WorkspaceClient({
    baseUrl: 'https://brief.example',
    token: 'app-key',
    sitesAuthorization: 'host-key',
    fetch: async (url, init) => {
      assert.ok(
        (typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.href
            : url.url
        ).endsWith('/api/v1/workspaces/ws/artifacts?'),
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), 'Bearer app-key');
      assert.equal(headers.get('OAI-Sites-Authorization'), 'Bearer host-key');
      return Response.json(
        { error: 'Forbidden', requestId: 'req-1' },
        { status: 403 },
      );
    },
  });
  await assert.rejects(client.list('ws'), (error) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.requestId, 'req-1');
    return true;
  });
});
