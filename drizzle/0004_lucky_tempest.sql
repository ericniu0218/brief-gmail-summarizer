-- Multi-account Gmail support.
--
-- Every existing single-mailbox connection becomes an account whose opaque id is its
-- owner's user id. That value is already unique per row, so the rewrite is stable and
-- every dependent record can be re-pointed with the same expression. Mailboxes connected
-- after this migration get a random id instead; nothing outside this file assumes the two
-- identifiers are related.
--
-- Sync leases are deliberately cleared. A refresh started by the previous release holds a
-- lease keyed only by user, which the new code will not recognise, so leaving the value
-- would strand that mailbox until it expired. Clearing is safe because the old refresh can
-- no longer publish either: its UPDATE targets a column layout that no longer exists.
CREATE TABLE `account_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_account_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_identity` text,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`token_version` integer DEFAULT 1 NOT NULL,
	`last_sync` integer,
	`sync_lock` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created` integer NOT NULL
);
--> statement-breakpoint
-- token_version 1 records that these credentials use the legacy user-only AAD, so they
-- keep decrypting after the encryption format gains an account component.
INSERT INTO `__new_connections` ("id","user_id","provider_identity","email","token","token_version","last_sync","sync_lock","error","created")
SELECT "user_id","user_id",NULL,"email","token",1,"last_sync",0,"error",CAST(strftime('%s','now') AS INTEGER)*1000 FROM `connections`;
--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_user_email` ON `connections` (`user_id`,`email`);--> statement-breakpoint
CREATE INDEX `connections_user` ON `connections` (`user_id`);--> statement-breakpoint
CREATE INDEX `connections_due` ON `connections` (`sync_lock`,`last_sync`);--> statement-breakpoint
-- The existing mailbox stays the user's default, so the dashboard opens where it did.
INSERT INTO `account_preferences` ("user_id","default_account_id") SELECT "user_id","id" FROM `connections`;
--> statement-breakpoint
CREATE TABLE `__new_snapshots` (
	`account_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`data` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_snapshots` ("account_id","user_id","data","updated") SELECT "user_id","user_id","data","updated" FROM `snapshots`;
--> statement-breakpoint
DROP TABLE `snapshots`;--> statement-breakpoint
ALTER TABLE `__new_snapshots` RENAME TO `snapshots`;--> statement-breakpoint
CREATE INDEX `snapshots_user` ON `snapshots` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`result` text
);
--> statement-breakpoint
-- Existing send receipts keep their original fingerprint id, so duplicate-send protection
-- still recognises a message that was already sent before the migration.
INSERT INTO `__new_operations` ("id","user_id","account_id","status","result") SELECT "id","user_id","user_id","status","result" FROM `operations`;
--> statement-breakpoint
DROP TABLE `operations`;--> statement-breakpoint
ALTER TABLE `__new_operations` RENAME TO `operations`;--> statement-breakpoint
CREATE INDEX `operations_account` ON `operations` (`account_id`);--> statement-breakpoint
CREATE TABLE `__new_unsubscribed` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_unsubscribed` ("id","user_id","account_id","address","created") SELECT "id","user_id","user_id","address","created" FROM `unsubscribed`;
--> statement-breakpoint
DROP TABLE `unsubscribed`;--> statement-breakpoint
ALTER TABLE `__new_unsubscribed` RENAME TO `unsubscribed`;--> statement-breakpoint
CREATE UNIQUE INDEX `unsubscribed_account_address` ON `unsubscribed` (`account_id`,`address`);--> statement-breakpoint
CREATE TABLE `__new_overrides` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`category` text,
	`add_tags` text NOT NULL,
	`remove_tags` text NOT NULL,
	`not_junk` integer DEFAULT 0 NOT NULL,
	`obligation_state` text,
	`source` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`account_id`,`message_id`)
);
--> statement-breakpoint
INSERT INTO `__new_overrides` ("user_id","account_id","message_id","category","add_tags","remove_tags","not_junk","obligation_state","source","created")
SELECT "user_id","user_id","message_id","category","add_tags","remove_tags","not_junk","obligation_state","source","created" FROM `overrides`;
--> statement-breakpoint
DROP TABLE `overrides`;--> statement-breakpoint
ALTER TABLE `__new_overrides` RENAME TO `overrides`;--> statement-breakpoint
CREATE INDEX `overrides_user` ON `overrides` (`user_id`);--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `action` text DEFAULT 'add' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_states` ADD `target_account_id` text;
