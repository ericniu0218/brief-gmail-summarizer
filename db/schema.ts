import { sqliteTable, text, integer, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), email: text('email').notNull(), token: text('token').notNull(),
  lastSync: integer('last_sync'), syncLock: integer('sync_lock').notNull().default(0), error: text('error'),
}, table => [uniqueIndex('connections_user_email').on(table.userId, table.email)]);
export const accountPreferences = sqliteTable('account_preferences', {
  userId: text('user_id').primaryKey(), defaultAccountId: text('default_account_id').notNull(),
});
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(), userId: text('user_id').notNull(), verifier: text('verifier').notNull(), expires: integer('expires').notNull(),
});
export const snapshots = sqliteTable('snapshots', {
  userId: text('user_id').notNull(), accountId: text('account_id').notNull(), data: text('data').notNull(), updated: integer('updated').notNull(),
}, table => [primaryKey({columns: [table.userId, table.accountId]})]);
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), accountId: text('account_id').notNull(), status: text('status').notNull(), result: text('result'),
});
export const unsubscribed = sqliteTable('unsubscribed', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), accountId: text('account_id').notNull(), address: text('address').notNull(), created: integer('created').notNull(),
});
export const agentStatus = sqliteTable('agent_status', {
  id: text('id').primaryKey(), lastRun: integer('last_run').notNull(),
});
