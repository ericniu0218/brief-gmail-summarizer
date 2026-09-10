# API key setup

This app reads provider keys only on the server. The browser never receives them.

## Gemini

1. In [Google AI Studio](https://aistudio.google.com/apikey), create or select an API key.
2. For a local run, copy `.env.example` to `.env` and set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-3.5-flash-lite`.
3. For the hosted Site, open its private runtime environment settings, add `GEMINI_API_KEY` as a secret, set `GEMINI_MODEL`, then redeploy.

## Gmail OAuth

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as private runtime variables. Keep `TOKEN_ENCRYPTION_KEY` unchanged after the first deployment; changing it makes saved Gmail refresh tokens unreadable.

## Scheduled refresh

Generate one random `AGENT_CRON_SECRET` and save the same value in the Site runtime and the GitHub repository's Actions secrets. Save the private Site bypass token only in GitHub as `SITES_BYPASS_TOKEN`. The scheduled workflow uses both values to invoke `/api/agent`; neither belongs in source control.

## Safe key handling

Never put a key in source code, a committed `.env` file, a README, a browser bundle, or a chat message. `.env` is ignored locally; `.env.example` contains names only. To rotate a key, revoke the old key in its provider console, replace the hosted secret, and redeploy. If a key is pasted somewhere public, revoke it immediately and create a new one.

The app currently uses Gemini for summaries and reply suggestions. `GEMINI_MODEL` can be changed to another model that supports Gemini structured JSON output. A Google Cloud welcome credit does not cover Gemini API usage. If AI Studio reports a depleted prepay balance, add Gemini prepay credit or disable billing on that project to return it to the free tier.
