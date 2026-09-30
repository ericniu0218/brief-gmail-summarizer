CREATE TABLE `unsubscribe_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text,
	`list_id` text,
	`address` text NOT NULL,
	`scope` text NOT NULL,
	`outcome` text NOT NULL,
	`detail` text,
	`created` integer NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `unsubscribe_requests_account` ON `unsubscribe_requests` (`account_id`,`user_id`);
--> statement-breakpoint
ALTER TABLE `connections` ADD `recovery_needed` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Carry the old rows over as history. They recorded two different things at once — that a
-- request was submitted, and that the sender's mail should be hidden — so their scope is
-- recorded as `legacy-sender` and their outcome as `unknown`: a request was made at some
-- point, for an unknown set of lists, with an unknown result. They are never replayed as
-- new unsubscribe requests, and nothing reads them to decide what mail to show.
INSERT OR IGNORE INTO `unsubscribe_requests`
	(`id`,`user_id`,`account_id`,`message_id`,`list_id`,`address`,`scope`,`outcome`,`detail`,`created`,`updated`)
SELECT `id`,`user_id`,`account_id`,NULL,NULL,`address`,'legacy-sender','unknown',
	'Imported from the sender-wide unsubscribe list. Scope and provider response were not recorded.',
	`created`,`created`
FROM `unsubscribed`;
--> statement-breakpoint
-- Any account that carried one of those rows had mail deleted and future mail suppressed,
-- so it is queued for a full reconciliation scan against Gmail.
UPDATE `connections` SET `recovery_needed` = 1
WHERE `id` IN (SELECT `account_id` FROM `unsubscribe_requests` WHERE `scope` = 'legacy-sender');
--> statement-breakpoint
-- Emptying the old table is what stops an instance still running the previous version from
-- continuing to delete mail during a rollout: every suppression query there is driven by
-- these rows. The table itself stays so that the old code keeps running rather than failing
-- its sync, and so a rollback has somewhere to write.
DELETE FROM `unsubscribed`;
