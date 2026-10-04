import type {
  Artifact,
  ArtifactSummary,
  Json,
  JoinCode,
  Member,
  Page,
  Role,
  Workspace,
  WorkspaceEvent,
} from '@/lib/workspaces/contracts';
import { CORPUS_KIND, FOLD_KIND } from '@/lib/workspaces/contracts';
import { HttpError , parseStoredJson} from '../runtime';
import {
  formatJoinCode,
  isInviteToken,
  newJoinCode,
  normalizeJoinCode,
} from './join-code';
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
/** Wrong group codes tolerated per user before they must wait, and the window they age out in. */
const JOIN_FAILURE_LIMIT = 10;
const JOIN_FAILURE_WINDOW = 10 * 60000;
const DAY = 86400000;
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;
function isJson(value:unknown):value is Json{
  if(value===null||['string','number','boolean'].includes(typeof value))return true;
  if(Array.isArray(value))return value.every(isJson);
  return typeof value==='object'&&Object.values(value as Record<string,unknown>).every(isJson);
}
function isJsonRecord(value:unknown):value is Record<string,Json>{
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(isJson);
}
function isStringArray(value:unknown):value is string[]{return Array.isArray(value)&&value.every(item=>typeof item==='string');}
function metadata(r: ArtifactRow): ArtifactSummary {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    schemaVersion: r.schema_version,
    title: r.title,
    summary: r.summary,
    // Stored JSON is a trust boundary: a damaged row reports itself rather than
    // collapsing the whole request into a generic 500.
    provenance: parseStoredJson(r.provenance,'artifact record',isJsonRecord),
    parentIds: parseStoredJson(r.parent_ids,'artifact record',isStringArray),
    createdBy: r.created_by,
    authorName: r.author_name,
    created: r.created,
    checksum: r.checksum,
  };
}
function artifact(r: ArtifactRow): Artifact {
  return { ...metadata(r), content: parseStoredJson(r.content,'artifact content',isJsonRecord) };
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
  /** The live group code, expired or not, so an owner can see it needs rotating. */
  async joinCode(ws: string): Promise<JoinCode | null> {
    await this.authorize(ws, 'manage');
    const row = await this.db
      .prepare(
        'SELECT id, code, role, expires, max_uses AS maxUses, uses, created FROM workspace_join_codes WHERE workspace_id = ? AND revoked IS NULL',
      )
      .bind(ws)
      .first<Omit<JoinCode, 'code'> & { code: string }>();
    return row ? { ...row, code: formatJoinCode(row.code) } : null;
  }
  /** Issues the group code, replacing any previous one in the same commit. */
  async createJoinCode(ws: string, value: unknown): Promise<JoinCode> {
    await this.authorize(ws, 'manage');
    const actor = this.user();
    const data = object(value ?? {});
    const role = data.role;
    if (role !== 'editor' && role !== 'viewer')
      throw new HttpError(400, 'Choose editor or viewer.');
    const days = integer(data.days ?? 7, 'expiry days', 1, 30);
    // An absent limit is unlimited-until-expiry; an explicit one is bounded.
    const maxUses =
      data.maxUses === undefined || data.maxUses === null
        ? null
        : integer(data.maxUses, 'use limit', 1, 500);
    const created = Date.now();
    const expires = created + days * DAY;
    // A fresh code can collide with another workspace's only by chance. The batch is one
    // transaction, so a rejected insert leaves the previous code in place to try again.
    for (let attempt = 3; ; attempt--) {
      const id = crypto.randomUUID();
      const code = newJoinCode();
      try {
        await this.db.batch([
          this.db
            .prepare(
              'UPDATE workspace_join_codes SET revoked = ? WHERE workspace_id = ? AND revoked IS NULL',
            )
            .bind(created, ws),
          this.db
            .prepare(
              'INSERT INTO workspace_join_codes (id, workspace_id, code, role, created_by, expires, max_uses, uses, revoked, created) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)',
            )
            .bind(id, ws, code, role, actor.id, expires, maxUses, created),
          this.event(ws, 'join_code.created', id),
        ]);
        return {
          id,
          code: formatJoinCode(code),
          role,
          expires,
          maxUses,
          uses: 0,
          created,
        };
      } catch (error) {
        if (attempt <= 1 || !UNIQUE_VIOLATION.test(String(error))) throw error;
      }
    }
  }
  async revokeJoinCode(ws: string) {
    await this.authorize(ws, 'manage');
    const row = await this.db
      .prepare(
        'SELECT id FROM workspace_join_codes WHERE workspace_id = ? AND revoked IS NULL',
      )
      .bind(ws)
      .first<{ id: string }>();
    if (!row) throw new HttpError(404, 'This group has no code to turn off.');
    await this.db.batch([
      this.db
        .prepare(
          'UPDATE workspace_join_codes SET revoked = COALESCE(revoked, ?) WHERE workspace_id = ? AND id = ?',
        )
        .bind(Date.now(), ws, row.id),
      this.event(ws, 'join_code.revoked', row.id),
    ]);
  }
  /**
   * Redeems either kind of invitation: a single-use `bwi_` token or a reusable group code.
   * Dispatching here keeps one entry point for every way a person joins a workspace.
   */
  async join(token: unknown) {
    return isInviteToken(token)
      ? this.redeemInvite(token)
      : this.redeemJoinCode(token);
  }
  /** Fails closed once a user has guessed wrong too often inside the window. */
  private async guardJoinRate(userId: string) {
    const row = await this.db
      .prepare(
        'SELECT failures, window_start AS windowStart FROM join_attempts WHERE user_id = ?',
      )
      .bind(userId)
      .first<{ failures: number; windowStart: number }>();
    if (
      row &&
      row.failures >= JOIN_FAILURE_LIMIT &&
      Date.now() - row.windowStart < JOIN_FAILURE_WINDOW
    )
      throw new HttpError(
        429,
        'Too many incorrect codes. Wait a few minutes and try again.',
      );
  }
  private async noteJoinFailure(userId: string) {
    const now = Date.now();
    // One row per user. The count restarts rather than accumulating once the window has
    // passed, so an occasional typo never adds up to a lockout.
    await this.db
      .prepare(
        `INSERT INTO join_attempts (user_id, failures, window_start) VALUES (?, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           failures = CASE WHEN ? - join_attempts.window_start >= ? THEN 1 ELSE join_attempts.failures + 1 END,
           window_start = CASE WHEN ? - join_attempts.window_start >= ? THEN ? ELSE join_attempts.window_start END`,
      )
      .bind(
        userId,
        now,
        now,
        JOIN_FAILURE_WINDOW,
        now,
        JOIN_FAILURE_WINDOW,
        now,
      )
      .run();
  }
  private async redeemJoinCode(value: unknown) {
    const actor = this.user();
    await this.guardJoinRate(actor.id);
    // A malformed code is a typo, answered by the shape message and not counted as a guess.
    const code = normalizeJoinCode(value);
    const now = Date.now();
    const found = await this.db
      .prepare(
        'SELECT id, workspace_id FROM workspace_join_codes WHERE code = ? AND revoked IS NULL AND expires > ? AND (max_uses IS NULL OR uses < max_uses)',
      )
      .bind(code, now)
      .first<{ id: string; workspace_id: string }>();
    if (!found) {
      await this.noteJoinFailure(actor.id);
      // Expired, revoked, used up, and never issued are one answer: a wrong code must not
      // reveal that some other workspace holds it.
      throw new HttpError(
        404,
        'That group code is not valid. Check it with whoever shared it.',
      );
    }
    const member = await this.db
      .prepare(
        'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .bind(found.workspace_id, actor.id)
      .first<{ role: Role }>();
    await this.db
      .prepare('DELETE FROM join_attempts WHERE user_id = ?')
      .bind(actor.id)
      .run();
    // Joining twice is a no-op: it must spend no use, and must never lower the role of a
    // member who is already an owner or editor.
    if (member) return { workspaceId: found.workspace_id, joined: false };
    const results = await this.db.batch([
      // The use is claimed first, so a code reaching its limit stops before the membership
      // insert below can see `changes() > 0`.
      this.db
        .prepare(
          'UPDATE workspace_join_codes SET uses = uses + 1 WHERE id = ? AND revoked IS NULL AND expires > ? AND (max_uses IS NULL OR uses < max_uses)',
        )
        .bind(found.id, now),
      this.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, display_name, role, joined) SELECT workspace_id, ?, ?, role, ? FROM workspace_join_codes WHERE id = ? AND changes() > 0 ON CONFLICT(workspace_id, user_id) DO NOTHING',
        )
        .bind(actor.id, actor.name, now, found.id),
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'member.joined', ?, ?, ? WHERE changes() > 0",
        )
        .bind(found.workspace_id, this.actorId, actor.id, now),
      this.db
        .prepare(
          'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
        )
        .bind(found.workspace_id, actor.id),
    ]);
    if (!results[3].results.length)
      throw new HttpError(
        409,
        'That group code has just been used up or turned off.',
      );
    return { workspaceId: found.workspace_id, joined: true };
  }
  private async redeemInvite(token: unknown) {
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
    return { workspaceId: invite.workspace_id, joined: true };
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
