CREATE TABLE `workspace_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`schema_version` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`content` text NOT NULL,
	`provenance` text NOT NULL,
	`parent_ids` text NOT NULL,
	`created_by` text NOT NULL,
	`author_name` text NOT NULL,
	`created` integer NOT NULL,
	`checksum` text NOT NULL,
	`request_key` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_idempotency` ON `workspace_artifacts` (`workspace_id`,`created_by`,`request_key`);--> statement-breakpoint
CREATE INDEX `artifacts_workspace_created` ON `workspace_artifacts` (`workspace_id`,`created`,`id`);--> statement-breakpoint
CREATE TABLE `workspace_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_workspace_sequence` ON `workspace_events` (`workspace_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `workspace_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`expires` integer NOT NULL,
	`used_by` text,
	`revoked` integer,
	`created` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invite_role" CHECK("workspace_invites"."role" IN ('editor','viewer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_invites_token_hash_unique` ON `workspace_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_workspace` ON `workspace_invites` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspace_members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`joined` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "member_role" CHECK("workspace_members"."role" IN ('owner','editor','viewer'))
);
--> statement-breakpoint
CREATE INDEX `members_user` ON `workspace_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspace_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_by` text NOT NULL,
	`created` integer NOT NULL,
	`expires` integer NOT NULL,
	`revoked` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "token_scope" CHECK("workspace_tokens"."scope" IN ('read','write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_tokens_token_hash_unique` ON `workspace_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `tokens_workspace` ON `workspace_tokens` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text NOT NULL,
	`created` integer NOT NULL
);
