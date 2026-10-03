# Search and existing correspondents

The magnifying-glass box left of the workspace label expands left into a single search
field with a dropdown. Recent searches are saved in this browser per user and mailbox.
Suggestions update after a 180 ms typing pause and narrow to matching senders and email
previews. Arrow keys navigate suggestions; Enter shows all results. Filter chips support
attachments, the last seven days, unread messages, and replies owed. The filter button
opens sender, subject, and category fields. All filters operate on the synced corpus;
this does not search sent mail.

It searches sender names and addresses together with words in the subject,
body, quoted history, signature, or summary. All words must match; double quotes keep a
phrase together. Search spans every synced category, including Noise and archived mail,
within the selected account scope. Results show matching source passages, newest first,
without sender folds. Fifty results appear initially, with a button to show more. Clearing
search returns to the previous category. Messages not yet synced, hidden senders, sent mail,
Trash and Spam are outside this search.

During sync, direct senders are checked for an earlier email sent to their exact address
in the receiving mailbox. Gmail's search returns candidates; SENT labels, internal dates,
and To metadata verify the evidence. Sent bodies are never downloaded for this check.
The existing Gmail permission is sufficient. Evidence is cached on message records and
reused only in the same user/account scope and for messages after its cutoff. Negative
lookups expire after seven days. A failed lookup remains unknown and is retried later.
Unknown never means the sender is a stranger.

The classifier receives this signal. Crude language and a lack of reply obligations are
explicitly insufficient reasons for Junk. If an existing correspondent's direct mail is
still predicted Junk, the shared conflict policy keeps it visible for review. This does
not override SPAM, campaign headers, commercial purpose, or a user's explicit Junk choice.
The reader shows “You previously emailed this sender.” The existing “Always keep” sender
preference remains the way to state that a sender's mail is wanted.

Content version 9 revisits older messages through the existing paged full scan. Stored
model results are checked against the new evidence without requiring another model call.
