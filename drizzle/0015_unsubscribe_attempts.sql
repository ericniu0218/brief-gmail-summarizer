-- One attempt owns a request at a time. Every completion write names the attempt it
-- belongs to, so a slow first attempt cannot overwrite the result of a later one.
ALTER TABLE `unsubscribe_requests` ADD `attempt` text;
