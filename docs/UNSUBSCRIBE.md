# Unsubscribe: required behaviour and current-state trace

Sections 1 and 2 of the unsubscribe rework. This file records the behaviour the
implementation must satisfy and every place the current code makes mail disappear, so the
later sections can be checked against something written down rather than against memory.

No behaviour was changed to produce this document.

## 1. Required behaviour

### What unsubscribe is

Unsubscribe asks **the sender** to stop sending a newsletter. It is a request made to an
external party. It is not a filing decision, and it says nothing about what this app should
show.

The consequences follow from that one sentence:

- Clicking Unsubscribe submits a request for the newsletter that the **selected message**
  belongs to, through the Gmail account that **received that message**.
- Existing messages stay visible and searchable. Nothing is deleted, archived or hidden.
- Future receipts, security alerts, account updates and everything else from that sender
  remain eligible to appear normally.
- If the newsletter keeps sending, those messages appear too. The sender controls delivery;
  this app must not quietly hide arriving mail to make the button look like it worked.
- Unsubscribing never creates a junk rule, blocks a sender, or suppresses anything.

### What may be claimed

The app knows only what its own request returned. It must never state:

- that the sender will honour the request;
- that only one newsletter is affected, when the sender's subscription scope is unknown;
- "Unsubscribed" because a page was opened.

A provider accepting the request means exactly that: the request was accepted.

### When automatic unsubscribe is available

Only when the message itself provides a supported, safely verifiable method. Otherwise the
app explains briefly why it cannot finish and offers a manual path.

### Three separate actions that must not be confused

| Action | Who it addresses | Effect on stored mail | Effect on future mail |
| --- | --- | --- | --- |
| **Unsubscribe from a newsletter** | The external sender | None | None inside the app |
| **Mark a sender as junk** | This app | None | Future mail is filed into Noise |
| **Hide messages locally** | This app | Hidden | Hidden |

The current code performs all three when the user asks for the first. Separating them is
the substance of section 3.

Existing explicit junk preferences (`sender_rules`, and per-message `overrides`) are a
deliberate user choice and must keep working exactly as they do. Fixing unsubscribe must
not touch their meaning.

### Scope note

Keep the button where it is. Do not add another permanent control to the dashboard.

## 2. Trace of the current implementation

### The flow as it exists

1. **`components/noise-list.tsx:24`** — Noise is grouped by `senderKey` (account + sender
   address). Each group shows one button, driven by the group's **first** message: an
   Unsubscribe button when `first.oneClick` is true, otherwise a "Review in Gmail" link.
2. **`components/noise-list.tsx:16-23`** — `unsubscribe()` posts `{id, accountId}` to the
   route. On `{manual:true}` it shows a Gmail link; otherwise it calls `onRemoved(email)`.
3. **`app/api/unsubscribe/route.ts:7-33`** — verifies ownership, refetches the message from
   Gmail, and requires `unsubscribe && oneClick && safeUnsubscribe(url)` before POSTing
   `List-Unsubscribe=One-Click` with `redirect:'manual'` and a 15-second timeout.
4. On a non-`ok` response it throws 502. On success it records the sender and deletes mail.

### Every point where unsubscribe suppresses mail

Seven, in four layers. All of them key off the **sender address**, never a newsletter.

| # | Location | What it does |
| --- | --- | --- |
| 1 | `app/api/unsubscribe/route.ts:20` | Inserts into `unsubscribed` keyed `account:address` — a sender-wide record that later acts as a suppression instruction |
| 2 | `app/api/unsubscribe/route.ts:24` | `DELETE FROM mailbox_messages … json_extract(data,'$.address')=?` — destroys every stored message from that sender in that account |
| 3 | `app/api/unsubscribe/route.ts:26` | If the delete changed no rows, rewrites the snapshot to drop every message from that address |
| 4 | `server/sync.ts:187` | The upsert carries `WHERE NOT EXISTS (SELECT 1 FROM unsubscribed …)`, so **future** messages from that sender are never stored |
| 5 | `server/sync.ts:191` | Every sync re-deletes stored messages for each muted address |
| 6 | `app/page.tsx:143` | `onRemoved` filters the in-memory list by `senderKey`, removing the sender from the browser immediately |
| 7 | `components/noise-list.tsx:20` | Demo mode calls the same `onRemoved`, so the sample workspace teaches the same wrong model |
| 8 | `server/sync.ts:154` | The page loop `continue`d past any message whose sender was muted, so it never reached the write at all |

Point 8 was **missed by the first pass of this trace** and found by the type checker while
section 3 was being implemented. It is recorded here rather than quietly fixed: a search for
`unsubscribed` does not find it, because it reads the in-memory `muted` set built at the top
of the function. Anything else keying off a local variable rather than the table would hide
the same way.

Points 4 and 5 are the ones that make the loss permanent: even if the stored rows were
restored, the next sync would remove them again and refuse to write new ones.

### What does *not* suppress mail

Verified by search, so section 3 does not need to go looking:

- `server/mailbox.ts` and `server/messages.ts` contain no reference to `unsubscribed`.
- `server/snapshots.ts` mentions unsubscribe only in a comment about concurrency
  (`snapshots.ts:22`); the filtering is done by the route, not by snapshot reading.
- `server/overrides.ts` is untouched by unsubscribe. Sender junk rules are a separate path.
- `app/api/disconnect/route.ts:34` deletes `unsubscribed` rows with the rest of an account's
  data, so disconnecting does not strand records.

### The data model today

```
unsubscribed(id PK, user_id, account_id, address, created)
UNIQUE INDEX unsubscribed_account_address (account_id, address)
```

`id` is `accountId + ':' + address` (`route.ts:20`). Migration `0004_lucky_tempest.sql:71-83`
rebuilt the table to add `account_id`, backfilling it from `user_id`.

Three consequences matter for section 4:

- The identity is **one row per sender address per account**. There is no `List-ID`, no
  message id, and no way to tell two newsletters from one publisher apart.
- Existing rows therefore mean *both* "a request was submitted" *and* "hide this sender".
  They cannot be read as identifying a particular newsletter, and must not be replayed as
  new unsubscribe requests.
- There is no status column at all: no in-progress, failed, or uncertain state. Section 5's
  capability/outcome model has nothing to migrate from.

### Capability detection today

- `server/gmail.ts:76-77` reads `list-unsubscribe` and takes the **first** `<https://…>`
  match only. A `mailto:` method is ignored; multiple methods are not considered; nothing
  is kept if only a mailto exists.
- `server/gmail.ts:94` sets `oneClick` from `list-unsubscribe-post` containing
  `list-unsubscribe=one-click`, case-insensitively.
- `server/message.ts:218` lowercases header names into a plain object, so **a duplicate
  header silently wins over the earlier one** and conflicting values are never detected.
- `server/gmail.ts:102-107` — `safeUnsubscribe` requires HTTPS, rejects embedded
  credentials and non-443 ports, and matches an allowlist of known bulk providers plus
  `UNSUBSCRIBE_ALLOWED_HOSTS`. This is the protection to keep and build on, not remove.
- `server/sync.ts:170` recomputes `oneClick` at sync time through the same allowlist, so
  the stored flag already means "supported *and* verifiable", not merely "claimed".

### Statements the interface currently makes that are not true

- `noise-list.tsx:21` — *"Unsubscribed from {sender}."* The app cannot know the sender will
  honour it, and the message is shown for the whole sender group.
- `noise-list.tsx:24` — *"Unsubscribing leaves existing emails in Gmail."* True of Gmail,
  and false of this app, which deletes its own copies.
- One button per sender group acts on `first`, implying one click covers every newsletter
  from that sender.

### Tests that touch this area

No existing test asserts that mail is suppressed, which means section 3 can remove the
suppression without rewriting test expectations:

- `tests/critical.test.ts:62-68` — `safeUnsubscribe` allowlist and the rule that an
  unsubscribe header alone does not prove junk.
- `tests/critical.test.ts:864` — unsubscribing in one mailbox is not the other.
- `tests/interaction.test.ts:413-422` — an unattributed message refuses to submit.
- `tests/gmail-connection.test.ts:139, 541, 581` — `unsubscribed` rows survive reconnect and
  are removed on disconnect. These assert row preservation, not suppression.

### Risks carried into the later sections

1. **Recovery is bounded by Gmail.** Messages deleted by point 2 can be restored only if
   they are still in Gmail and still inside the app's scan scope
   (`server/sync.ts:75`: `-in:sent -in:trash -in:spam -in:drafts`). Anything the user later
   deleted in Gmail is gone, and must not be claimed as recoverable.
2. **Rollout ordering.** An older running instance keeps enforcing points 4 and 5. The
   migration must stop old records acting as instructions *before* the recovery scan runs,
   or restored messages will be deleted again by whichever version is still live.
3. **Newsletter identity is mostly unavailable.** `List-ID` is not currently parsed or
   stored. Where it is absent the history must stay tied to the selected message rather
   than inventing a sender-wide identity.
4. **The group button.** Section 12 requires the action not to imply unsubscribing from
   everything a sender sends; the current grouping does exactly that.


## 3. Unsubscribe no longer suppresses mail — done

All eight points are removed. The server stores every message Gmail returns
(`server/sync.ts`), the route records the request and touches no mail
(`app/api/unsubscribe/route.ts`), and the browser keeps the sender on screen
(`components/noise-list.tsx`, `app/page.tsx` no longer pass `onRemoved`).

Unchanged on purpose: classification, manual corrections, `replied` state, and sender junk
rules. The mailbox write still preserves a reply recorded concurrently, so an unsubscribe
arriving beside a sync cannot resurrect a `needsReply` flag or drop a message — there is no
longer any code path in which an unsubscribe removes a row at all, so the race that used to
matter cannot occur.

Demo mode now sends nothing and says so.

## 4. Transition and recovery — done

`drizzle/0014_unsubscribe_requests.sql` is additive:

- `unsubscribe_requests` holds history: message id, List-ID (when section 6 starts storing
  one), address, scope, outcome, detail, timestamps.
- Old rows are imported as `scope='legacy-sender'`, `outcome='unknown'` with a detail line
  stating what was and was not recorded. They are never replayed as new requests.
- `connections.recovery_needed` is set for every account that held one.
- `DELETE FROM unsubscribed` empties the old table, which is what stops an instance still
  running the previous version from deleting mail during a rollout. The table is kept so
  that old code keeps working and a rollback has somewhere to write.

Recovery reuses the existing scan: `recovery_needed` makes the *next* scan a full one, a
scan already in progress keeps its saved cursor, and the flag is cleared only by the
completion write, which already requires an unchanged lease and credential. An interrupted
recovery therefore resumes rather than being lost, and nothing is cleared up front, so the
visible inbox is never emptied while it runs.

**Recovery restores only what Gmail still has**, inside the app's scan scope
(`-in:sent -in:trash -in:spam -in:drafts`). Mail deleted in Gmail itself is gone.


## 5. Capability and outcome are separate — done

`lib/unsubscribe.ts` holds the vocabulary, shared by server and browser.

**Capability** — what the app can do with the selected message: `one-click`, `manual-page`,
`email-required`, `none`, `unverified`, `unavailable`.

**Outcome** — what happened when it tried: `none`, `pending`, `accepted`, `action-required`,
`failed`, `unknown`.

Neither is derived from the other. `accepted` means the service took the request and nothing
more; it is never read as proof that the sender unsubscribed anyone.

Both are validated at every boundary. `asCapability` and `asOutcome` return `undefined` for
anything unrecognised, and `completeStoredEmail` runs stored values through them, so a row
written by an older version degrades instead of reaching the interface as a raw string.

Each message now carries `unsubscribeCapability`, computed in `server/sync.ts` from the same
call that sets `oneClick`, so the two cannot disagree.

## 6. Account and newsletter come from trusted data — done

The browser sends only `{id, accountId}`. The server verifies the account belongs to the
signed-in user, refuses the combined `all` selection (`getOwnedConnection`), re-reads the
message from that account's Gmail, and derives everything from the message's own headers.
No URL or recipient is ever accepted from the browser, and no destination is guessed from a
sender's domain.

`describeUnsubscribe` (`server/unsubscribe.ts`) decides capability. A one-click endpoint is
automatic only when it also passes `safeUnsubscribe`; a provider this server will not call
is offered as a page to open instead, so the person is never left with nothing.

**Newsletter identity** comes from `List-ID` when the message states one: the bracketed
value per RFC 2919, lower-cased and length-capped, with the display phrase discarded. The
request key is then `account:list:<id>`, so two newsletters from one publisher never merge,
and the same newsletter in two mailboxes stays two records. With no `List-ID` the key is
`account:message:<id>` — narrower than the truth rather than wider.

`scopeDescription` supplies the honest wording: a `List-ID` names the list the message
belongs to, but never proves the publisher's endpoint affects only that list.


## 7. Instructions are parsed defensively — done

`server/message.ts` now keeps **every** value for a repeated header in `headerValues`, so
two `List-Unsubscribe` headers no longer silently overwrite each other. `headers` is
unchanged for its many other callers.

`parseListUnsubscribe` (`lib/unsubscribe.ts`) handles: folded continuation lines, runs of
whitespace, several methods in one header, a header repeated, values with no usable method,
and values long enough to be an attack (2 KiB per header, 1 KiB per method). Only bracketed
entries count — a bare URL in that header is not the documented form, and reading one would
mean treating a display string as a destination.

**Repeated headers that disagree yield nothing.** Picking either could send a request the
sender never offered, so the capability becomes `unverified` and the person is sent to Gmail.

**One-click now requires a covering signature.** RFC 8058 only permits an automatic POST
when `List-Unsubscribe` and `List-Unsubscribe-Post` are covered by a passing DKIM signature.
`oneClickAuthenticated` requires two independent things: the *first* `Authentication-Results`
header — the one the delivering server prepends, later ones travelled with the message and
are attacker-controlled — reports `dkim=pass` with a signing domain, and a `DKIM-Signature`
from that same domain lists both headers in its `h=` tag. A header that merely claims
authentication passed proves nothing and is not enough. Where this fails the link is still
offered manually, so a legitimate newsletter is never a dead end.

Not detectable from here: a link that has expired or was minted for one recipient. Those
fail at the provider and surface as an outcome, not a capability.

## 8. Destination protections — done

The approved-provider allowlist is kept and is still what decides whether this server will
call an address by itself. Added around it:

- `privateDestination` refuses loopback, both private ranges, link-local (including the
  cloud metadata address), carrier-grade NAT, this-network, any IPv6 literal, any
  single-label name, and names ending `.localhost`, `.local`, `.internal`, `.intranet`,
  `.lan`, `.home`, `.corp`.
- Hostnames are compared on domain boundaries and a trailing dot is normalised, so
  `list-manage.com.attacker.example` does not match and `news.list-manage.com.` does.
- Already true and kept: HTTPS only, no embedded credentials, no unexpected port,
  `redirect: 'manual'` so a redirect is reported rather than followed, a 15-second timeout,
  and no Gmail token, cookie or app credential on the outbound request.
- Unsubscribe URLs are never logged. The stored `detail` records the provider's status code
  and nothing else, so a subscriber token in a query string is not written anywhere.

**DNS is not resolved**, so a hostname that resolves to a private address, or rebinds
between check and request, is not detected. That is acceptable only because the allowlist
confines automatic requests to known bulk providers. Widening the allowlist would require
resolving and pinning the address before connecting — recorded as a condition on that
change, not a task for today.

The manual path is checked more loosely on purpose: opening a page happens in the person's
own browser under their control, so an unknown provider is allowed, but scheme, credentials,
port and private destinations are still refused.

## 9. Reporting only what is known — done

The POST is made only after the person clicks, only for a message that still qualifies when
the server re-checks it, and only to the destination in that message's own headers.

| What came back | Outcome | Why |
| --- | --- | --- |
| 2xx | `accepted` | The service took the request. Nothing more is claimed. |
| 3xx | `action-required` | A redirect is a step this app cannot take for the person. |
| 4xx | `failed` | A definite refusal; a retry is offered. |
| 5xx | `unknown` | The service is broken, which is not the same as rejecting the request. |
| Timeout or dropped connection | `unknown` | It may have arrived; its answer was lost. |

No confirmation page is fetched or scraped, no login or CAPTCHA is worked around, and no
unsubscribe email is sent — `email-required` always goes to the manual path.

**A database failure after the provider accepted is reported as this app's problem.** The
row write is separated from the answer: if it fails, the response still carries the real
outcome plus `recordFailed`, because telling someone their request was rejected when the
service accepted it is the worst available answer.

## 10. Duplicates and races — done

The claim and the record are one statement (`INSERT … ON CONFLICT DO UPDATE … WHERE`), so:

- **One attempt owns a request at a time.** The row is never deleted and re-inserted, which
  would let a concurrent retry slip between the two halves.
- **A claim is granted** from `none` or `failed`, from `unknown` only after the person confirms they checked the sender’s settings, or when a previous attempt has held
  the row past its 60-second lease and is presumed lost.
- **A completed request returns its saved result** instead of sending a second POST.
- **An uncertain outcome is never retried automatically.** Repeating a POST that may already
  have succeeded could unsubscribe a list the person has since rejoined.
- **A failed request stays recoverable** — `failed` is a claimable state.
- **A stale attempt cannot overwrite a newer result**: every completion write names its
  attempt id in the `WHERE`, so a slow attempt that wakes up writes nothing.

In the browser a synchronous ref guard blocks the second of two fast clicks before it
becomes a request, and the button is disabled while one is running.

Unsubscribe history is independent of the mailbox sync lock: a refresh in progress neither
blocks an unsubscribe nor is blocked by one.

### Notes from sections 9 and 10

- An uncertain outcome stays sticky on an ordinary retry. After checking the sender’s settings, the person can explicitly retry. The server requires `confirmRetry: true` for that state.
- A `failed` result can be retried without this confirmation.
- The suite races two real requests against a scriptable provider stub rather than reasoning
  about the code.

## 11. A sentence for every situation — done

The server returns a stable `reason`; the browser owns the wording (`notice()` in
`lib/unsubscribe.ts`). Keeping them apart means the text can change without the server
pretending something else happened, and a code this version predates falls back to a general
sentence rather than showing an empty notice.

| Reason | Notice | Next step |
| --- | --- | --- |
| `accepted` | The newsletter service accepted your unsubscribe request. Your existing emails will stay here. | — |
| `in-progress` | That request is already being sent. | — |
| `confirmation-required` | This newsletter requires confirmation on its website. Open the unsubscribe page to finish. | Open unsubscribe page |
| `email-required` | This newsletter asks you to unsubscribe by email. Open the message in Gmail to follow its instructions. | Open in Gmail |
| `no-instructions` | This email doesn't include a supported unsubscribe option. Open it in Gmail to check the sender's instructions. | Open in Gmail |
| `unverified-destination` | We couldn't verify this unsubscribe link. Open the original email in Gmail to review it. | Open in Gmail |
| `account-disconnected` | Reconnect this Gmail account before trying again. | — |
| `provider-rejected` | The newsletter service couldn't accept the request. Try again later or finish in Gmail. | Open in Gmail |
| `uncertain` | We couldn't confirm whether the request went through. Check the newsletter's subscription settings before trying again. | Open unsubscribe page |
| `unreadable` | This message couldn't be read from Gmail. Open it in Gmail to unsubscribe there. | Open in Gmail |
| `record-not-saved` | The newsletter service accepted your request, but we couldn't save that here. Nothing needs redoing. | — |

A credential failure is caught and reported as `account-disconnected` beside the button,
rather than surfacing as a generic error. **Opening a page is never reported as success.**

## 12. The interface — done

**The control belongs to a newsletter, not a sender.** Messages are still grouped by sender
for reading, but the unsubscribe button appears on the group row only when the group holds
one newsletter (by List-ID, else by message). A sender with two lists gets a line saying so
and a control on each message instead, because one button there would imply it covered both.

Also done:

- The message stays listed after an accepted request.
- Each notice sits directly under its own button, in an `output` with a live region, so a
  screen reader announces it; failures can expand "What does this cover?" for the scope
  sentence, which stays collapsed by default.
- `stopPropagation` on the control, so unsubscribing never opens or closes the group. The
  per-message row is a container with its own opener button, so no button nests in another.
- Focus is visible on every control, and long names wrap at phone width — the group row wraps
  and the control goes full width rather than pushing off screen.
- A late answer is dropped if its newsletter is no longer on screen (account switch, view
  change); the server-side record is already written, so nothing is lost.
- Demo mode submits nothing and says "Demo only".
- There is no Undo, because resubscribing means going through the publisher's signup.

### Notes from sections 11 and 12

- Both failures in that batch were test bugs, not code bugs: a text query where an aria-label
  query was needed, and "two" written where the interface says "2". Those two behaviours were
  only genuinely verified on the second attempt.
- Splitting newsletters depends on senders setting `List-ID`. Without one, every message is
  its own identity, so a sender with several unnamed lists shows a control per message —
  cautious, slightly noisier, and the alternative is guessing that one address means one list.
- `listId` reaches a message only when it is synced after this change; older rows behave as
  message-scoped until a full scan rewrites them.

## 13. Tests — done

313 tests pass. What is covered, in the order the specification asked for it:

| Path | Where |
| --- | --- |
| An accepted request keeps mail in the browser and the database | `interaction`, `gmail-connection` |
| Later receipts and newsletters from that sender still sync | `gmail-connection` |
| An explicit junk rule is untouched by an unsubscribe | `gmail-connection` |
| Two newsletters from one sender keep separate identities and controls | `critical`, `interaction` |
| The same newsletter in two mailboxes is two records | `gmail-connection` |
| A forged account id, and a destination supplied by the browser, are refused | `gmail-connection` |
| Malformed, folded, repeated, conflicting and unsigned instructions | `critical` |
| Private, deceptive and prohibited destinations; redirects not followed | `critical`, `gmail-connection` |
| Double-click, second tab, delayed response, concurrent retry | `gmail-connection`, `interaction` |
| A dropped connection is uncertain, not success or refusal | `gmail-connection` |
| Provider accepted but the record could not be written | `gmail-connection` |
| A disconnected account gains no record, and loses its history | `gmail-connection` |
| A recovery scan restores mail and resumes after interruption | `gmail-connection` |
| Demo mode sends nothing | `interaction` |
| Button states, notices, group behaviour, account switching | `interaction` |

Providers are mocked throughout and every database is in-memory. No real newsletter is
contacted by any test.

## 14. Validation

Passing locally: 313 tests, `tsc --noEmit`, `oxlint` (one pre-existing `worker.ts` warning),
`vinext build`, `git diff --check`, and the migration chain both from empty and as an upgrade
from 0013 carrying legacy rows.

The final diff review found one real gap, now fixed: `app/api/disconnect/route.ts` cleaned the
old `unsubscribed` table but not `unsubscribe_requests`, so disconnecting a mailbox would have
left its history behind. A test now covers it.

**Nothing here has been verified against a real newsletter provider.** No browser was
available either, so layout, focus order and dark mode are unverified. Every claim above is a
local result.

## 15. Block sender, as the fallback — done

Requested after section 14: a verified newsletter gets one-click Unsubscribe; any other
sender gets **Block sender**, which hides that sender's mail in this app.

- Blocking is separate from unsubscribing, and stored separately (`blocked_senders`,
  migration 0016). The emptied legacy `unsubscribed` table is **not** reused: an older
  running instance still reads that table and deletes mail from it.
- Blocking hides mail only when a view is read (`server/mailbox.ts`). Sync still stores
  every message, nothing is deleted from the database, and Gmail is never touched, so
  unblocking restores everything.
- It applies to one sender address in one connected account, compared case-insensitively.
- It is offered on any sender group without a verified one-click unsubscribe, and after an
  unsubscribe that did not go through ("Block sender instead").
- The Quiet corner lists blocked senders with an Unblock button. Disconnecting an account
  removes its blocks.
- Blocked mail disappears from every view in this app, including Important. A blocked
  sender's receipts and security codes are hidden too; they are still in Gmail.
- Not covered: the shared-workspace Gmail adapter (`server/workspaces/gmail-adapter.ts`)
  does not read blocks. It only shares what the person selects.

## Open items carried forward

Recorded as they are found, so nothing depends on remembering them.

1. **The interface has not caught up.** The route returns capability, outcome, scope and a
   page link; `NoiseList` still reads the old shape and shows generic wording. Sections 11
   and 12.
2. **The outcome mapping is provisional.** 3xx to `action-required`, 4xx to `failed`,
   timeout to `unknown`. Section 9 settles it, including a database failure that happens
   after the service already accepted.
3. **One button still sits on a sender group**, so it can still imply it covers everything
   that sender sends. Section 12.
4. **Rollout protection.** Migration 0017 imported and emptied the retired `unsubscribed` table.
   Migration 0018 replaces its ignore-trigger: an older instance's unsubscribe now becomes a
   `legacy-sender` history row, schedules a recovery scan, and leaves a
   `legacy_unsubscribe_guards` row that stops that instance's follow-up delete of the sender's
   stored mail. The legacy row is removed at once, so an older sync never sees a suppression
   rule. The current sync clears an account's guards when it starts the recovery scan.
   Older snapshot-only fallbacks may still be rewritten by that instance; the recovery scan
   rewrites them from Gmail.
5. **Recovery restores only what Gmail still holds**, inside the scan's scope.
