# Brief

An Apple-inspired Gmail dashboard with a priority briefing, compact email rows, editable reply suggestions, sender-grouped newsletters, and a server-side inbox agent.

## What works now

The private Site includes an interactive sample workspace. Overview, All inboxes, Inbox, Work, Personal, and Noise views, summary collapse, conversation panels, reply tone and text editing, and sample unsubscribe actions work without external credentials. Demo actions are labelled and never change real Gmail.

Suggested replies are always model-generated, in the sample workspace as well as a connected mailbox, so they need `OPENAI_API_KEY`. Without it the Generate button is disabled and explains why, rather than showing canned text. Sample replies go to `/api/suggest`, which looks the message up by id in the demo corpus server-side and never generates from caller-supplied text; connected mailboxes go to `/api/reply`, which reads the real message from Gmail. Both pass the selected tone and a regeneration counter to the model, so Regenerate asks for a genuinely different draft instead of reformatting the same one.

The server implements per-user Gmail OAuth with PKCE and single-use state, encrypted offline refresh tokens, automatic access-token renewal, summaries through the OpenAI Responses API, Gmail drafts and send, duplicate-send protection, and RFC 8058 one-click unsubscribe for trusted provider endpoints. Email bodies are displayed as text and treated as untrusted input to AI. API routes require the platform-authenticated user and validate the origin of mutations.

## Activation status

The Site URL, a 256-bit encryption secret, the default model, and the existing OpenAI API key are configured in hosting. A Google OAuth client is still required. Google app credentials cannot be obtained from the Gmail connector in a Codex conversation. No real Gmail account has been connected or accessed by this implementation.

The Worker exports both `fetch` and `scheduled` handlers. The Cloudflare build configuration declares `*/30 * * * *`. A hosted schedule must actually be provisioned by the hosting provider before the agent runs with the browser closed. The Sites tools available during this build do not expose a cron provisioning operation, so background activation is unverified. The interface derives agent activity from a recorded server-side scheduler heartbeat, never from a timer or a configuration flag.

While a connected dashboard is open, it requests a Gmail refresh every 30 minutes, reads completed server snapshots every minute, and checks for updates on return to the tab. Browser refresh is not a substitute for the background schedule.

## One-time provider setup

1. Create or select a Google Cloud project and enable the Gmail API. Configure the OAuth consent screen and a Web application OAuth client. Add authorized test users if the app is in testing.
2. Register the exact redirect URI `https://gmail-hub-brief.lukeli1708.chatgpt.site/api/auth/google/callback`.
3. Add `GOOGLE_CLIENT_ID` and secret `GOOGLE_CLIENT_SECRET` to the Site runtime environment. Add secret `OPENAI_API_KEY` through the OpenAI Developers plugin or the Site's secret settings. Keep keys out of source control and browser code. Redeploy to apply hosted environment changes.
4. Have the hosting operator provision the Worker cron `*/30 * * * *` and verify a successful invocation. The dashboard then changes the scheduler indicator from pending to active after its heartbeat is visible.
5. Open Settings & connections and Continue with Google. Each user grants consent once; the app requests offline access and renews access tokens automatically. Google may require verification before an externally distributed app can use restricted Gmail scopes. Testing refresh tokens can expire after seven days.

Gmail scopes are `gmail.readonly`, `gmail.send`, and `gmail.compose`. No email is sent by the scheduled agent. The app sends only after the user clicks Send reply. Email content used for summaries and generated replies is sent to the configured OpenAI service; `store: false` is set on Responses requests.

## Development

Use Node 22.13+ and the committed npm lockfile.

```sh
npm install
npm run dev
npx tsc --noEmit
node scripts/test.mjs
npm run build
```

Copy `.env.example` to `.env` for local development and use `http://localhost:3000` as `APP_URL`, with a matching local Google redirect URI. The real hosted environment is separate. A new `TOKEN_ENCRYPTION_KEY` is a base64url-encoded random 32-byte value; preserve it across deployments or stored refresh tokens cannot be decrypted.

D1 schema is defined in `db/schema.ts`; generated migrations are in `drizzle/`. Production schema is applied by Sites during deployment. Local D1 needs those migrations applied before connection endpoints work. API routes also require authenticated platform headers; a plain unauthenticated curl correctly returns 401.

## Limits and behavior

- Each sync covers the latest 60 inbox messages and indicates when additional mail exists. AI analysis is reused for cached messages, reducing repeated processing. The agent processes up to 20 due accounts per invocation; larger deployments need a queue and pagination.
- A database lease prevents concurrent refreshes for each Gmail account. Failures retain the prior inbox snapshot and record an account-level error.
- Sending uses a deterministic user/account/message/action/body fingerprint; migrated accounts retain their existing receipt fingerprints. Completed retries return the stored receipt. An uncertain send stays pending and asks the user to check Gmail before retrying.
- Unsubscribing uses the message's original List-Unsubscribe headers and an HTTPS endpoint from a trusted provider domain. Redirects are not followed. Unsupported senders open their conversation in Gmail for manual review. Additional trusted endpoint domains can be configured with `UNSUBSCRIBE_ALLOWED_HOSTS`.
- Unsubscribing does not delete mail or apply Gmail spam labels. Successfully unsubscribed senders are hidden from the dashboard. Existing mail remains in Gmail.
- Disconnect revokes the selected Google account’s grant when possible and removes only that account’s connection, cached inbox, unsubscribe preferences, and operation data. Other accounts remain connected. If the default account is removed, another connected account becomes the default. If revocation fails, the UI asks the user to remove access in their Google account.
- Time saved is an explicitly approximate estimate based on message count, not measured activity.
- Browser WebMCP tools expose reading summaries and opening a conversation. Browser support is feature-detected. This session had no available browser or WebMCP test context, so these optional tools and visual interactions were not browser-verified.

## Validation

Production build and TypeScript checking pass. The original focused tests cover encryption ownership, CSRF rejection, trusted unsubscribe targets, newsletter classification, authenticated model-generated sample replies, duplicate-send prevention, sign-in recovery, and Google OAuth configuration with PKCE. The existing OpenAI key was accepted by the provider’s models endpoint. Live Gmail connection and scheduled delivery still need provider setup before end-to-end testing. An unauthenticated dashboard now offers a top-level ChatGPT sign-in action instead of leaving users at a connection error; Gmail-token failures remain separate and do not trigger that action.

## Provider references

- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail message sending](https://developers.google.com/workspace/gmail/api/guides/sending)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Cloudflare scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)

## Multiple Gmail accounts

The top-right Gmail selector offers each connected address, **All inboxes**, and account settings. **All inboxes** combines the synced mail, highlights, calendar, and counts from every connected account. Each message shows its source account, and replies, drafts, unsubscribe actions, and Gmail links use that account. The existing sync limit remains 60 recent inbox messages per account; this does not import the full Gmail archive.

Use **Settings & connections → Add another Gmail account** to connect an additional address through Google. Reconnecting the same address updates its token while retaining other accounts and cached mail. Set **Default Gmail account** in settings to choose which inbox opens on the next visit. Account switching itself is immediate and does not change the saved default.

Migration `drizzle/0001_multiple_gmail_accounts.sql` must be applied before running this version against an existing deployment. It preserves the original connection, encrypted token, cached mail, unsubscribe records, and send receipts, and makes that connection the initial default. It runs after `0000_warm_patch.sql` on new databases. Keep the existing `TOKEN_ENCRYPTION_KEY`. The Drizzle schema snapshot and migration journal include the change for the normal deployment flow.

`node scripts/test.mjs` covers account ownership, persistent defaults, combined sorting and duplicate message ids, adding/reconnecting accounts, individual disconnect, account-specific replies and unsubscribes, partial refresh failure, and migration of existing data using SQLite. Provider calls in these tests are mocked; live Google authorization still requires configured credentials and consent.

Recent reliability fixes keep Gmail sync working when AI summaries are unavailable, apply saved replies and unsubscribe preferences independently of refresh snapshots, and return confirmed-send receipts without requiring another Google request. Account settings return the updated account list directly, and inbox polling reconciles disconnected accounts before displaying cached mail. Regression tests cover these cases, malformed action requests, live reply identity, and explicit calendar dates.

Additional sync regression coverage verifies that temporary Google outages do not request reconnection, messages deleted during a refresh do not block remaining mail, and a reconnected account bypasses the recent-snapshot delay. The suite now contains 35 tests.
