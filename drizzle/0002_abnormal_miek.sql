CREATE TABLE `overrides` (
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`category` text,
	`add_tags` text NOT NULL,
	`remove_tags` text NOT NULL,
	`not_junk` integer DEFAULT 0 NOT NULL,
	`obligation_state` text,
	`source` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`user_id`, `message_id`)
);
