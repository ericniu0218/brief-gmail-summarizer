import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  primaryKey,
  index,
  check,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const connections = sqliteTable('connections', {
  userId: text('user_id').primaryKey(),
  email: text('email').notNull(),
  token: text('token').notNull(),
  lastSync: integer('last_sync'),
  syncLock: integer('sync_lock').notNull().default(0),
  error: text('error'),
});
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  verifier: text('verifier').notNull(),
  expires: integer('expires').notNull(),
});
export const snapshots = sqliteTable('snapshots', {
  userId: text('user_id').primaryKey(),
  data: text('data').notNull(),
  updated: integer('updated').notNull(),
});
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull(),
  result: text('result'),
});
export const unsubscribed = sqliteTable('unsubscribed', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  address: text('address').notNull(),
  created: integer('created').notNull(),
});
export const overrides = sqliteTable('overrides', {
  userId: text('user_id').notNull(), messageId: text('message_id').notNull(),
  category: text('category'), addTags: text('add_tags').notNull(), removeTags: text('remove_tags').notNull(),
  notJunk: integer('not_junk').notNull().default(0), obligationState: text('obligation_state'),
  source: text('source').notNull(), created: integer('created').notNull(),
}, table => [primaryKey({columns: [table.userId, table.messageId]})]);
export const agentStatus = sqliteTable('agent_status', {
  id: text('id').primaryKey(),
  lastRun: integer('last_run').notNull(),
});
export const demoDigest = sqliteTable('demo_digest', {
  id: text('id').primaryKey(),
  data: text('data').notNull(),
  updated: integer('updated').notNull(),
});

// Shared workspace records are separate from private provider credentials/snapshots.
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  created: integer('created').notNull(),
});
export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: text('user_id').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role').notNull(),
    joined: integer('joined').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index('members_user').on(t.userId),
    check('member_role', sql`${t.role} IN ('owner','editor','viewer')`),
  ],
);
export const workspaceInvites = sqliteTable(
  'workspace_invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    tokenHash: text('token_hash').notNull().unique(),
    role: text('role').notNull(),
    createdBy: text('created_by').notNull(),
    expires: integer('expires').notNull(),
    usedBy: text('used_by'),
    revoked: integer('revoked'),
    created: integer('created').notNull(),
  },
  (t) => [
    index('invites_workspace').on(t.workspaceId),
    check('invite_role', sql`${t.role} IN ('editor','viewer')`),
  ],
);
export const workspaceTokens = sqliteTable(
  'workspace_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    scope: text('scope').notNull(),
    createdBy: text('created_by').notNull(),
    created: integer('created').notNull(),
    expires: integer('expires').notNull(),
    revoked: integer('revoked'),
  },
  (t) => [
    index('tokens_workspace').on(t.workspaceId),
    check('token_scope', sql`${t.scope} IN ('read','write')`),
  ],
);
export const workspaceArtifacts = sqliteTable(
  'workspace_artifacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    kind: text('kind').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    content: text('content').notNull(),
    provenance: text('provenance').notNull(),
    parentIds: text('parent_ids').notNull(),
    createdBy: text('created_by').notNull(),
    authorName: text('author_name').notNull(),
    created: integer('created').notNull(),
    checksum: text('checksum').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
  },
  (t) => [
    uniqueIndex('artifacts_idempotency').on(
      t.workspaceId,
      t.createdBy,
      t.requestKey,
    ),
    index('artifacts_workspace_created').on(t.workspaceId, t.created, t.id),
  ],
);
export const workspaceEvents = sqliteTable(
  'workspace_events',
  {
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    type: text('type').notNull(),
    actorId: text('actor_id').notNull(),
    subjectId: text('subject_id').notNull(),
    created: integer('created').notNull(),
  },
  (t) => [index('events_workspace_sequence').on(t.workspaceId, t.sequence)],
);
