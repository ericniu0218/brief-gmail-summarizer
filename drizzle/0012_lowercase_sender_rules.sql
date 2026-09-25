-- Sender rules are now matched case-insensitively, and new rules are stored lowercase.
-- Rows written before that change can differ only in capitalisation, which the primary key
-- treats as two separate rules for the same sender. Fold them here.
--
-- Revisions first: every row in a group is raised to the highest revision in that group, so
-- whichever row survives cannot hand out a revision a browser has already written against.
UPDATE `sender_rules` SET `revision` = (
	SELECT MAX(`r`.`revision`) FROM `sender_rules` `r`
	WHERE `r`.`account_id` = `sender_rules`.`account_id`
		AND lower(`r`.`address`) = lower(`sender_rules`.`address`)
);
--> statement-breakpoint
-- Then keep one row per sender: the most recently updated, since that is the choice the
-- user made last. A tombstone (`active` = 0) wins the same way, so a rule cleared last
-- stays cleared.
DELETE FROM `sender_rules` WHERE rowid NOT IN (
	SELECT (
		SELECT `r`.`rowid` FROM `sender_rules` `r`
		WHERE `r`.`account_id` = `s`.`account_id`
			AND lower(`r`.`address`) = lower(`s`.`address`)
		ORDER BY `r`.`updated` DESC, `r`.`revision` DESC, `r`.`rowid` DESC
		LIMIT 1
	) FROM `sender_rules` `s`
);
--> statement-breakpoint
UPDATE `sender_rules` SET `address` = lower(`address`) WHERE `address` <> lower(`address`);
