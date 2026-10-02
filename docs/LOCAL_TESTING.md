# Testing Brief with a real Gmail account

This runs the app on your own computer against your real Gmail. Nothing is deployed. Plan on 20–30 minutes the first time, most of it Google's setup screens. (`scripts/connect-gmail.sh` is a separate guided wizard for connecting the *hosted* site; this guide is for running locally.)

**Be careful on purpose.** The app reads your recent mail and, if you add a Gemini key, sends its text to Google's Gemini to classify and summarize it. For a first test, a spare or throwaway Gmail account is safest. Send test emails only to yourself.

## One-time setup

### 1. Get Google OAuth credentials (this is what lets the app log in to Gmail)

1. Open <https://console.cloud.google.com> and create a project (any name, e.g. "Brief test").
2. **APIs & Services → Library →** search **Gmail API → Enable**.
3. **OAuth consent screen** (Google now labels it **Google Auth Platform**):
   - User type **External**, fill in an app name and your email.
   - Keep the publishing status on **Testing**.
   - Under **Test users**, add every Gmail address you will connect. Without this Google blocks you.
   - Under **Data access / Scopes**, add the three Gmail scopes: `.../auth/gmail.readonly`, `.../auth/gmail.send`, `.../auth/gmail.compose`.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Under **Authorized redirect URIs** add exactly: `http://localhost:3000/api/auth/google/callback`
   - Copy the **Client ID** and **Client secret**.

### 2. Fill in `.env`

Copy `.env.example` to `.env` (it is git-ignored, so keys in it are not committed) and set:

```
APP_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<paste client id>
GOOGLE_CLIENT_SECRET=<paste client secret>
TOKEN_ENCRYPTION_KEY=<output of: openssl rand -base64 32>
AGENT_CRON_SECRET=<any long random string>
GEMINI_API_KEY=<optional, see below>
```

`GEMINI_API_KEY` (from <https://aistudio.google.com/apikey>) is only needed for classification, summaries, suggested replies, the digest's wording and AI-written emails. Sending, attachments, scheduling and drafts all work without it, and the digest falls back to each email's own subject and summary.

Never change `TOKEN_ENCRYPTION_KEY` after connecting: saved Gmail tokens become unreadable.

### 3. Create the local database tables

```bash
npm install
npm run db:local
```

Run `npm run db:local` again after pulling any change that adds a file to `drizzle/`. It is safe to repeat. If you ran the app from an older branch before, delete the stale local database first (`rm -rf .wrangler/state`), because migration names differ between branches.

### 4. Start it

```bash
npm run dev
```

Open <http://localhost:3000>. Use `localhost`, not `127.0.0.1`: the address must match the redirect URI exactly.

## Signing in

The app expects to run behind a platform that signs you in. Locally a stand-in does it: visit <http://localhost:3000/signin-with-chatgpt> (the **Sign in** button on the page does the same). You become a test user called "Seedy". This is separate from Google.

## Test checklist

Work down the list; each step relies on the one before. "To yourself" means your own address, so you can see exactly what arrives.

1. **Connect Gmail.** Settings & connections → **Connect Gmail**. Google warns the app is unverified (expected in Testing mode): **Advanced → Go to … (unsafe)**. Tick **every** permission box, then Continue. You land back in the app with your mail listed. If you have a second address, use **Add Gmail account** to connect it too; most checks below behave differently with two accounts.
2. **The digest.** On Overview, the top card should list up to five things that need you, each with a one-line reason. Tick one off with its circle and the next moves up; reload to confirm it stays ticked off, and use "Show … again" to restore it. Reply to one of them (step 6) and it should disappear at once.
3. **Send.** Compose → To yourself, a subject, a message → **Send email**. Click **Undo** during the 10-second countdown once and confirm nothing was sent. Send again, let it finish, click **Open in Gmail**, and confirm it is in Sent and in your inbox. With two accounts, check the **From** picker and that the email leaves from the one you chose.
4. **Save draft** → check Gmail's Drafts folder.
5. **Cc and Bcc.** Send to yourself with **Add Cc or Bcc**, putting a second address you own in Bcc. In Gmail open **Show original**: the Bcc address received it but is not in the headers.
6. **Reply and Reply all.** From a second address, email the first one and Cc a third. Refresh, open the message, switch to **Reply all** and confirm the right people are listed before sending.
7. **Attachments.** Attach a small PDF or image and send to yourself; open it from the received email. Then try an `.exe`: it should be refused with an explanation.
8. **Forward** any email to yourself; check the original text is quoted.
9. **Name and signature.** Settings → under **Sending**, set your name and a signature → **Save**. A new Compose should start with the signature.
10. **Schedule.** Compose to yourself → **Schedule** → pick the earliest time allowed. Nothing runs the background job by itself locally, so make it due and trigger it by hand:

    ```bash
    npx wrangler d1 execute DB --local --config scripts/wrangler.local.json \
      --persist-to .wrangler/state \
      --command "UPDATE scheduled_emails SET send_at = 1 WHERE status = 'scheduled'"
    curl -X POST -H "Authorization: Bearer $(grep '^AGENT_CRON_SECRET=' .env | cut -d= -f2-)" http://localhost:3000/api/agent
    ```

    `{"ok":true}` means it ran. The email should arrive, and the **Scheduled** button should disappear. Also try **Edit** and **Cancel** on a second scheduled email.
11. **Daily limit.** Add `SEND_DAILY_LIMIT=2` to `.env`, restart `npm run dev`, send three emails: the third should be refused with a clear message. Remove the line afterwards.
12. **AI (needs Gemini key).** Open an email → **Generate options**; in Compose use **Describe what you want to say**. Check drafts end with your saved name (or no name if none is saved) and are never sent automatically.
13. **Disconnect.** Settings → disconnect an account. Its scheduled emails are removed with it. Optionally also remove the app at <https://myaccount.google.com/permissions>.

## When something goes wrong

| What you see | Cause and fix |
| --- | --- |
| "Please sign in" notice | Visit `/signin-with-chatgpt` on localhost. |
| Error 500 / blank connection status | The local tables are missing or stale: run `npm run db:local` (after `rm -rf .wrangler/state` if you used an older branch). |
| Google: "Access blocked" / "app not verified" with no Advanced link | Add your address under **Test users** on the consent screen. |
| Google: `redirect_uri_mismatch` | The redirect URI in Google Cloud must be exactly `http://localhost:3000/api/auth/google/callback`. |
| "Please allow the requested Gmail permissions" | You unticked a box on Google's screen. Connect again and tick all. |
| "Your Gmail connection needs to be renewed" | Testing-mode tokens expire after 7 days. Use **Reconnect** in Settings. |
| "Please use this action from your dashboard" | The page is not on `http://localhost:3000` exactly (check `APP_URL` in `.env`). |
| "A previous request … is still unconfirmed" after sending | Gmail may or may not have received it. Check Sent, then use **I checked Gmail** to send again if it is not there. |
| AI buttons greyed out | `GEMINI_API_KEY` is empty or was changed without restarting `npm run dev`. |

Run the automated checks any time with `npm test` (no Gmail needed).
