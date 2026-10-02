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

/**
 * Database map for private Gmail state and shared workspace artifacts. It mirrors the
 * migration files; request handlers never create or alter tables.
 */

/**
 * Private mailbox tables are keyed by an opaque account id, not by the mailbox address.
 * One authenticated user may own several connected Gmail accounts, so every mailbox row
 * carries both its owner (`user_id`) and its account (`account_id`). Queries match on
 * both together: holding an account id is never on its own proof of ownership.
 */
export const connections = sqliteTable('connections', {
  // Opaque internal id. The email address is mutable, so it is never the primary key.
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  // Google's stable subject claim when available, so a renamed mailbox still matches.
  providerIdentity: text('provider_identity'),
  email: text('email').notNull(),
  token: text('token').notNull(),
  // 1 = refresh token encrypted with the legacy user-only AAD, 2 = user + account AAD.
  tokenVersion: integer('token_version').notNull().default(1),
  lastSync: integer('last_sync'),
  syncLock: integer('sync_lock').notNull().default(0),
  // A mailbox is scanned in bounded pages across runs. The generation marks messages
  // seen in the current full scan so stale records can be removed only at the last page.
  syncPageToken: text('sync_page_token'),
  syncGeneration: text('sync_generation'),
  syncSkipped: integer('sync_skipped').notNull().default(0),
  syncFullScan: integer('sync_full_scan').notNull().default(1),
  backfillComplete: integer('backfill_complete').notNull().default(0),
  lastFullScan: integer('last_full_scan'),
  // Version 1 means a completed full scan stored rich HTML for formatted display.
  contentVersion: integer('content_version').notNull().default(0),
  // Outstanding requests to reconcile this account against Gmail, set when an earlier
  // version deleted or may have deleted mail. A count, so a request made during a scan
  // survives that scan; a completed full scan subtracts only the requests it started with.
  recoveryNeeded: integer('recovery_needed').notNull().default(0),
  error: text('error'),
  created: integer('created').notNull(),
}, table => [
  // One user cannot connect the same mailbox twice, so two callbacks racing for the same
  // address collide here rather than in application code. Two *different* users may each
  // connect the same mailbox: access is granted per application user, not globally.
  uniqueIndex('connections_user_email').on(table.userId, table.email),
  index('connections_user').on(table.userId),
  // Scheduler selection: least recently synced accounts that are not currently leased.
  index('connections_due').on(table.syncLock, table.lastSync),
]);
/** One default mailbox per user, always validated against a connection they own. */
export const accountPreferences = sqliteTable('account_preferences', {
  userId: text('user_id').primaryKey(),
  defaultAccountId: text('default_account_id').notNull(),
});
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  verifier: text('verifier').notNull(),
  // 'add' connects an additional mailbox; 'reconnect' renews targetAccountId only.
  action: text('action').notNull().default('add'),
  targetAccountId: text('target_account_id'),
  expires: integer('expires').notNull(),
});
export const snapshots = sqliteTable('snapshots', {
  accountId: text('account_id').primaryKey(),
  userId: text('user_id').notNull(),
  data: text('data').notNull(),
  updated: integer('updated').notNull(),
  // Optimistic concurrency prevents sync, reply, and unsubscribe from losing updates.
  revision: integer('revision').notNull().default(0),
}, table => [index('snapshots_user').on(table.userId)]);
/** Individual mailbox rows keep reads and updates bounded as a mailbox grows. */
export const mailboxMessages = sqliteTable('mailbox_messages', {
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(), messageId: text('message_id').notNull(),
  data: text('data').notNull(), receivedAt: integer('received_at').notNull().default(0), scanGeneration: text('scan_generation').notNull(),
  // Once this app sends a reply, later Gmail refreshes must not restore needsReply=true.
  replied: integer('replied').notNull().default(0),
}, table => [primaryKey({columns:[table.accountId,table.messageId]}), index('mailbox_messages_account_received').on(table.accountId,table.receivedAt)]);
/** A sender rule applies only inside one connected Gmail account. */
/**
 * A sender rule applies only inside one connected Gmail account.
 *
 * Clearing a rule leaves an inactive tombstone rather than deleting the row, so its
 * revision keeps counting upward. Deleting would restart it at zero and let a request
 * written before the clear recreate the rule it was supposed to remove.
 */
export const senderRules = sqliteTable('sender_rules', {
  userId:text('user_id').notNull(),accountId:text('account_id').notNull(),address:text('address').notNull(),
  junkPreference:text('junk_preference').notNull(),revision:integer('revision').notNull().default(1),updated:integer('updated').notNull(),
  // 0 means the rule was cleared; the row survives only to keep its revision monotonic.
  active:integer('active').notNull().default(1),
}, table => [primaryKey({columns:[table.accountId,table.address]}),index('sender_rules_user').on(table.userId)]);
export const operations = sqliteTable('operations', {
  // The id is a fingerprint that includes the account, so the same text sent from two
  // mailboxes stays two distinct operations instead of being suppressed as a duplicate.
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  status: text('status').notNull(),
  result: text('result'),
  // When the attempt was claimed, so an unconfirmed one can say how long ago it happened.
  created: integer('created').notNull().default(0),
  // The attempt that owns this operation. Every completion or failure write names it, so
  // overlapping confirmed retries cannot both send.
  attempt: text('attempt'),
  // 'send' or 'draft'. The daily sending limit counts the sends among a user's recent operations.
  action: text('action'),
}, table => [index('operations_account').on(table.accountId)]);
/**
 * Settings that belong to the person rather than to one mailbox, so they apply whichever
 * connected account an email leaves from. Both are text the user typed themselves.
 */
export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey(),
  // Signs AI-written replies and drafts. Never taken from a mail header or an account name.
  displayName: text('display_name'),
  // Added under every new email and forward the user writes.
  signature: text('signature'),
});
/**
 * Emails queued to send later, from one connected mailbox. The payload holds the recipients,
 * subject and body as JSON and is cleared once the email is sent or cancelled.
 */
export const scheduledEmails = sqliteTable('scheduled_emails', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  sendAt: integer('send_at').notNull(),
  payload: text('payload').notNull(),
  status: text('status').notNull(),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  created: integer('created').notNull(),
  updated: integer('updated').notNull(),
}, table => [
  index('scheduled_due').on(table.status, table.sendAt),
  index('scheduled_user').on(table.userId),
  index('scheduled_account').on(table.accountId),
  check('scheduled_status', sql`${table.status} IN ('scheduled','sending','sent','failed','cancelled')`),
]);
export const unsubscribed = sqliteTable('unsubscribed', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  address: text('address').notNull(),
  created: integer('created').notNull(),
}, table => [uniqueIndex('unsubscribed_account_address').on(table.accountId, table.address)]);
/**
 * History of unsubscribe requests. This is a record of what was asked and what came back —
 * never an instruction. Nothing reads it to decide which mail to show, because the sender
 * controls delivery: its newsletters may keep arriving, and its receipts and account
 * notices must keep arriving.
 */
export const unsubscribeRequests = sqliteTable('unsubscribe_requests', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  accountId: text('account_id').notNull(),
  /** The message the request was made from. Null for rows imported from the old table. */
  messageId: text('message_id'),
  /** The newsletter's List-ID when the message stated one; null when it did not. */
  listId: text('list_id'),
  address: text('address').notNull(),
  /** 'list' | 'message' | 'legacy-sender' — how narrowly the request can be attributed. */
  scope: text('scope').notNull(),
  outcome: text('outcome').notNull(),
  detail: text('detail'),
  /** Which attempt owns this row. Completion writes check it, so a slow earlier attempt
   *  cannot overwrite what a later one already recorded. */
  attempt: text('attempt'),
  created: integer('created').notNull(), updated: integer('updated').notNull(),
}, table => [index('unsubscribe_requests_account').on(table.accountId, table.userId)]);
/**
 * Senders the person chose never to see again in this app, per connected account.
 *
 * Blocking only hides mail when a view is read: every message stays stored, and nothing in
 * Gmail is moved or deleted, so removing the row brings everything back.
 */
export const blockedSenders = sqliteTable('blocked_senders', {
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(),
  address: text('address').notNull(),
  /** The sender's display name when blocked, so the unblock list reads naturally. */
  name: text('name'),
  created: integer('created').notNull(),
}, table => [primaryKey({columns:[table.accountId,table.address]}),index('blocked_senders_user').on(table.userId)]);
/**
 * A sender an older running version just unsubscribed from, during a rollout. While a row
 * exists, that sender's stored mail cannot be deleted; the current sync clears the rows when
 * it runs the recovery scan the same insert scheduled. See migration 0018.
 */
export const legacyUnsubscribeGuards = sqliteTable('legacy_unsubscribe_guards', {
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(),
  address: text('address').notNull(), created: integer('created').notNull(),
}, table => [primaryKey({columns:[table.accountId,table.address]})]);
export const overrides = sqliteTable('overrides', {
  // One row holds manual intent for one message. Inactive rows are reset tombstones whose
  // revision prevents stale requests from recreating corrections.
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(), messageId: text('message_id').notNull(),
  category: text('category'), addTags: text('add_tags').notNull(), removeTags: text('remove_tags').notNull(),
  notJunk: integer('not_junk').notNull().default(0), obligationState: text('obligation_state'),
  source: text('source').notNull(), created: integer('created').notNull(), junkPreference: text('junk_preference'),
  obligationStates: text('obligation_states').notNull().default('{}'), revision: integer('revision').notNull().default(1),
  active: integer('active').notNull().default(1),
}, table => [primaryKey({columns: [table.accountId, table.messageId]}), index('overrides_user').on(table.userId)]);
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
    // Retrying one logical publish operation returns the same artifact.
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
