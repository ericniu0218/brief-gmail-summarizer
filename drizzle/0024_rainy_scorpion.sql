CREATE TABLE `workspace_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created` integer NOT NULL,
	`deleted` integer,
	`request_key` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_withdrawn" CHECK("workspace_messages"."deleted" IS NULL OR "workspace_messages"."body" = '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_messages_id_unique` ON `workspace_messages` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_idempotency` ON `workspace_messages` (`workspace_id`,`author_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `messages_workspace_sequence` ON `workspace_messages` (`workspace_id`,`sequence`);