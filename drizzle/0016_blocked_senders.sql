CREATE TABLE `blocked_senders` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`name` text,
	`created` integer NOT NULL,
	PRIMARY KEY(`account_id`, `address`)
);
--> statement-breakpoint
CREATE INDEX `blocked_senders_user` ON `blocked_senders` (`user_id`);