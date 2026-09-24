CREATE TABLE `mailbox_messages` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`data` text NOT NULL,
	`received_at` integer DEFAULT 0 NOT NULL,
	`scan_generation` text NOT NULL,
	PRIMARY KEY(`account_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `mailbox_messages_account_received` ON `mailbox_messages` (`account_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `sender_rules` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`junk_preference` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated` integer NOT NULL,
	PRIMARY KEY(`account_id`, `address`)
);
--> statement-breakpoint
CREATE INDEX `sender_rules_user` ON `sender_rules` (`user_id`);--> statement-breakpoint
ALTER TABLE `connections` ADD `sync_skipped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `sync_full_scan` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `backfill_complete` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `last_full_scan` integer;