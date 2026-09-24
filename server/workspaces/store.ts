import type {
  Artifact,
  ArtifactSummary,
  Member,
  Page,
  Role,
  Workspace,
  WorkspaceEvent,
} from '@/lib/workspaces/contracts';
import { CORPUS_KIND, FOLD_KIND } from '@/lib/workspaces/contracts';
import { HttpError } from '../runtime';
import {
  artifactInput,
  canonical,
  corpusDocuments,
  hash,
  integer,
  object,
  secret,
  string,
} from './validation';

/**
 * Authorization and persistence core for shared workspaces. Every workspace query passes
 * through this class so membership, roles, tenant boundaries, events, and idempotency are
 * enforced in one place.
 */

export type Principal =
  | { type: 'user'; id: string; name: string }
  | {
      type: 'integration';
      id: string;
      name: string;
      workspaceId: string;
      ownerId: string;
      scope: 'read' | 'write';
    };
type ArtifactRow = {
  id: string;
  workspace_id: string;
  kind: string;
  schema_version: number;
  title: string;
  summary: string;
  content?: string;
  provenance: string;
  parent_ids: string;
  created_by: string;
  author_name: string;
  created: number;
  checksum: string;
  request_hash?: string;
};
const META_COLUMNS =
  'id, workspace_id, kind, schema_version, title, summary, provenance, parent_ids, created_by, author_name, created, checksum';
function metadata(r: ArtifactRow): ArtifactSummary {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    schemaVersion: r.schema_version,
    title: r.title,
    summary: r.summary,
    provenance: JSON.parse(r.provenance),
    parentIds: JSON.parse(r.parent_ids),
    createdBy: r.created_by,
    authorName: r.author_name,
    created: r.created,
    checksum: r.checksum,
  };
}
function artifact(r: ArtifactRow): Artifact {
  return { ...metadata(r), content: JSON.parse(r.content!) };
}

/** One instance per request. All authorization and persistence crosses this module. */
export class WorkspaceStore {
  constructor(
    private db: D1Database,
    readonly actor: Principal,
  ) {}
  private get actorId() {
    return `${this.actor.type}:${this.actor.id}`;
  }
  private user() {
    if (this.actor.type !== 'user')
      throw new HttpError(403, 'A signed-in workspace owner is required.');
    return this.actor;
  }
  private event(workspaceId: string, type: string, subjectId: string) {
    return this.db
      .prepare(
        'INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(workspaceId, type, this.actorId, subjectId, Date.now());
  }
  async authorize(
    workspaceId: string,
    permission: 'read' | 'write' | 'manage' = 'read',
  ): Promise<Role> {
    // Integration keys belong to one workspace and cannot manage people or secrets.
    const a = this.actor;
    if (
      a.type === 'integration' &&
      (a.workspaceId !== workspaceId ||
        permission === 'manage' ||
        (permission === 'write' && a.scope !== 'write'))
    )
      throw new HttpError(
        403,
        'This integration does not have that workspace permission.',
      );
    const member = await this.db
      .prepare(
        'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .bind(workspaceId, a.type === 'user' ? a.id : a.ownerId)
      .first<{ role: Role }>();
    if (!member) throw new HttpError(404, 'Workspace not found.');
    if (
      (permission === 'manage' && member.role !== 'owner') ||
      (permission === 'write' && member.role === 'viewer')
    )
      throw new HttpError(
        403,
        'Your workspace role does not allow this action.',
      );
    return member.role;
  }
  async listWorkspaces(): Promise<Workspace[]> {
    const actor = this.user();
    return (
      await this.db
        .prepare(
          'SELECT w.id, w.name, w.created, m.role FROM workspaces w JOIN workspace_members m ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created, w.id',
        )
        .bind(actor.id)
        .all<Workspace>()
    ).results;
  }
  async createWorkspace(name: unknown): Promise<Workspace> {
    // Workspace, owner membership, and audit event commit together.
    const actor = this.user();
    const id = crypto.randomUUID();
    const created = Date.now();
    const title = string(name, 'Workspace name', 80);
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO workspaces (id, name, created_by, created) VALUES (?, ?, ?, ?)',
        )
        .bind(id, title, actor.id, created),
      this.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, display_name, role, joined) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(id, actor.id, actor.name, 'owner', created),
      this.event(id, 'workspace.created', id),
    ]);
    return { id, name: title, role: 'owner', created };
  }
  async members(ws: string) {
    await this.authorize(ws);
    return (
      await this.db
        .prepare(
          'SELECT user_id AS userId, display_name AS displayName, role, joined FROM workspace_members WHERE workspace_id = ? ORDER BY joined, user_id',
        )
        .bind(ws)
        .all<Member>()
    ).results;
  }
  async changeMember(ws: string, userId: string, role: unknown) {
    // Only owners manage membership, and the original owner cannot be removed or demoted.
    await this.authorize(ws, 'manage');
    const target = await this.db
      .prepare(
        'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .bind(ws, userId)
      .first<{ role: Role }>();
    if (!target) throw new HttpError(404, 'Member not found.');
    if (target.role === 'owner')
      throw new HttpError(
        409,
        'The workspace owner cannot be removed or demoted.',
      );
    if (role !== null && role !== 'editor' && role !== 'viewer')
      throw new HttpError(400, 'Choose editor or viewer.');
    await this.db.batch([
      role === null
        ? this.db
            .prepare(
              "DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role != 'owner'",
            )
            .bind(ws, userId)
        : this.db
            .prepare(
              "UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ? AND role != 'owner'",
            )
            .bind(role, ws, userId),
      this.event(
        ws,
        role === null ? 'member.removed' : 'member.role_changed',
        userId,
      ),
    ]);
  }
  async invites(ws: string) {
    await this.authorize(ws, 'manage');
    return (
      await this.db
        .prepare(
          'SELECT id, role, expires, used_by AS usedBy, revoked, created FROM workspace_invites WHERE workspace_id = ? ORDER BY created DESC LIMIT 100',
        )
        .bind(ws)
        .all()
    ).results;
  }
  async createInvite(ws: string, role: unknown) {
    await this.authorize(ws, 'manage');
    const actor = this.user();
    if (role !== 'editor' && role !== 'viewer')
      throw new HttpError(400, 'Choose editor or viewer.');
    // The raw invite is returned once; only its hash is stored.
    const token = secret('bwi_');
    const id = crypto.randomUUID();
    const expires = Date.now() + 7 * 86400000;
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO workspace_invites (id, workspace_id, token_hash, role, created_by, expires, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(id, ws, await hash(token), role, actor.id, expires, Date.now()),
      this.event(ws, 'invite.created', id),
    ]);
    return { id, token, role, expires };
  }
  async join(token: unknown) {
    const actor = this.user();
    const tokenHash = await hash(string(token, 'Invite token', 100));
    const invite = await this.db
      .prepare(
        'SELECT id, workspace_id, role FROM workspace_invites WHERE token_hash = ? AND revoked IS NULL AND expires > ? AND (used_by IS NULL OR used_by = ?)',
      )
      .bind(tokenHash, Date.now(), actor.id)
      .first<{ id: string; workspace_id: string; role: 'editor' | 'viewer' }>();
    if (!invite)
      throw new HttpError(
        404,
        'Invite is invalid, expired, revoked, or already used.',
      );
    // Atomic single-use claim. Membership only inserts if this request owns the claim.
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE workspace_invites SET used_by = ? WHERE id = ? AND used_by IS NULL AND revoked IS NULL AND expires > ?',
        )
        .bind(actor.id, invite.id, Date.now()),
      this.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, display_name, role, joined) SELECT workspace_id, ?, ?, role, ? FROM workspace_invites WHERE id = ? AND used_by = ? AND revoked IS NULL AND expires > ? AND changes() > 0 ON CONFLICT(workspace_id, user_id) DO NOTHING',
        )
        .bind(
          actor.id,
          actor.name,
          Date.now(),
          invite.id,
          actor.id,
          Date.now(),
        ),
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'member.joined', ?, ?, ? WHERE changes() > 0",
        )
        .bind(invite.workspace_id, this.actorId, actor.id, Date.now()),
      this.db
        .prepare(
          'SELECT i.workspace_id FROM workspace_invites i JOIN workspace_members m ON m.workspace_id = i.workspace_id AND m.user_id = i.used_by WHERE i.id = ? AND i.used_by = ? AND i.revoked IS NULL AND i.expires > ?',
        )
        .bind(invite.id, actor.id, Date.now()),
    ]);
    if (!results[3].results.length)
      throw new HttpError(409, 'This invitation was used or revoked.');
    return { workspaceId: invite.workspace_id };
  }
  async revokeInvite(ws: string, id: string) {
    await this.authorize(ws, 'manage');
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE workspace_invites SET revoked = COALESCE(revoked, ?) WHERE workspace_id = ? AND id = ?',
        )
        .bind(Date.now(), ws, id),
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'invite.revoked', ?, ?, ? WHERE changes() > 0",
        )
        .bind(ws, this.actorId, id, Date.now()),
    ]);
    if (!results[0].meta.changes) throw new HttpError(404, 'Invite not found.');
  }
  async tokens(ws: string) {
    await this.authorize(ws, 'manage');
    return (
      await this.db
        .prepare(
          'SELECT id, name, scope, created, expires, revoked FROM workspace_tokens WHERE workspace_id = ? ORDER BY created DESC LIMIT 100',
        )
        .bind(ws)
        .all()
    ).results;
  }
  async createToken(ws: string, value: unknown) {
    await this.authorize(ws, 'manage');
    const actor = this.user();
    const data = object(value);
    const name = string(data.name, 'Integration name', 80);
    const scope = data.scope;
    if (scope !== 'read' && scope !== 'write')
      throw new HttpError(400, 'Choose read or write scope.');
    const days = integer(data.days ?? 30, 'expiry days', 1, 90);
    // Integration credentials use the same return-once, hash-at-rest rule.
    const token = secret('bwk_');
    const id = crypto.randomUUID();
    const expires = Date.now() + days * 86400000;
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO workspace_tokens (id, workspace_id, name, token_hash, scope, created_by, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          id,
          ws,
          name,
          await hash(token),
          scope,
          actor.id,
          Date.now(),
          expires,
        ),
      this.event(ws, 'integration.created', id),
    ]);
    return { id, name, token, scope, expires };
  }
  async revokeToken(ws: string, id: string) {
    await this.authorize(ws, 'manage');
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE workspace_tokens SET revoked = COALESCE(revoked, ?) WHERE workspace_id = ? AND id = ?',
        )
        .bind(Date.now(), ws, id),
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'integration.revoked', ?, ?, ? WHERE changes() > 0",
        )
        .bind(ws, this.actorId, id, Date.now()),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(404, 'Integration not found.');
  }
  async listArtifacts(
    ws: string,
    params: URLSearchParams,
  ): Promise<Page<ArtifactSummary>> {
    // Stable cursor pagination uses creation time plus ID so equal timestamps cannot skip
    // or repeat results.
    await this.authorize(ws);
    const limit = integer(Number(params.get('limit') ?? 30), 'limit', 1, 100);
    const kind = params.get('kind') ?? '';
    const query = params.get('q') ?? '';
    string(query, 'Search', 160, true);
    string(kind, 'Kind', 100, true);
    const cursor = params.get('cursor');
    let created = Number.MAX_SAFE_INTEGER;
    let id = '\uffff';
    if (cursor) {
      let data: unknown;
      try {
        data = JSON.parse(cursor);
      } catch {
        throw new HttpError(400, 'Invalid cursor.');
      }
      const c = object(data);
      created = integer(c.created, 'cursor', 0, Number.MAX_SAFE_INTEGER);
      id = string(c.id, 'Cursor ID');
    }
    const rows = await this.db
      .prepare(
        `SELECT ${META_COLUMNS} FROM workspace_artifacts WHERE workspace_id = ? AND (? = '' OR kind = ?) AND (? = '' OR instr(lower(title || ' ' || summary), lower(?)) > 0) AND (created < ? OR (created = ? AND id < ?)) ORDER BY created DESC, id DESC LIMIT ?`,
      )
      .bind(ws, kind, kind, query, query, created, created, id, limit + 1)
      .all<ArtifactRow>();
    const items = rows.results.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(metadata),
      nextCursor:
        rows.results.length > limit && last
          ? JSON.stringify({ created: last.created, id: last.id })
          : null,
    };
  }
  async getArtifact(ws: string, id: string): Promise<Artifact> {
    await this.authorize(ws);
    const row = await this.db
      .prepare(
        'SELECT * FROM workspace_artifacts WHERE workspace_id = ? AND id = ?',
      )
      .bind(ws, id)
      .first<ArtifactRow>();
    if (!row) throw new HttpError(404, 'Result not found.');
    return artifact(row);
  }
  async publish(
    ws: string,
    value: unknown,
    requestKey: unknown,
  ): Promise<{ artifact: Artifact; replayed: boolean }> {
    // Validate the full artifact and all parent links before any record is inserted.
    await this.authorize(ws, 'write');
    const input = artifactInput(value);
    const key = string(requestKey, 'Idempotency-Key', 128);
    const requestHash = await hash(canonical(input));
    const existing = await this.db
      .prepare(
        'SELECT * FROM workspace_artifacts WHERE workspace_id = ? AND created_by = ? AND request_key = ?',
      )
      .bind(ws, this.actorId, key)
      .first<ArtifactRow>();
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new HttpError(
          409,
          'This idempotency key was used for different content.',
        );
      return { artifact: artifact(existing), replayed: true };
    }
    const parents = await Promise.all(
      input.parentIds.map((id) => this.getArtifact(ws, id)),
    );
    if (input.kind === FOLD_KIND) {
      const parent = parents[0];
      if (parent?.kind !== CORPUS_KIND)
        throw new HttpError(400, 'A fold parent must be a corpus.');
      const ids = new Set(
        corpusDocuments(parent.content.documents).map((d) => d.id),
      );
      for (const value of input.content.groups as unknown[])
        for (const id of object(value).documentIds as string[])
          if (!ids.has(id))
            throw new HttpError(
              400,
              'Fold citations must reference documents in the parent corpus.',
            );
    }
    const id = crypto.randomUUID();
    const created = Date.now();
    const checksum = await hash(canonical(input.content));
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO workspace_artifacts (id, workspace_id, kind, schema_version, title, summary, content, provenance, parent_ids, created_by, author_name, created, checksum, request_key, request_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, created_by, request_key) DO NOTHING',
        )
        .bind(
          id,
          ws,
          input.kind,
          input.schemaVersion,
          input.title,
          input.summary,
          canonical(input.content),
          canonical(input.provenance),
          JSON.stringify(input.parentIds),
          this.actorId,
          this.actor.name,
          created,
          checksum,
          key,
          requestHash,
        ),
      // A concurrent replay inserts no event; artifact and event commit together.
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'artifact.created', ?, ?, ? WHERE EXISTS (SELECT 1 FROM workspace_artifacts WHERE id = ?)",
        )
        .bind(ws, this.actorId, id, created, id),
    ]);
    const stored = await this.db
      .prepare(
        'SELECT * FROM workspace_artifacts WHERE workspace_id = ? AND created_by = ? AND request_key = ?',
      )
      .bind(ws, this.actorId, key)
      .first<ArtifactRow>();
    if (!stored || stored.request_hash !== requestHash)
      throw new HttpError(
        409,
        'This idempotency key was used for different content.',
      );
    return { artifact: artifact(stored), replayed: stored.id !== id };
  }
  async events(ws: string, params: URLSearchParams) {
    await this.authorize(ws);
    const after = integer(
      Number(params.get('after') ?? 0),
      'event cursor',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = integer(Number(params.get('limit') ?? 50), 'limit', 1, 100);
    const latest = params.get('latest') === 'true';
    const rows = await this.db
      .prepare(
        `SELECT sequence, type, actor_id AS actorId, subject_id AS subjectId, created FROM workspace_events WHERE workspace_id = ? AND sequence > ? ORDER BY sequence ${latest ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .bind(ws, after, limit + 1)
      .all<WorkspaceEvent>();
    const items = rows.results.slice(0, limit);
    return {
      items,
      nextAfter: items.at(-1)?.sequence ?? after,
      hasMore: rows.results.length > limit,
    };
  }
}

/** Integration credentials never share access to Gmail credentials or owner-only operations. */
export async function integrationPrincipal(
  db: D1Database,
  token: string,
): Promise<Principal> {
  if (!/^bwk_[a-f0-9]{64}$/.test(token))
    throw new HttpError(401, 'Invalid integration key.');
  const row = await db
    .prepare(
      'SELECT id, name, workspace_id, created_by, scope FROM workspace_tokens WHERE token_hash = ? AND revoked IS NULL AND expires > ?',
    )
    .bind(await hash(token), Date.now())
    .first<{
      id: string;
      name: string;
      workspace_id: string;
      created_by: string;
      scope: 'read' | 'write';
    }>();
  if (!row)
    throw new HttpError(401, 'Integration key expired, revoked, or invalid.');
  return {
    type: 'integration',
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    ownerId: row.created_by,
    scope: row.scope,
  };
}
