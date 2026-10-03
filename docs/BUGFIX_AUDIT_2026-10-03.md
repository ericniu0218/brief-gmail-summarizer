# Bug fixes and stress-test report — October 3, 2026

The 20 supplied audit findings have targeted code fixes. Stress testing found additional issues, also fixed below. Existing uncommitted features were preserved; this work did not replace the app architecture, add dependencies, change the database schema, modify applied migrations, or publish a live version.

**Deployment note:** finding 7 is enforced whenever `IDENTITY_PROXY_SECRET` is configured: every request must then carry the matching `x-brief-identity-secret`, and a short secret rejects everyone. With no secret configured, the Sites dispatcher's identity headers are trusted as before. A first version of this fix rejected sign-in whenever the secret was missing, which would have locked everyone out of the Sites deployment and local development, because neither sends the extra header; it was corrected in the follow-up pass below. See [README identity ingress requirement](../README.md#identity-ingress-requirement).

## Supplied findings

| # | Finding | Targeted fix | Verification |
| --- | --- | --- | --- |
| 1 | D1 bind limit breaks busy inbox refreshes | Retry exclusions use one JSON parameter with `json_each`. The real-schema test database now enforces D1's 100-parameter ceiling. | A 100-message incremental refresh passes under that ceiling; existing backfill/retry tests pass. |
| 2 | Encoded meta refresh bypasses image privacy | Strip every sender-controlled meta, link and base tag. Retain the application's CSP and inert base. Also harden malformed comments and nested openers. | Parse attack documents with images allowed and blocked; 468 adversarial HTML combinations contain no sender-controlled navigation or DNS tags. |
| 3 | Five search lint errors | Use semantic `search` and `output` elements, load history on opening, use the supplied clock, and put keyboard handlers on interactive controls. | Repository lint passes; search interaction tests pass. |
| 4 | Sidebar count reads every draft body | Count-only requests use a Gmail list response; full draft reads occur when the Drafts tab is opened. | Fifty listed drafts produce one list request and zero full-body reads for the count. |
| 5 | Unbounded unfamiliar-sender checks | Limit live checks to ten senders per refresh. Persist deferred work and rotate it ahead of new senders on later refreshes; cache remains scoped to the owner and mailbox. | Sixty senders drain across six refreshes, including when no recent mail is listed. At most ten new checks occur per refresh; a separate hundred-sender worst-case test makes exactly forty Gmail requests instead of four hundred. |
| 6 | Old AI answers survive prompt changes forever | Refresh at most eight stale AI results per run, by stored analysis version. Failed attempts retain the earlier answer and respect retry backoff. | A changed model refreshes eight of sixty stored results; unchanged current results are reused; failure preserves prior facts. |
| 7 | Bare headers can impersonate a user | When `IDENTITY_PROXY_SECRET` is configured, require and compare it before accepting forwarded identity; document stripping client copies and restricting the app origin. Without it, the Sites dispatcher's headers are trusted as before. | With a secret: valid accepted; missing, forged and short rejected. Without one: Sites headers accepted. |
| 8 | Done, brief and counts disagree | Dashboard lists, sidebar counts, Important stats and brief ticks share one message-keyed Done set. Brief ticks cover every grouped member; Undo uses the same set. Existing brief ticks migrate once. | List Done removes the brief item; a brief tick updates list state; legacy migration and Undo pass. |
| 9 | Older attachments are absent from search | Raise `CONTENT_VERSION` to 10 so an existing account's next full reconciliation refreshes attachment metadata. | Existing version-triggered full-scan tests pass; attachment filters and content version regression pass. An account at version 9 performs a full listing, stores an older attachment and full-recipient flag, and reaches version 10. Older metadata is repaired progressively as that scan completes. |
| 10 | Human addresses and ordinary subjects are misranked | Match role words as complete address parts. Calendar response prefixes and search-result subjects receive no outcome boost. | All six reported human-name examples retain person credit; real role addresses remain automated; tryout results still earn the outcome score. |
| 11 | Older archived mail remains in Inbox | Continue the complete Inbox listing using a small snapshot cursor and per-row generation markers. Clear unseen old rows only after the final page; preserve seen markers across message refetches. | A 1,200-message Inbox takes three pages, preserves earlier pages, and clears an old archived row only at completion. |
| 12 | DNS-prefetch leaks an open | Strip all sender link tags, including DNS-prefetch and preconnect. | Included in the HTML privacy cases and adversarial stress run. |
| 13 | Background-finishing notice sticks | A terminal follow-up replaces the notice both when Gmail remains deferred and when another request holds the refresh lock. | Real hook interaction test covers both branches without waiting four seconds. |
| 14 | Done disappears during unmount/animation | Invoke Done immediately; save browser marks synchronously during the action, before a React commit or unmount can interrupt persistence. | Done persistence and list interaction suites pass; the old cancelable delay is removed. |
| 15 | Switching From duplicates an edited draft | Saved drafts stay with their original account. Disable the From selector and guard its handler while a draft ID exists. | Source guard checked; draft update-in-place and existing compose/send tests pass. |
| 16 | Draft recipients split at quoted commas | Reuse `parseParties`; handle comments and escaped quotes in the shared parser. | Quoted comma, encoded display name, and a comma inside a trailing comment preserve all recipients. |
| 17 | The fifty-first recipient loses person credit | Compute `readerWasRecipient` using the complete To/Cc lists before display truncation; use it in blast detection. Version 10 refreshes old rows. | A fifty-first reader remains a visible recipient for ranking although only fifty display addresses are stored. |
| 18 | Search repeatedly normalizes bodies and misplaces Unicode excerpts | Cache indexes per message in a WeakMap, invalidate when source fields change, and map lowercased positions into normalized visible text. Explain unencrypted browser history in settings. | Unicode ligature/dotted-I cases, deep excerpts, edited message invalidation, normalization-call counts, and the large search stress run pass. |
| 19 | Social-tab recruiter mail becomes Noise without AI | Restrict the unconditional bulk-tab fallback to Promotions. Content-based promotion checks remain in place. | A direct recruiter message in Social stays useful without AI; Gmail signals and classification suites also pass. |
| 20 | The brief initially displays obsolete ordering | Rank provisional candidates using clock-free sender, Work, star and other score evidence before applying the candidate limit. | A starred person and a work correspondent outrank a routine system message before the clock arrives; digest rendering tests pass. |

## Additional issues found and fixed

| Finding | Impact | Fix and evidence |
| --- | --- | --- |
| Malformed HTML comments, declarations and attribute quotes hid live tags from the sanitizer | Same navigation/privacy escape as finding 2, through a different parser mismatch | Parse comment/declaration endings separately and escape nested openers in retained tags. Regression cases include encoded refreshes after comment endings, malformed attributes and stray angle brackets. The adversarial run covered 468 combinations. |
| Draft requests and deletes could finish after switching accounts or disconnecting | A stale request could restore another account's drafts, or a late delete could decrement the new account's count | Invalidate request generations on cleanup; scope rendered state and delete completion. Delayed response and delayed deletion tests pass. |
| Done writes occurred inside a React state updater and used stale browser marks | Persistence depended on a later commit; another tab's marks could be overwritten | Write synchronously, merge the current browser value, scope state to the user, and handle storage-cleared events. Done tests and shared-brief tests pass. |
| Gmail draft bodies stored behind attachment IDs were not hydrated; rich-only or oversized drafts could be overwritten from partial text | Editing could discard body content | Hydrate deferred bodies before editing. Route incomplete, HTML-only and oversized drafts to Gmail. Full deferred-body and unsafe-edit tests pass. |
| Individual full-draft read failures were silently omitted | An incomplete Drafts list could look complete | Preserve successful drafts while reporting unreadable drafts for their account; a draft deleted in Gmail remains an ordinary disappearance. A failed body read test retains the other draft and reports the unreadable one. |
| Chunked multipart uploads and correction bodies were sized only after buffering | A missing or false Content-Length could cause excessive buffering | Reuse the bounded stream reader before multipart or correction parsing. Oversized streams return 413, are cancelled at the byte ceiling, and make no Gmail request. |
| Successful AI re-sorting could retain the prior failed attempt's pending flag | A recovered message could keep appearing as awaiting AI processing | A successful result clears the pending flag even when an older result was reusable. The recovery regression checks both the message flag and aggregate pending count. |

## Follow-up pass

A second review of the fixes above found one new bug, now fixed.

| Finding | Impact | Fix and evidence |
| --- | --- | --- |
| The first fix for finding 7 rejected sign-in whenever `IDENTITY_PROXY_SECRET` was unset | Neither the Sites dispatcher nor the local `/signin-with-chatgpt` stand-in sends `x-brief-identity-secret`, so every request was treated as signed out: the local app could not sign in, and a deploy would have locked everyone out of the live site | The secret is enforced only when configured; without it the host's identity headers are trusted as before. The regression test now covers both modes, and the local app signs in again. |

The same pass re-ran the 26 HTML navigation and tracking attacks against the email cleanup (none survived; `srcset` and `poster` remain blocked by the frame's image policy), and exercised Drafts, refresh, the Inbox mirror and the dashboard against the real local mailbox without errors.

## Verification results

- Full automated suite: **663 tests passed, zero failed, cancelled or skipped** on the final tested source.
- `npm run lint`: passed. The pre-existing anonymous-default-export warning in `worker.ts` remains; there are no lint errors.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed for the Cloudflare/vinext production target.
- `git diff --check`: passed.
- Tests use the committed migrations in an isolated in-memory database; no live mailbox, live database, or provider credentials were used by these tests.

The new regression suite is [tests/audit-regressions.test.ts](../tests/audit-regressions.test.ts). Existing tests also cover account ownership, OAuth state/PKCE, token encryption, origin checks, reply and send idempotency, uncertain sends, scheduled delivery, manual corrections, refresh leases, backfill cursors, unsubscribe boundaries, folding, time-based importance and shared-workspace authorization/idempotency.

### Synthetic stress run

Deterministic seed: `73491`. The standalone stress script and raw measurements are saved under ignored `work/` as `audit-stress.ts` and `audit-stress-results.json`.

| Measure | Result |
| --- | --- |
| Emails searched | 3,000 |
| Source body bytes | 19,855,499 |
| Search comparisons and excerpt checks | 260, all passed |
| First search, including building the index | 209 ms |
| Cached search median | 8 ms |
| Cached search 95th percentile | 17 ms |
| Malformed HTML combinations parsed | 468, all passed |
| HTML stress duration | 1,687 ms |

Search results were compared against an independent simple reference filter. Timing is a local measurement, not a performance guarantee for other devices. The large Inbox and busy-refresh cases run through the real sync code with simulated Gmail and a D1-constrained test adapter.

## Practical limits and operational notes

This is evidence of the tested behavior, not proof that every possible bug has been eliminated. HTML tests use jsdom parsing and inspection of sandbox/CSP output; they do not measure real browser network traffic. Overlay limitations in the existing DOM harness mean some Compose and account-picker behavior is verified through source inspection, static rendering and backend tests rather than a real-browser end-to-end run.

Live Gmail quotas, production D1 latency and deployment authentication were not exercised. The quota cap and page sizes are bounded by design, but a slow provider can still defer a refresh. Inbox archive reconciliation and the version-10 metadata repair complete over successive refreshes rather than immediately for every old message. Draft counts use Gmail's `resultSizeEstimate` when available; they are estimates, and the Drafts view intentionally loads the newest fifty per mailbox. Sender familiarity establishes prior sent mail, not friendship. Done, preferences and search history remain specific to this browser.

Hosting anywhere other than Sites requires the identity ingress configuration described above.
