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
  TASK_STATUSES,
  taskDueAt,
  type Task,
  type TaskStatus,
} from '@/lib/tasks';
import { MAX_MESSAGE_LENGTH, type Message } from '@/lib/chat';
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
type TaskRow = {
  id: string;
  workspace_id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  assignee_id: string | null;
  assignee_name: string | null;
  due_at: number | null;
  due_kind: string | null;
  created_by: string;
  creator_name: string;
  created: number;
  updated: number;
  version: number;
  completed: number | null;
};
function taskOf(row: TaskRow | null): Task {
  // A row read back immediately after its own write; a miss means the record is gone, not
  // that the caller sent anything wrong.
  if (!row) throw new HttpError(500, 'The task could not be read back.');
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    dueAt: row.due_at,
    dueKind: row.due_kind as Task['dueKind'],
    createdBy: row.created_by,
    creatorName: row.creator_name,
    created: row.created,
    updated: row.updated,
    version: row.version,
    completed: row.completed,
  };
}
/** Enough for any team that is actually tracking work by hand. */
const TASK_LIMIT = 500;
/** Messages one author may post in a minute before they are asked to slow down. */
const MESSAGE_RATE_LIMIT = 30;
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
        'SELECT role, display_name AS displayName FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .bind(workspaceId, a.type === 'user' ? a.id : a.ownerId)
      .first<{ role: Role; displayName: string }>();
    if (!member) throw new HttpError(404, 'Workspace not found.');
    // A member's name is copied in when they join, so it would otherwise stay as it was
    // forever. Refreshed from the verified identity when it has actually changed, which
    // keeps the member list and the conversation showing what people are called now.
    if (a.type === 'user' && member.displayName !== a.name)
      await this.db
        .prepare(
          'UPDATE workspace_members SET display_name = ? WHERE workspace_id = ? AND user_id = ?',
        )
        .bind(a.name, workspaceId, a.id)
        .run();
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
  private taskStatus(value: unknown): TaskStatus {
    if (!TASK_STATUSES.includes(value as TaskStatus))
      throw new HttpError(
        400,
        `Choose a status: ${TASK_STATUSES.join(', ')}.`,
      );
    return value as TaskStatus;
  }
  /** Work can only be given to someone who is in the workspace now. */
  private async assignee(ws: string, value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const userId = string(value, 'Assignee', 200);
    const member = await this.db
      .prepare(
        'SELECT display_name AS displayName FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      )
      .bind(ws, userId)
      .first<{ displayName: string }>();
    if (!member)
      throw new HttpError(400, 'Assign this task to someone in the workspace.');
    return { id: userId, name: member.displayName };
  }
  private deadline(value: unknown) {
    const due = taskDueAt(value);
    if (due === undefined)
      throw new HttpError(
        400,
        'Give a deadline as a date (2026-10-09), a full date and time, or nothing.',
      );
    return due;
  }
  private async taskRow(ws: string, id: string): Promise<TaskRow> {
    const row = await this.db
      .prepare('SELECT * FROM workspace_tasks WHERE workspace_id = ? AND id = ?')
      .bind(ws, string(id, 'Task ID'))
      .first<TaskRow>();
    if (!row) throw new HttpError(404, 'Task not found.');
    return row;
  }
  /**
   * Every task in the workspace, newest first with live work ahead of finished work, so a
   * capped response drops completed history rather than something still owed.
   */
  async tasks(ws: string) {
    await this.authorize(ws);
    const rows = await this.db
      .prepare(
        `SELECT * FROM workspace_tasks WHERE workspace_id = ? ORDER BY CASE WHEN status IN ('done','cancelled') THEN 1 ELSE 0 END, created DESC LIMIT ?`,
      )
      .bind(ws, TASK_LIMIT)
      .all<TaskRow>();
    return {
      items: rows.results.map(taskOf),
      // Who the viewer is, so the browser can mark their own work without the page having
      // to guess which member row is theirs.
      me: {
        actor: this.actorId,
        userId: this.actor.type === 'user' ? this.actor.id : null,
      },
    };
  }
  /**
   * Live work assigned to the signed-in person, across every workspace they belong to, so
   * the inbox can show what the team is waiting on without knowing about workspaces.
   *
   * The membership join is the access check: a task is only returned when its workspace
   * still has this person as a member.
   */
  async myTasks(): Promise<(Task & { workspaceName: string })[]> {
    const actor = this.user();
    const rows = await this.db
      .prepare(
        `SELECT t.*, w.name AS workspace_name FROM workspace_tasks t
           JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = ?
           JOIN workspaces w ON w.id = t.workspace_id
          WHERE t.assignee_id = ? AND t.status NOT IN ('done','cancelled')
          ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END, t.due_at, t.created
          LIMIT 50`,
      )
      .bind(actor.id, actor.id)
      .all<TaskRow & { workspace_name: string }>();
    return rows.results.map((row) => ({
      ...taskOf(row),
      workspaceName: row.workspace_name,
    }));
  }
  async createTask(
    ws: string,
    value: unknown,
    requestKey: unknown,
  ): Promise<Task> {
    await this.authorize(ws, 'write');
    const data = object(value);
    const key = string(requestKey, 'Idempotency-Key', 128);
    const title = string(data.title, 'Task title', 200);
    const detail = string(data.detail ?? '', 'Task detail', 4000, true);
    const status = this.taskStatus(data.status ?? 'todo');
    const due = this.deadline(data.due);
    const assignee = await this.assignee(ws, data.assigneeId);
    const existing = await this.db
      .prepare(
        'SELECT * FROM workspace_tasks WHERE workspace_id = ? AND created_by = ? AND request_key = ?',
      )
      .bind(ws, this.actorId, key)
      .first<TaskRow>();
    // A retried creation returns the task it already made instead of a duplicate.
    if (existing) return taskOf(existing);
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.batch([
      this.db
        .prepare(
          'INSERT INTO workspace_tasks (id, workspace_id, title, detail, status, assignee_id, assignee_name, due_at, due_kind, created_by, creator_name, created, updated, version, completed, request_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(workspace_id, created_by, request_key) DO NOTHING',
        )
        .bind(
          id,
          ws,
          title,
          detail,
          status,
          assignee?.id ?? null,
          assignee?.name ?? null,
          due?.dueAt ?? null,
          due?.dueKind ?? null,
          this.actorId,
          this.actor.name,
          now,
          now,
          status === 'done' ? now : null,
          key,
        ),
      this.db
        .prepare(
          "INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, 'task.created', ?, ?, ? WHERE changes() > 0",
        )
        .bind(ws, this.actorId, id, now),
    ]);
    return taskOf(
      await this.db
        .prepare(
          'SELECT * FROM workspace_tasks WHERE workspace_id = ? AND created_by = ? AND request_key = ?',
        )
        .bind(ws, this.actorId, key)
        .first<TaskRow>(),
    );
  }
  /**
   * Applies only the fields the caller sent, against the version they were looking at.
   *
   * Both halves matter: naming the version means a stale save is refused instead of
   * overwriting someone, and sending only changed fields means two people editing
   * different parts of one task do not have to fight over the fields they never touched.
   */
  async updateTask(ws: string, id: string, value: unknown): Promise<Task> {
    await this.authorize(ws, 'write');
    const data = object(value);
    const version = integer(data.version, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await this.taskRow(ws, id);
    const title = 'title' in data ? string(data.title, 'Task title', 200) : current.title;
    const detail =
      'detail' in data
        ? string(data.detail ?? '', 'Task detail', 4000, true)
        : current.detail;
    const status = 'status' in data ? this.taskStatus(data.status) : current.status;
    const due =
      'due' in data
        ? this.deadline(data.due)
        : current.due_at === null
          ? null
          : { dueAt: current.due_at, dueKind: current.due_kind as 'day' | 'time' };
    const assignee =
      'assigneeId' in data
        ? await this.assignee(ws, data.assigneeId)
        : current.assignee_id === null
          ? null
          : { id: current.assignee_id, name: current.assignee_name as string };
    const now = Date.now();
    // Finishing stamps the time; reopening clears it, so a reopened task cannot claim to
    // have been completed.
    const completed =
      status === 'done' ? (current.completed ?? now) : null;
    // One event per update, naming the most consequential change, so the activity feed
    // reads as a history of the work rather than of keystrokes.
    const event =
      status !== current.status
        ? 'task.status'
        : (assignee?.id ?? null) !== current.assignee_id
          ? 'task.assignee'
          : (due?.dueAt ?? null) !== current.due_at
            ? 'task.due'
            : 'task.edited';
    const results = await this.db.batch([
      this.db
        .prepare(
          'UPDATE workspace_tasks SET title = ?, detail = ?, status = ?, assignee_id = ?, assignee_name = ?, due_at = ?, due_kind = ?, completed = ?, updated = ?, version = version + 1 WHERE workspace_id = ? AND id = ? AND version = ?',
        )
        .bind(
          title,
          detail,
          status,
          assignee?.id ?? null,
          assignee?.name ?? null,
          due?.dueAt ?? null,
          due?.dueKind ?? null,
          completed,
          now,
          ws,
          id,
          version,
        ),
      this.db
        .prepare(
          'INSERT INTO workspace_events (workspace_id, type, actor_id, subject_id, created) SELECT ?, ?, ?, ?, ? WHERE changes() > 0',
        )
        .bind(ws, event, this.actorId, id, now),
    ]);
    if (!results[0].meta.changes)
      throw new HttpError(
        409,
        'Someone else changed this task first. It has been reloaded.',
      );
    return taskOf(await this.taskRow(ws, id));
  }
  async deleteTask(ws: string, id: string) {
    const role = await this.authorize(ws, 'write');
    const current = await this.taskRow(ws, id);
    // Deleting removes the record of the work, so it stays with the person who added it
    // and the owner. Anyone else marks it cancelled, which is visible.
    if (role !== 'owner' && current.created_by !== this.actorId)
      throw new HttpError(
        403,
        'Only an owner, or whoever added this task, can delete it.',
      );
    await this.db.batch([
      this.db
        .prepare('DELETE FROM workspace_tasks WHERE workspace_id = ? AND id = ?')
        .bind(ws, id),
      this.event(ws, 'task.deleted', id),
    ]);
  }
  /**
   * The conversation after `after`, oldest first, with the newest sequence in the
   * workspace so a caller can tell there is more without fetching it.
   */
  async messages(ws: string, params: URLSearchParams) {
    await this.authorize(ws);
    const after = integer(
      Number(params.get('after') ?? 0),
      'message cursor',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = integer(Number(params.get('limit') ?? 50), 'limit', 1, 100);
    // Opening the conversation asks for the most recent messages; following it asks for
    // everything after what is already held. Both are answered in reading order.
    const newest = after === 0;
    const rows = await this.db
      .prepare(
        `SELECT sequence, id, workspace_id AS workspaceId, author_id AS authorId, author_name AS authorName, body, created, deleted
           FROM workspace_messages WHERE workspace_id = ? AND sequence > ?
          ORDER BY sequence ${newest ? 'DESC' : 'ASC'} LIMIT ?`,
      )
      .bind(ws, after, limit)
      .all<Message>();
    const items = newest ? rows.results.reverse() : rows.results;
    const latest = await this.db
      .prepare(
        'SELECT MAX(sequence) AS latest FROM workspace_messages WHERE workspace_id = ?',
      )
      .bind(ws)
      .first<{ latest: number | null }>();
    return {
      items,
      latest: latest?.latest ?? 0,
      me: this.actorId,
    };
  }
  async postMessage(
    ws: string,
    value: unknown,
    requestKey: unknown,
  ): Promise<Message> {
    await this.authorize(ws, 'write');
    const data = object(value);
    const key = string(requestKey, 'Idempotency-Key', 128);
    const body = string(data.body, 'Message', MAX_MESSAGE_LENGTH);
    const now = Date.now();
    const existing = await this.db
      .prepare(
        'SELECT sequence, id, workspace_id AS workspaceId, author_id AS authorId, author_name AS authorName, body, created, deleted FROM workspace_messages WHERE workspace_id = ? AND author_id = ? AND request_key = ?',
      )
      .bind(ws, this.actorId, key)
      .first<Message>();
    // A retried send returns the message it already posted rather than saying it twice.
    if (existing) return existing;
    // A runaway client or a loop cannot flood the workspace. Counted from the messages
    // themselves, like the daily send cap.
    const recent = await this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM workspace_messages WHERE workspace_id = ? AND author_id = ? AND created > ?',
      )
      .bind(ws, this.actorId, now - 60000)
      .first<{ count: number }>();
    if ((recent?.count ?? 0) >= MESSAGE_RATE_LIMIT)
      throw new HttpError(
        429,
        'That is a lot of messages at once. Wait a moment and try again.',
      );
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        'INSERT INTO workspace_messages (id, workspace_id, author_id, author_name, body, created, deleted, request_key) VALUES (?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(workspace_id, author_id, request_key) DO NOTHING',
      )
      .bind(id, ws, this.actorId, this.actor.name, body, now, key)
      .run();
    const stored = await this.db
      .prepare(
        'SELECT sequence, id, workspace_id AS workspaceId, author_id AS authorId, author_name AS authorName, body, created, deleted FROM workspace_messages WHERE workspace_id = ? AND author_id = ? AND request_key = ?',
      )
      .bind(ws, this.actorId, key)
      .first<Message>();
    if (!stored) throw new HttpError(500, 'The message could not be read back.');
    return stored;
  }
  /**
   * Withdraws a message: the row and its place in the order stay, the text goes.
   * Deleting the row outright would leave a hole in the cursor every reader is following.
   */
  async deleteMessage(ws: string, id: string) {
    const role = await this.authorize(ws, 'write');
    const row = await this.db
      .prepare(
        'SELECT author_id AS authorId FROM workspace_messages WHERE workspace_id = ? AND id = ?',
      )
      .bind(ws, string(id, 'Message ID'))
      .first<{ authorId: string }>();
    if (!row) throw new HttpError(404, 'Message not found.');
    if (role !== 'owner' && row.authorId !== this.actorId)
      throw new HttpError(
        403,
        'Only an owner, or whoever wrote it, can withdraw a message.',
      );
    await this.db
      .prepare(
        "UPDATE workspace_messages SET body = '', deleted = COALESCE(deleted, ?) WHERE workspace_id = ? AND id = ?",
      )
      .bind(Date.now(), ws, id)
      .run();
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
