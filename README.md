# Brief

An Apple-inspired Gmail dashboard with a priority briefing, compact email rows, editable reply suggestions, sender-grouped newsletters, and a server-side inbox agent.

## Shared team workspaces

Open `/team` (or **Team workspace** in the inbox) to create a workspace, invite colleagues, publish a compressed text corpus, read or export the same stored results, and create a fold with links to its source corpus. Owner/editor/viewer roles and expiring, revocable integration keys are enforced on the server. The versioned `/api/v1` interface accepts future namespaced result types.

A workspace also has **one reusable group code** so a whole team can join by typing `ABCD-2345` instead of needing an invitation each; it expires, is revocable and replaceable, grants only editor or viewer, and stops a user after ten wrong guesses. **Tasks** record who is doing what by when, grouped by person, deadline or status, with a version on every task so two people editing one of them cannot overwrite each other. **Chat** is the group's conversation, followed by cursor and polled, since this host offers no push channel. From a message in your inbox, **Add to team task** creates a task carrying the deadline Brief already found in it — read on the server from your private snapshot, so only the sender's name and the summary reach the workspace. Live work assigned to you appears above the daily brief.

Start with the [portable MVP handoff](docs/SHARED_WORKSPACES.md). It introduces the next model to the design, identifies the exact copy set and seams, and ends with checkable cross-user acceptance tests. Run `npm run workspace:mvp` to package the backend, migration, contract, tests, and example producer for a similar project.

The current Site’s hosting access is owner-only: grant a colleague Site viewer access before they redeem a workspace invitation. Creating an in-app invitation does not change hosting access. Text compression and folds are deterministic extracts/grouping and need no AI credentials. The Gmail share flow uses explicit selection and a content preview from the connected default account.

## What works now

The private Site includes an interactive sample workspace. Overview, Inbox, Work, and Noise views, summary collapse, conversation panels, reply tone and text editing, and sample unsubscribe actions work without external credentials. Demo actions are labelled and never change real Gmail.

Suggested replies are always model-generated, in the sample workspace as well as a connected mailbox, so they need `GEMINI_API_KEY`. Without it the Generate button is disabled and explains why, rather than showing canned text. Sample replies go to `/api/suggest`, which looks the message up by id in the demo corpus server-side and never generates from caller-supplied text; connected mailboxes go to `/api/reply`, which reads the real message from Gmail. Both pass the selected tone and a regeneration counter to the model, so Regenerate asks for a genuinely different draft instead of reformatting the same one.

The server implements per-user Gmail OAuth with PKCE and single-use state, encrypted offline refresh tokens, automatic access-token renewal, summaries through the Gemini API, Gmail drafts and send, duplicate-send protection, and RFC 8058 one-click unsubscribe for trusted provider endpoints. Email bodies are displayed as text and treated as untrusted input to AI. API routes require the platform-authenticated user and validate the origin of mutations.

**Drafts.** A Drafts tab under Inbox in the sidebar shows the Gmail Drafts folder, read live from Gmail for the current mailbox or every mailbox in the combined view (`server/drafts.ts`, `/api/drafts`), newest first. A draft started in Brief opens back in Compose: Save draft updates that same Gmail draft and Send removes it. A reply, or a draft carrying files, opens in Gmail instead, which keeps its conversation and attachments. Drafts can be deleted after a confirmation. Nothing is copied into Brief's database, so a draft finished or deleted on another device is gone here on the next look; the folder is read again whenever Compose closes.

**Done.** Every email list (Overview, Inbox, Work, Personal) has a round Done control on each row and folded group. The row slides out, an Undo bar names what moved, and the mail waits in a collapsed Done section below the list with Move back. Done only tidies the app: nothing changes in Gmail, a new message in the same conversation appears as usual, and marks are remembered in that browser per signed-in user (`hooks/use-done-mail.ts`). Done mail leaves the list and its counts.

**Section order.** Work, Personal and Overview pin only what needs the reader now (due within three days, recent direct requests, recently overdue work); everything else, older unresolved items included, follows newest first, so new mail is never buried under weeks-old tasks. The Needs a reply tab still ranks every importance tier.

**Inbox mirrors Gmail's homepage.** It lists only mail that is still in the Gmail inbox and on the Primary tab, newest first, one row per conversation (a sender kept separate never folds), with no importance ranking or topic grouping; Work, Personal and Noise do the sorting. Each refresh lists Gmail's newest 500 inbox ids (ids only) and records `inInbox` on stored mail, so mail archived in Gmail leaves the Inbox even when the two-day scan does not revisit it. A failed listing keeps the last known state, and a record stored before these facts were kept is shown rather than hidden.

Overview contains only important mail. Direct replies rank first, followed by security, account-access, deadline, and starred messages. Routine mail remains available in Inbox at the bottom.

**Gmail's own sorting.** Every message keeps Gmail's tab, Important marker and star (`gmailLabels`, `lib/gmail-signals.ts`). They are evidence, never decisions, and a correction made in the app always wins. Gemini receives all of them with guidance on what each means. Without Gemini, a Promotions or Social message with nothing real in it (no order, account event, registration or task of the user's) is filed as Noise, unless it came from the user's own organisation or a personal address or could not be read in full; a question in a Forums post is not the user's to answer unless it names them. In the ranking, a message starred in the last 30 days is Important, below anything actually due, and one Gmail marked Important in the last week ranks above routine mail in the Needs a reply tab without entering Overview. Neither signal reopens a message the user corrected or answered here. Related important setup and security notifications from the same company are folded into one marked group; expanding it shows every message's one-line summary and a direct reply action.

**Daily digest.** The card at the top of Overview lists up to five things most worth the user's attention. Only mail the importance policy calls important can appear, and among it the brief keeps what scores highest in `lib/digest-rank.ts`: people the reader has emailed before, then other people writing directly (not systems, role addresses, lists or Bcc blasts), any decision or result about the reader by its subject (tryouts, admissions, grades, offers) whoever sends it, work, and what is due soon, above routine codes, resets and email checks; Gmail's star, Important marker and Primary tab add a little, and mail older than two weeks loses ground. Below a minimum score an item is left out, so a quiet day shows fewer than five. Each entry has, each with a one-line "what to do", a chip for the kind of attention it needs (reply, decision, deadline, meeting, security, review), a due label such as "Due today" or "Today, 3:00 PM" when the mail has one, and a Done circle. Items are things, not emails: messages in one conversation count once, and several notifications from one company (for example three security alerts) fold into one item. It is shorter than five when fewer things qualify rather than padding itself. **The importance policy ranks and the AI only writes.** Which items appear, and in what order, comes from the same `evaluateImportance` policy as Overview and the counts (`lib/digest.ts`), recomputed in the browser from the live emails and the dashboard clock, so the digest can never disagree with the rest of the app, replying removes an item at once, and due labels follow the viewer's timezone. Gemini writes only each item's headline and one-line reason, from its subject, summary and the first 300 characters of the message, and only for items that are new or changed; an unchanged mailbox costs no extra AI calls (`server/digest.ts`, saved with the mailbox snapshot and delivered by `readMailbox`). Each entry is validated on its own, so one malformed AI entry costs only itself, and an email's text cannot add, remove or reorder anything. Without the AI the digest still works using each email's own subject and summary. Ticked-off items are remembered in that browser only (`localStorage`), per person and mailbox view, and a link restores them. The sample workspace shows the same digest with fixed hand-written wording (`lib/demo-digest.ts`).

**Compose.** The Compose button writes a brand-new email with To, optional Cc and Bcc, a subject, a message and up to five attachments, then sends it, saves a Gmail draft, or schedules it, through `/api/compose`. It leaves from one of the person's connected mailboxes: a **From** picker appears when several are connected, and the server verifies the mailbox is theirs. Recipients are suggested from people already in the inbox, and must be bare addresses (the app's own `mailboxAddress` check), at most 20 across To, Cc and Bcc, each appearing once. Nothing is sent until the person clicks Send, and every send waits ten seconds with an Undo; closing the window during the countdown cancels it. The AI never sends: **Describe what you want to say** asks Gemini for a subject and body to review and edit. **Forward** opens Compose with the original quoted, leaving from the mailbox the message arrived in. **Reply all** copies everyone else on the original message; the server works that list out from the Gmail headers, never from the browser, and leaves out the user's own mailbox and whoever the reply already goes to.

**Sending settings** (Settings & connections) belong to the person, so they apply to every connected mailbox. The **name** signs AI-written replies and drafts; left blank, AI-written text ends with a sign-off and no name, as before. The **signature** (up to 500 characters) is placed under every new email and forward as editable text, and AI drafting adds it itself and leaves the sign-off to it. Neither is ever taken from a mail header or an account name.

**Schedule.** A Schedule button queues the email (no attachments) for a chosen time, up to 30 days ahead and at most 20 at once. Queued emails live in `scheduled_emails`, per mailbox, and are sent by the background agent through the same send protocol as an email sent now, so a time is honoured to within the agent's 30-minute cadence, not to the minute. A **Scheduled** list beside Compose shows pending and failed emails with Edit and Cancel. A failure to renew Gmail access is retried on later runs; any failure after a send was attempted is shown as failed with a reminder to check the Sent folder and is never retried automatically. Cancelling or sending clears the saved content, and disconnecting a mailbox deletes its queue.

## Activation status

The Site URL, a 256-bit encryption secret, the default Gemini model, and a Gemini API key are configured in hosting. A Google OAuth client is still required. Google app credentials cannot be obtained from the Gmail connector in a Codex conversation. No real Gmail account has been connected or accessed by this implementation.

The Worker exports both `fetch` and `scheduled` handlers. The Cloudflare build configuration declares `*/30 * * * *`. Because Sites does not currently expose cron provisioning, the repository also contains a GitHub Actions schedule that calls the protected `/api/agent` endpoint every 30 minutes. The interface derives agent activity from a recorded server-side scheduler heartbeat.

While a connected dashboard is open, it requests a Gmail refresh every 30 minutes, reads completed server snapshots every minute, and checks for updates on return to the tab. Browser refresh is not a substitute for the background schedule.

## One-time provider setup

1. Create or select a Google Cloud project and enable the Gmail API. Configure the OAuth consent screen and a Web application OAuth client. Add authorized test users if the app is in testing.
2. Register the exact redirect URI `https://gmail-hub-brief.lukeli1708.chatgpt.site/api/auth/google/callback`.
3. Add `GOOGLE_CLIENT_ID`, secret `GOOGLE_CLIENT_SECRET`, `APP_URL` (the Site origin, no trailing path) and secret `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`, never rotated afterwards) to the Site runtime environment. The local `.env` file is not deployed. Settings & connections lists any of these four the running Site is missing. Create a key at [Google AI Studio](https://aistudio.google.com/apikey), add it as secret `GEMINI_API_KEY`, and set `GEMINI_MODEL=gemini-3.5-flash-lite`. Keep keys out of source control and browser code. Redeploy to apply hosted environment changes. Google Cloud welcome credits do not cover Gemini API usage; use an unbilled free-tier project or add Gemini prepay credit in AI Studio.
4. Generate one strong `AGENT_CRON_SECRET`, add it to the Site runtime and the GitHub repository's Actions secrets, and add the Site bypass token as `SITES_BYPASS_TOKEN` in GitHub. Run the **Refresh Gmail inboxes** workflow once and verify its heartbeat. Scheduled runs then invoke the agent every 30 minutes.
5. Open Settings & connections and Continue with Google. Each user grants consent once; the app requests offline access and renews access tokens automatically. Google may require verification before an externally distributed app can use restricted Gmail scopes. Testing refresh tokens can expire after seven days.

Gmail scopes are `gmail.readonly`, `gmail.send`, and `gmail.compose`. No email is sent by the scheduled agent. The app sends only after the user clicks Send reply. Email content used for summaries and generated replies is sent to the configured Gemini API.

## Development

Use Node 22.13+ and the committed npm lockfile.

```sh
npm install
npm run dev
npx tsc --noEmit
node scripts/test.mjs
npm run build
```

To try everything against a real Gmail account on your own computer, follow [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md). Run `npm run db:local` once to create the local database tables, and again after pulling a change that adds a file to `drizzle/`.

Copy `.env.example` to `.env` for local development and use `http://localhost:3000` as `APP_URL`, with a matching local Google redirect URI. The real hosted environment is separate. A new `TOKEN_ENCRYPTION_KEY` is a base64url-encoded random 32-byte value; preserve it across deployments or stored refresh tokens cannot be decrypted.

D1 schema is defined in `db/schema.ts`; generated migrations are in `drizzle/`. Production schema is applied by Sites during deployment. Local D1 needs those migrations applied before connection endpoints work. API routes also require authenticated platform headers; a plain unauthenticated curl correctly returns 401.

## Limits and behavior

- While a scan is part-way through the mailbox, each page first lists the newest 50 messages from the last two days and fetches any not yet stored, so new mail never waits for the scan to finish.
- Sync scans received Gmail messages in resumable 100-message pages, including archived mail while excluding Sent, Trash, and Spam. An explicit refresh advances up to three pages and scheduled runs continue the stored cursor. AI analysis is reused for unchanged messages. The agent processes up to 20 due accounts per invocation; larger deployments should move page jobs to a queue.
- A database lease prevents concurrent refreshes for a user. Gmail failures retain the prior inbox snapshot and record an account-level error. Gemini failures still store current mail with basic Gmail-derived classifications and retry AI analysis on the next refresh.
- Reconnecting the same Gmail address preserves the cached inbox, unsubscribe history, and send receipts. Changing addresses clears that user's previous mailbox data atomically. If a refresh is active, finish it and retry the connection; expired refreshes cannot overwrite a renewed connection or release a newer refresh's lease.
- Every send (replies, new emails, and scheduled emails) uses one protocol in `server/send.ts`: a fingerprint of the user, mailbox and content, so completed retries return the stored receipt and the same text sent from two mailboxes stays two emails. An uncertain send is recorded as unconfirmed and is repeated only after the person confirms they checked Gmail; a message Gmail clearly refuses releases its claim so it can be sent again once the cause is fixed.
- Each person can send at most 100 emails per rolling 24 hours (override with `SEND_DAILY_LIMIT`); drafts are not counted. It protects the Gmail account if a script or a mistake sends in bulk, and is a soft limit: two simultaneous sends can overshoot by one.
- Attachments are limited to five files and 10 MB in total, are sent in one multipart upload, and Gmail's own blocked file types are refused with an explanation. An email with attachments cannot be scheduled, and Forward quotes the original's text but not its attachments. Compose saves a new Gmail draft each time the text changes rather than updating the earlier one.
- The digest degrades with the rest of the app during an AI outage: a refresh that cannot reach Gemini keeps Gmail-only classifications, so the digest shrinks to what the importance policy can see on its own until the next successful refresh. Wording for an item that only just entered the top eight can lag by one refresh, and ticked-off items are not synced between browsers.
- Unsubscribing uses the message's original List-Unsubscribe headers and an HTTPS endpoint from a trusted provider domain. Redirects are not followed. Unsupported senders open their conversation in Gmail for manual review. Additional trusted endpoint domains can be configured with `UNSUBSCRIBE_ALLOWED_HOSTS`.
- Unsubscribing does not delete mail or apply Gmail spam labels. Successfully unsubscribed senders are hidden from the dashboard. Existing mail remains in Gmail.
- Disconnect revokes the Google grant when possible and removes the user's cached inbox, connection, OAuth state, and operation data. If revocation fails, the UI asks the user to remove access in their Google account.
- Team chat polls rather than streaming, because the host offers no push channel: roughly every four seconds while the tab is in front, every thirty when it is not, with the whole tail re-read about once a minute so a withdrawn message disappears for readers who already had it. Messages are plain text only; attachments would need R2, which is not enabled. Unread is a dot from a sequence kept in that browser, so it does not follow you between devices.
- Team tasks record a day-level deadline as the end of that day, UTC — the rule mail deadlines already use — so a task and a message due on one date fall due together. Buckets like "due today" are computed in the reader's own timezone, which can differ by a day from the stored instant for a team spread across timezones.
- Time saved is an explicitly approximate estimate based on message count, not measured activity.
- Browser WebMCP tools expose reading summaries and opening a conversation. Browser support is feature-detected. This session had no available browser or WebMCP test context, so these optional tools and visual interactions were not browser-verified.

## Validation

Production build, TypeScript checking, and affected-file linting pass. The focused tests include migration-backed Gmail OAuth, token renewal, mailbox loading, reconnect isolation, cleanup rollback, and expired-refresh races, plus fourteen shared-workspace tests covering cross-user reads, permissions, lineage, idempotency, integration keys, event cursors, migration behavior, and Gmail-preview isolation. Google responses are mocked in automated tests; a live Gmail connection still requires hosted runtime configuration, the registered callback URL, and a real user's Google consent before end-to-end verification. An unauthenticated dashboard offers a top-level ChatGPT sign-in action; Gmail-token failures remain separate and do not trigger that action.

The sending and digest features add tests for the shared send protocol (uncertain sends, refused messages, per-mailbox fingerprints, the daily limit), attachments, scheduled delivery and its failure handling, reply-all, the person's sending settings, the digest's ranking, wording, caching and combined-mailbox view, and the digest card itself in a real DOM.

## Provider references

- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail message sending](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API pricing / free tier](https://ai.google.dev/gemini-api/docs/pricing)
- [Cloudflare scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

### Identity ingress requirement

Sign-in trusts the `oai-authenticated-user-*` headers only because the host that serves the app strips any client-sent copies and injects the verified user. The OpenAI Sites dispatcher does this, and so does the local `/signin-with-chatgpt` stand-in, so on Sites and in local development no extra configuration is needed. Never expose the Worker origin directly; it must only be reachable through that host.

On any other host, set a server-only `IDENTITY_PROXY_SECRET` (at least 32 random characters) in the app and in the authenticated proxy. After verifying the user's session, the proxy must strip client-supplied `oai-authenticated-user-*` and `x-brief-identity-secret` headers, inject the verified identity, and attach `x-brief-identity-secret`. Once the secret is set, every request without the matching header is treated as signed out, and a secret shorter than 32 characters rejects everyone. Never place the secret in client code. A request origin check is not identity verification; a host without such a proxy should adapt this seam to verified server-side sessions or JWTs.
