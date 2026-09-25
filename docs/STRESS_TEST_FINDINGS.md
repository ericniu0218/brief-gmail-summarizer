# Stress test findings — gmail-hub (round 3)

2026-09-25

**All twelve findings from rounds 1 and 2 are fixed and verified.** Two new defects were
found, both P2, and neither was caused by the latest fixes — one is a long-standing
lifecycle gap in the same family as a bug just fixed, and the other is a small residue of
the future-date fix.

This is the first round where the fixes introduced nothing new.

275 tests pass, typecheck clean, lint clean. No code was changed for this report.

## Rounds 1 and 2 — all fixed

Each was re-run with the probe that originally found it, not checked by reading the diff.

| Round | Defect | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Refresh dies after marking during a sync | Fixed | Refresh recovers; `busy=false` |
| 1 | Future-dated email Important for ever | Fixed | `important=false`; sorts last |
| 1 | Set with no value silently clears | Fixed | 400; rule still active |
| 1 | Empty sender address saved as a rule | Fixed | 409 for empty, whitespace, no-`@` |
| 1 | Clear accepts a value | Fixed | 400 |
| 1 | No address length limit | Fixed | Refused before any write |
| 1 | SVG and event handlers unsanitised | Fixed | Both removed |
| 1 | No bound on "Next event" | Fixed | Year-9999 returns nothing |
| 2 | Mixed-case sender rule silently inert | Fixed | Applies to both case variants; revisions agree |
| 2 | Two syncs could run at once | Fixed | Peak concurrent = 1 |
| 2 | Events beyond a year vanished | Fixed | Horizon widened to five years |
| 2 | Future-date guard was optional | Fixed | `now` is now required |

The mixed-case fix is the one worth noting. A new `senderRuleFor` helper normalises both
sides of the comparison, so a rule saved from `News@Berkeley.EDU` now matches
`NEWS@berkeley.edu` and reports a revision the browser can write against. Undo works from
the revision the mailbox reports. A different sender at the same domain is still untouched.

## New findings

| # | Severity | Defect | Where | Cause |
| --- | --- | --- | --- | --- |
| R1 | P2 | Switching account during a refresh shows a spurious error | `hooks/use-inbox.ts` | Long-standing |
| R2 | P3 | A forged future date still sorts first on the first paint | `lib/inbox-priority.ts` | Residue of the round-1 fix |

---

## R1 — Switching account during a refresh shows a spurious error

Press **Refresh inbox**, then switch account before it finishes, and the app shows
*"This inbox is already being refreshed."* The message stays on screen after the original
refresh completes.

### Why

`selectAccount` and `resetToDemo` both clear the sync mutex directly:

```
inFlight.current = false;
setBusy(false);
```

They then start their own load, and `loadConnectedInbox` issues a `/api/sync` of its own.
With the mutex released, the still-running first sync no longer blocks it, so two reach the
server. The per-account lease refuses the second with a 409, and `selectAccount`'s catch
turns that into a notice.

Measured with a lease-enforcing stub, the sequence refresh → switch → refresh produced
**three concurrent `/api/sync` requests**.

This is the same shape as the round-2 concurrency bug, which was fixed for `reloadCached`
by giving the sync its own token. `selectAccount` and `resetToDemo` were not part of that
change. It predates both, so it is newly found rather than newly introduced.

### Reproduced

```
after refresh                    : notice=""
after switching account mid-sync : notice="This inbox is already being refreshed."
after the first sync finishes    : notice="This inbox is already being refreshed."
```

### Fix

Extend the round-2 approach to the other two callers. They should invalidate the sync
token as well as the generation, so the superseded sync stops holding the mutex *and*
cannot be replaced by a duplicate:

```
++syncGeneration.current;   // the running sync is superseded
inFlight.current = false;
setBusy(false);
const request = ++generation.current;
```

A 409 from the lease is also worth treating as benign in this path. It means a refresh is
already under way, which is not a failure the user needs to read about.

Test: hold a sync open, switch account, and assert only one `/api/sync` is in flight and
no error notice appears.

---

## R2 — A forged future date still sorts first on the first paint

The future-date guard is skipped when the clock is unknown, which is the state of the
server render and the first client paint. Ordering then falls back to newest-first, so a
message with a forged timestamp takes the top of the list until hydration replaces it.

```
with a clock   : ["new", "old", "forged"]
unknown clock  : ["forged", "new", "old"]
```

The message is not marked Important — that path is not reached without a clock — so this
is ordering only, and it corrects itself within a frame. It is the last residue of the
round-1 bug rather than a return of it.

### Why

`receivedAtOf(email, now)` applies the future check only when `now` is a number.
`sortInboxEmails` passes `null` before hydration, by design, so the check is skipped along
with everything else that needs a clock.

### Fix

The ceiling does not actually need the current time. A timestamp beyond any plausible
arrival is unusable whatever the clock says, so the guard can use the most recent
timestamp in the batch, or simply a fixed sanity bound, when `now` is unknown. Either
removes the last case where a forged date can lead the list.

---

## What held up

Attacked directly this round.

**The rewritten inbox lifecycle**, in four adversarial sequences. Refresh → reload →
reload → refresh keeps exactly one sync in flight and recovers afterwards. A reload during
start-up does not jam refresh. Resetting to demo while a sync is open leaves demo data on
screen, not stale mail — the superseded sync cannot repopulate a disconnected inbox. Only
the account-switch path (R1) misbehaves.

**Sender address matching.** A rule saved from one capitalisation applies to messages
stored with another, does not reach a different sender at the same domain, and reports a
revision the browser can use. The API route normalises on its own lookup too, so the
revision it returns and the one the mailbox reports agree.

**Address shapes.** `user+tag@example.com`, `user@sub.example.co.uk` and a Unicode local
part are accepted. `user@@example.com`, a quoted local part containing a space, and an
over-long address are refused. Synthetic `unattributed:<id>` identities have no `@` and so
can never match a rule.

**The widened event horizon.** Thirteen months and four years out are shown; six years and
year 9999 are not.

**Malformed classifications.** Null obligations, a string where an array belongs, an
obligation with no fields, `due` as a string or a nested object, year 0000, year 9999, and
a time at the edge of representable range: every one returns a finite rank and a boolean,
with no throw and no `NaN`.

**Sorting.** Does not mutate its input. Identical output from reversed input. Stable when
two messages share both a due time and an arrival time.

**Date parsing and calendar arithmetic.** Only an exact `YYYY-MM-DD` is accepted; 30
February is refused on both the date and time paths; month grids are complete Monday-start
weeks with no daylight-saving gaps; February 2028 has 29 days.

**Authorisation.** The reserved combined-inbox id is refused 400, a foreign account 404,
and negative, fractional, string and out-of-range revisions all 400.

---

## How this was tested, and what was not

Every finding was reproduced before being written down; none is inferred from reading
alone. The method was to read for a suspected weakness, write a probe that would fail if
the suspicion were wrong, then run it.

R1 was found by running four adversarial lifecycle sequences against the real `useInbox`
hook and counting concurrent requests, then confirming the user-visible consequence with a
stub that enforces the server's lease. R2 was found by asking what the newly required
`now` parameter does when it is legitimately `null`.

### Not tested

**Nothing visual.** No browser is available in this environment. Layout, dark mode, the
320-pixel width, focus movement, and whether the sender-junk confirmation dialog appears
at all remain unverified. That last one matters: Base UI overlays do not mount in the test
harness, so the dialog is exercised only through the hook behind it.

**No live Gmail.** No real account was connected. Everything ran against constructed
messages and a local database.

**No AI classification.** No model key is configured, so the deterministic keyword
classifier is what ran — which is also what runs for this user in practice.

A green test suite means the rules agree with each other. It is not evidence that the
classifier reads real mail correctly.
