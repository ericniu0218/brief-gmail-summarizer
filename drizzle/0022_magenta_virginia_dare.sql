CREATE TABLE `join_attempts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_join_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`code` text NOT NULL,
	`role` text NOT NULL,
	`created_by` text NOT NULL,
	`expires` integer NOT NULL,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`revoked` integer,
	`created` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "join_code_role" CHECK("workspace_join_codes"."role" IN ('editor','viewer')),
	CONSTRAINT "join_code_uses" CHECK("workspace_join_codes"."uses" >= 0 AND ("workspace_join_codes"."max_uses" IS NULL OR "workspace_join_codes"."max_uses" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_join_codes_code_unique` ON `workspace_join_codes` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `join_codes_active` ON `workspace_join_codes` (`workspace_id`) WHERE "workspace_join_codes"."revoked" IS NULL;