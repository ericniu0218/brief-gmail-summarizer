CREATE TABLE `workspace_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`assignee_id` text,
	`assignee_name` text,
	`due_at` integer,
	`due_kind` text,
	`created_by` text NOT NULL,
	`creator_name` text NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`completed` integer,
	`request_key` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "task_status" CHECK("workspace_tasks"."status" IN ('todo','doing','blocked','done','cancelled')),
	CONSTRAINT "task_due" CHECK(("workspace_tasks"."due_at" IS NULL AND "workspace_tasks"."due_kind" IS NULL) OR ("workspace_tasks"."due_at" IS NOT NULL AND "workspace_tasks"."due_kind" IN ('day','time'))),
	CONSTRAINT "task_assignee" CHECK(("workspace_tasks"."assignee_id" IS NULL AND "workspace_tasks"."assignee_name" IS NULL) OR ("workspace_tasks"."assignee_id" IS NOT NULL AND "workspace_tasks"."assignee_name" IS NOT NULL)),
	CONSTRAINT "task_version" CHECK("workspace_tasks"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_idempotency` ON `workspace_tasks` (`workspace_id`,`created_by`,`request_key`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_assignee` ON `workspace_tasks` (`workspace_id`,`assignee_id`,`status`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_due` ON `workspace_tasks` (`workspace_id`,`status`,`due_at`);