-- Preserve existing connections, encrypted tokens, cached mail, and send receipts.
-- Legacy accounts keep their user id as the account id.
CREATE TABLE `account_preferences` (
  `user_id` text PRIMARY KEY NOT NULL,
  `default_account_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections_new` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `email` text NOT NULL,
  `token` text NOT NULL,
  `last_sync` integer,
  `sync_lock` integer DEFAULT 0 NOT NULL,
  `error` text
);
--> statement-breakpoint
INSERT INTO `connections_new` SELECT user_id, user_id, lower(email), token, last_sync, sync_lock, error FROM `connections`;
--> statement-breakpoint
INSERT INTO `account_preferences` SELECT user_id, user_id FROM `connections`;
--> statement-breakpoint
DROP TABLE `connections`;
--> statement-breakpoint
ALTER TABLE `connections_new` RENAME TO `connections`;
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_user_email` ON `connections` (`user_id`, `email`);
--> statement-breakpoint
CREATE TABLE `snapshots_new` (
  `user_id` text NOT NULL,
  `account_id` text NOT NULL,
  `data` text NOT NULL,
  `updated` integer NOT NULL,
  PRIMARY KEY (`user_id`, `account_id`)
);
--> statement-breakpoint
INSERT INTO `snapshots_new` SELECT user_id, user_id, data, updated FROM `snapshots`;
--> statement-breakpoint
DROP TABLE `snapshots`;
--> statement-breakpoint
ALTER TABLE `snapshots_new` RENAME TO `snapshots`;
--> statement-breakpoint
CREATE TABLE `operations_new` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `account_id` text NOT NULL,
  `status` text NOT NULL,
  `result` text
);
--> statement-breakpoint
INSERT INTO `operations_new` SELECT id, user_id, user_id, status, result FROM `operations`;
--> statement-breakpoint
DROP TABLE `operations`;
--> statement-breakpoint
ALTER TABLE `operations_new` RENAME TO `operations`;
--> statement-breakpoint
CREATE TABLE `unsubscribed_new` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `account_id` text NOT NULL,
  `address` text NOT NULL,
  `created` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `unsubscribed_new` SELECT id, user_id, user_id, address, created FROM `unsubscribed`;
--> statement-breakpoint
DROP TABLE `unsubscribed`;
--> statement-breakpoint
ALTER TABLE `unsubscribed_new` RENAME TO `unsubscribed`;
