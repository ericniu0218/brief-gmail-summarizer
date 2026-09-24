ALTER TABLE `overrides` ADD `junk_preference` text;--> statement-breakpoint
ALTER TABLE `overrides` ADD `obligation_states` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `overrides` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `overrides` ADD `active` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Translate the two legacy ways of expressing disposition into the explicit dimension.
UPDATE `overrides` SET `junk_preference` = CASE WHEN `not_junk` = 1 THEN 'not-junk' WHEN `category` = 'noise' THEN 'junk' ELSE NULL END;
