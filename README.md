# Brief

An Apple-inspired Gmail dashboard with a priority briefing, compact email rows, editable reply suggestions, sender-grouped newsletters, and a server-side inbox agent.

## What works now

The private Site includes an interactive sample workspace. Overview, Inbox, Work, and Noise views, summary collapse, conversation panels, reply tone and text editing, and sample unsubscribe actions work without external credentials. Demo actions are labelled and never change real Gmail.

Suggested replies are always model-generated, in the sample workspace as well as a connected mailbox, so they need `GEMINI_API_KEY`. Without it the Generate button is disabled and explains why, rather than showing canned text. Sample replies go to `/api/suggest`, which looks the message up by id in the demo corpus server-side and never generates from caller-supplied text; connected mailboxes go to `/api/reply`, which reads the real message from Gmail. Both pass the selected tone and a regeneration counter to the model, so Regenerate asks for a genuinely different draft instead of reformatting the same one.

The server implements per-user Gmail OAuth with PKCE and single-use state, encrypted offline refresh tokens, automatic access-token renewal, summaries through the Gemini API, Gmail drafts and send, duplicate-send protection, and RFC 8058 one-click unsubscribe for trusted provider endpoints. Email bodies are displayed as text and treated as untrusted input to AI. API routes require the platform-authenticated user and validate the origin of mutations.

## Activation status

The Site URL, a 256-bit encryption secret, the default Gemini model, and a Gemini API key are configured in hosting. A Google OAuth client is still required. Google app credentials cannot be obtained from the Gmail connector in a Codex conversation. No real Gmail account has been connected or accessed by this implementation.

The Worker exports both `fetch` and `scheduled` handlers. The Cloudflare build configuration declares `*/30 * * * *`. Because Sites does not currently expose cron provisioning, the repository also contains a GitHub Actions schedule that calls the protected `/api/agent` endpoint every 30 minutes. The interface derives agent activity from a recorded server-side scheduler heartbeat.

While a connected dashboard is open, it requests a Gmail refresh every 30 minutes, reads completed server snapshots every minute, and checks for updates on return to the tab. Browser refresh is not a substitute for the background schedule.

## One-time provider setup

1. Create or select a Google Cloud project and enable the Gmail API. Configure the OAuth consent screen and a Web application OAuth client. Add authorized test users if the app is in testing.
2. Register the exact redirect URI `https://gmail-hub-brief.lukeli1708.chatgpt.site/api/auth/google/callback`.
3. Add `GOOGLE_CLIENT_ID` and secret `GOOGLE_CLIENT_SECRET` to the Site runtime environment. Create a key at [Google AI Studio](https://aistudio.google.com/apikey), add it as secret `GEMINI_API_KEY`, and set `GEMINI_MODEL=gemini-3.5-flash-lite`. Keep keys out of source control and browser code. Redeploy to apply hosted environment changes. Google Cloud welcome credits do not cover Gemini API usage; use an unbilled free-tier project or add Gemini prepay credit in AI Studio.
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

Copy `.env.example` to `.env` for local development and use `http://localhost:3000` as `APP_URL`, with a matching local Google redirect URI. The real hosted environment is separate. A new `TOKEN_ENCRYPTION_KEY` is a base64url-encoded random 32-byte value; preserve it across deployments or stored refresh tokens cannot be decrypted.

D1 schema is defined in `db/schema.ts`; generated migrations are in `drizzle/`. Production schema is applied by Sites during deployment. Local D1 needs those migrations applied before connection endpoints work. API routes also require authenticated platform headers; a plain unauthenticated curl correctly returns 401.

## Limits and behavior

- Each sync covers the latest 60 inbox messages and indicates when additional mail exists. AI analysis is reused for cached messages, reducing repeated processing. The agent processes up to 20 due accounts per invocation; larger deployments need a queue and pagination.
- A database lease prevents concurrent refreshes for a user. Gmail failures retain the prior inbox snapshot and record an account-level error. Gemini failures still store current mail with basic Gmail-derived classifications and retry AI analysis on the next refresh.
- Sending uses a deterministic user/message/action/body fingerprint. Completed retries return the stored receipt. An uncertain send stays pending and asks the user to check Gmail before retrying.
- Unsubscribing uses the message's original List-Unsubscribe headers and an HTTPS endpoint from a trusted provider domain. Redirects are not followed. Unsupported senders open their conversation in Gmail for manual review. Additional trusted endpoint domains can be configured with `UNSUBSCRIBE_ALLOWED_HOSTS`.
- Unsubscribing does not delete mail or apply Gmail spam labels. Successfully unsubscribed senders are hidden from the dashboard. Existing mail remains in Gmail.
- Disconnect revokes the Google grant when possible and removes the user's cached inbox, connection, OAuth state, and operation data. If revocation fails, the UI asks the user to remove access in their Google account.
- Time saved is an explicitly approximate estimate based on message count, not measured activity.
- Browser WebMCP tools expose reading summaries and opening a conversation. Browser support is feature-detected. This session had no available browser or WebMCP test context, so these optional tools and visual interactions were not browser-verified.

## Validation

Production build, TypeScript checking, and affected-file linting pass. Twenty focused tests cover encryption ownership, CSRF rejection, the protected scheduler, trusted unsubscribe targets, fallback classification, Gemini billing, schema and sync failures, authenticated model-generated sample replies, duplicate-send prevention, sign-in recovery, and Google OAuth configuration with PKCE. Live Gmail connection still needs Google OAuth credentials before end-to-end testing. An unauthenticated dashboard offers a top-level ChatGPT sign-in action; Gmail-token failures remain separate and do not trigger that action.

## Provider references

- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail message sending](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API pricing / free tier](https://ai.google.dev/gemini-api/docs/pricing)
- [Cloudflare scheduled handlers](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
