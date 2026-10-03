# Needs a reply

“Needs a reply” answers one question: **does the recipient currently owe someone an email
answer, decision, confirmation, information, or emailed deliverable?** It is kept separate
from importance, urgency and tasks. A routine question can need a reply without being
Important; a security alert can be Important without needing a reply; an approval made in a
portal is a task, not a reply.

## Where it lives

| Piece | File |
| --- | --- |
| The policy, shared by every path | `lib/reply.ts` (`assessReply`, `reconcileReply`) |
| Stored decision | `Classification.reply` (`lib/classification.ts`); `replyRequired` is derived from it |
| Rule-based classifier | `lib/deterministic.ts` |
| Model output | `server/classify.ts` (`CLASSIFY_SCHEMA.reply`, `modelReplyDecision`, `recheckModelResult`) |
| Sales copy | `lib/purpose.ts` (`applyPurposeChecks`) |
| Corrections | `server/overrides.ts` (`replyAfterCorrections`) |
| Tab, counts, order | `app/page.tsx`, `lib/inbox-priority.ts` (`SortMode 'reply'`), `components/priority-email-list.tsx` |
| Explanation | `components/classification-detail.tsx` |
| Late responses after a send | `hooks/use-inbox.ts` (`keepSentReplies`) |

## How a decision is made

Each request in the current message (never quoted history) is judged separately:

- **Is something asked?** A question put to the recipient; an instruction to confirm, send,
  reply, provide, approve, choose a slot, return, quote; “I need your decision”; “I'd
  appreciate knowing whether…”. Rhetorical marketing questions are not.
- **Whose is it?** “Priya, could you…” is Priya's when Priya is another recipient; a message
  the user is only copied on is *uncertain*.
- **Where is it answered?** By email unless the message puts it elsewhere: “approve it there”
  after naming a portal, “use the button below”, “in the event page”. An explicit email cue
  (“reply with”, “by email”) wins: “approve in the portal, then reply with the code” needs a reply.
- **Is it conditional?** “Let me know only if the timing changes”, “reply if it happens
  again” wait. “If none of these times work, suggest alternatives” and “if it is disputed,
  tell me what needs correcting” still need an answer. A condition attaches to its own clause,
  so “return the signed form, or reply if you need to discuss” still needs the form.
- **Is it optional?** Surveys, product feedback, “you can also reply”, cold sales offers
  (“would you be open to a call”), and desire-conditioned offers (“if you'd like to join,
  reply”) are optional — unless the message says the recipient asked for it (“as discussed”,
  “as you asked”) or trusted context says so.
- **Settled?** Acknowledgments, receipts, confirmations of an existing arrangement, and
  “we will contact you” need nothing. A “thanks” never cancels a separate new question.
- **Automatic replies** need no answer. **Impersonation** (two independent signs, one of them
  a payment / gift-card request or a request to skip normal verification) is not answered;
  it is held for review with a “check through a contact you already know” explanation.

One open, required, email-answered request is enough. The result records `status`
(`required` / `not_required` / `uncertain`), `urgency` (`prompt` / `routine` / `unknown`),
`channel`, a reason code, the quoted evidence, a short explanation, and — only when the
answer itself has a date (“by Monday”) — `due`. A meeting date, leave dates or a delivery
date are not a reply deadline.

**Uncertain is never shown as “No reply needed”.** It goes to review (`reply-uncertain`) and
the row says “Reply unclear”.

**Urgency.** Prompt when the answer has a deadline within 14 days, something is blocked or
broken (overdue, wrong, duplicate, cannot sign in, “so I can…”), a deadline is being moved,
or a near-term time is proposed. Otherwise routine. “URGENT” in a subject is not evidence.

## Model output

The model returns a `reply` object beside `replyRequired`. The shared policy reconciles it
with the rules (`reconcileReply`):

- kept where the model sees a request the rules cannot read;
- overruled where the message settles it: automatic replies, impersonation, an approval the
  message places in a portal, a conditional or optional sentence, an action that asks for
  nothing back;
- evidence must be in the current message — quoted history, a signature or a footer is not
  trusted, and the disagreement goes to review;
- an explicit emailed deliverable overrules a model's “no”;
- an invalid reply object does not reject the rest of the result.

## Answered state

`needsReply = !replied && replyRequired`. `replied` is set only by a successful send
recorded by `/api/reply` (never a draft, never a refused or unconfirmed send). It is per
account and message, so the same Gmail id in another mailbox, or a newer message in the same
thread, is unaffected. A late sync or correction cannot bring the badge back after a send
(`keepSentReplies`, the upsert's `replied` guard).

Writers always store `replyRequired` derived from the stored `reply`, so the legacy
“cleared badge beside `replyRequired: true` means a send” inference in `server/messages.ts`
is never triggered by a policy change.

## Existing mail

`POLICY_VERSION`, `PROMPT_VERSION` and `CONTENT_VERSION` (5) were raised. Each account runs
one resumable full scan through the existing cursor; rule-based results are rebuilt
locally, model results are rechecked locally without a model call, and the new version is
recorded only on messages actually re-evaluated. Until the scan reaches a message, its
earlier decision is shown.

## Evaluation (workbook, September 30, 2026)

`tests/fixtures/reply-workbook.json` is generated from the review workbook by
`scripts/reply-workbook-fixture.py` (development only). `tests/reply-workbook.test.ts`
asserts every remaining disagreement by ID.

| Run | Flagged | False positives | False negatives | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| Before (rules, message only) | 30 | 6 | 23 | 0.80 | 0.51 |
| After (rules, message only) | 45 | 0 | 2 (E023, E095) | 1.00 | 0.96 |
| After (rules, with recipient context) | 47 | 0 | 0 | 1.00 | 1.00 |
| Mocked careless model → validation | 45 | 0 | 2 (E019, E095) | 1.00 | 0.96 |

Prompt versus routine, where both agree a reply is needed: one disagreement, E054 (two
references, no deadline or blocker stated; the workbook rates it prompt).

**Context production does not have.** E023 (a vendor follow-up the recipient asked for) and
E095 (early access the recipient wants) are reply-needed only because of the workbook's
Recipient context. Production has no stored source for “I asked this vendor to follow up”
or “I want this offer”, so it never claims to know: E023 is held as *uncertain* for review,
E095 is treated as an optional offer. `RecipientContext` is the seam for a future
preference.

No live model was evaluated; model results above are simulated answers passed through the
real validation code.
