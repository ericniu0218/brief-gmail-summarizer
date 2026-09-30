-- Each reply attempt owns its operation row. Completion, failure and confirmed-retry writes
-- name the attempt they belong to, so two overlapping retries cannot both send.
ALTER TABLE `operations` ADD `attempt` text;
--> statement-breakpoint
-- An older instance still serving unsubscribe during a rollout records the sender in
-- `unsubscribed` and then deletes that sender's stored mail. Ignoring the insert (0017) let
-- the delete through with nothing scheduled to repair it. Instead the insert is turned into:
--   * history, never an instruction;
--   * a recovery scan for that account;
--   * a short-lived guard naming the sender, which the delete below respects.
-- The legacy row itself is removed at once, so an older sync never sees a suppression rule.
CREATE TABLE `legacy_unsubscribe_guards` (
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`account_id`, `address`)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS unsubscribed_no_insert;
--> statement-breakpoint
CREATE TRIGGER unsubscribed_legacy_insert AFTER INSERT ON unsubscribed BEGIN
	INSERT OR IGNORE INTO unsubscribe_requests
		(id,user_id,account_id,address,scope,outcome,detail,created,updated)
		VALUES (NEW.id,NEW.user_id,NEW.account_id,NEW.address,'legacy-sender','unknown',
			'Recorded by an older version during an upgrade. Scope and provider response were not recorded.',
			NEW.created,NEW.created);
	INSERT OR IGNORE INTO legacy_unsubscribe_guards (user_id,account_id,address,created)
		VALUES (NEW.user_id,NEW.account_id,NEW.address,NEW.created);
	-- A count, so a request made while a recovery scan is running outlives that scan.
	UPDATE connections SET recovery_needed=recovery_needed+1 WHERE id=NEW.account_id AND user_id=NEW.user_id;
	DELETE FROM unsubscribed WHERE id=NEW.id;
END;
--> statement-breakpoint
-- While a guard exists, stored mail from that sender is not deleted. Only a live account is
-- protected, so disconnecting still removes everything. The current sync clears an account's
-- guards before it reconciles, so this never blocks a deletion the current version makes.
CREATE TRIGGER mailbox_messages_legacy_guard BEFORE DELETE ON mailbox_messages
WHEN EXISTS (SELECT 1 FROM legacy_unsubscribe_guards g
		WHERE g.account_id=OLD.account_id AND g.address=json_extract(OLD.data,'$.address'))
	AND EXISTS (SELECT 1 FROM connections WHERE id=OLD.account_id)
BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
-- A reply sent before the `replied` column existed cleared only the stored badge. Every other
-- writer derives the badge from the stored classification, so a row whose badge is off while
-- its classification says a reply is owed was answered. Recording that in the column keeps
-- the next sync, which rewrites the row, from putting the badge back.
UPDATE mailbox_messages SET replied=1
WHERE replied=0 AND json_extract(data,'$.needsReply')=0 AND json_extract(data,'$.classification.replyRequired')=1;
