import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const connections = sqliteTable('connections', {
  userId: text('user_id').primaryKey(), email: text('email').notNull(), token: text('token').notNull(),
  lastSync: integer('last_sync'), syncLock: integer('sync_lock').notNull().default(0), error: text('error'),
});
export const oauthStates = sqliteTable('oauth_states', {
  state: text('state').primaryKey(), userId: text('user_id').notNull(), verifier: text('verifier').notNull(), expires: integer('expires').notNull(),
});
export const snapshots = sqliteTable('snapshots', {
  userId: text('user_id').primaryKey(), data: text('data').notNull(), updated: integer('updated').notNull(),
});
export const operations = sqliteTable('operations', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), status: text('status').notNull(), result: text('result'),
});
export const unsubscribed = sqliteTable('unsubscribed', {
  id: text('id').primaryKey(), userId: text('user_id').notNull(), address: text('address').notNull(), created: integer('created').notNull(),
});
export const agentStatus = sqliteTable('agent_status', {
  id: text('id').primaryKey(), lastRun: integer('last_run').notNull(),
});
export const demoDigest = sqliteTable('demo_digest', {
  id: text('id').primaryKey(), data: text('data').notNull(), updated: integer('updated').notNull(),
});
