CREATE TABLE `scheduled_emails` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`send_at` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	CONSTRAINT "scheduled_status" CHECK("scheduled_emails"."status" IN ('scheduled','sending','sent','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `scheduled_due` ON `scheduled_emails` (`status`,`send_at`);--> statement-breakpoint
CREATE INDEX `scheduled_user` ON `scheduled_emails` (`user_id`);--> statement-breakpoint
CREATE INDEX `scheduled_account` ON `scheduled_emails` (`account_id`);--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`signature` text
);
--> statement-breakpoint
ALTER TABLE `operations` ADD `action` text;