# Promotional mail

A clear commercial promotion belongs in Noise, is never Important, and never creates a
required task, meeting, deadline or reply. Routing to Noise does not archive, delete,
unsubscribe, block or relabel anything, and does not mean the sender is fraudulent.

## Where it lives

| Piece | File |
| --- | --- |
| Purpose assessment and shared checks | `lib/purpose.ts` |
| Rule-based classifier | `lib/deterministic.ts` |
| Model results | `server/classify.ts` (`withPurpose`, called from `validateItem`) |
| Campaign headers | `server/message.ts` (`distribution`) |
| Cache validity | `server/overrides.ts` (`contentFingerprint`), `server/ai.ts` (`PROMPT_VERSION`) |
| Rescan of stored mail | `server/sync.ts` (`CONTENT_VERSION`) |

## How a promotion is recognised

`assessPurpose` looks for five families of commercial signal: offers, commercial calls to
action, purchase reminders, promotional urgency and sales outreach. Each family counts once
however often it repeats. A phrase inside quotation marks is a mention, not an offer.

Distribution evidence (the Promotions tab, list headers, a bulk sender, a preferences
footer) only supports a commercial reading. Receipts, research newsletters and account
notices carry the same evidence, so it is never enough by itself.

A promotion is **clear** when selling is the message's purpose: two families with selling in
the subject or first sentence, two families across a third of the message, three families
across a fifth, one family in the opening with distribution evidence, or outreach that
names buying the sender's product. Otherwise it is **ambiguous** (some selling) or
**absent**.

The assessment also records what must keep a message out of Noise: a transaction that
happened or needs attention, a concrete account event, an existing registration, or a
credible obligation. "Your order" and "complete your order" are not transactions; password
advice is not an account event.

## The shared checks

`applyPurposeChecks` runs on every classification, from either classifier:

- An obligation whose own sentence is selling becomes optional and `commercial`.
- Independent obligations, existing registrations and attached calendar invitations remain required even when sales copy surrounds them.
- A clear promotion keeps a security flag only with a concrete account event, and loses a
  research topic.
- A reply remains owed for a required request, or for a direct personal question without a structured request.

A `commercial` obligation stays visible as extracted text but adds no tag, is not open
work, never files a message under Work and never appears on the calendar.

A model result is overruled the same way: a supported quote proves the words exist, not
that a shopping instruction is the recipient's task. A clear promotion with nothing to
preserve is filed as junk. Mixed or ambiguous messages keep the model's judgement, and the
existing conflict review still protects any credible obligation.

Manual decisions keep their precedence. Keep files a promotion outside Noise without
inventing a task; Junk is always honoured; task corrections are keyed by evidence, which the
checks never rewrite.

## Other rule changes in this round

- Meetings need a meeting: "last call", "call us", a product that syncs, a returns policy
  and news copy about an interview are not meetings.
- A date belongs to its own sentence. Only a deadline or a meeting may take the message's
  single date; requests and actions never borrow one. A full date outranks a bare weekday.
- "Due to" is a cause, not a deadline. Footer wording ("update your preferences") is not a
  task. A survey with a prize is optional.

## How stored mail picks up the rules

- `POLICY_VERSION` and `PROMPT_VERSION` changed. An unchanged model result keeps the model's
  facts and has only the current purpose checks reapplied (`recheckModelResult`); demotions an
  earlier version of the checks made are re-decided. Unchanged rule-based results are rebuilt
  locally when no model is configured, and sent to the model when one is — that is also how a
  message recovers after a model outage. Only a real model call records the model's version.
- The fingerprint now includes the campaign evidence the checks read. Reading or starring a
  message does not change it.
- `CONTENT_VERSION` is 4 (the audit fixes raised it from 3). Each account whose last full scan ran under an older version runs one
  full scan through the existing cursor, one page per refresh, and records the new version only
  when the scan reaches its last page. An interrupted scan resumes. Opening the app never
  triggers classification or model calls.

## Measured, not proven

`tests/promotions.test.ts` holds the named regressions; `tests/eval-set.ts` holds campaign
families, reported by `critical.test.ts` as promotions in Work, promotions Important,
promotions in Noise, legitimate mail in Noise, and important mail demoted. It is a small
synthetic suite and says nothing about production accuracy.

## Known gaps

- Soft-sell campaigns with no recognisable sales phrase stay out of Noise (they are no
  longer Work or Important).
- Explicitly optional applications with a closing date stay out of Important. Ambiguous opportunities still need review.
- The model instructions have been tested only against mocked responses.
