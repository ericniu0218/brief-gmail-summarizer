-- Older workers must not recreate sender-wide suppression during a rolling deploy.
-- Stop old sync workers before applying this migration if they already cached these rows.
UPDATE connections SET recovery_needed=1 WHERE id IN (SELECT account_id FROM unsubscribed);
--> statement-breakpoint
INSERT OR IGNORE INTO unsubscribe_requests
(id,user_id,account_id,address,scope,outcome,detail,created,updated)
SELECT id,user_id,account_id,address,'legacy-sender','unknown',
'Imported during retirement of sender-wide suppression.',created,created FROM unsubscribed;
--> statement-breakpoint
DELETE FROM unsubscribed;
--> statement-breakpoint
CREATE TRIGGER unsubscribed_no_insert BEFORE INSERT ON unsubscribed BEGIN SELECT RAISE(IGNORE); END;
--> statement-breakpoint
CREATE TRIGGER unsubscribed_no_update BEFORE UPDATE ON unsubscribed BEGIN SELECT RAISE(IGNORE); END;
