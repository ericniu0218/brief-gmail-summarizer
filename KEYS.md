# API key setup

This app reads provider keys only on the server. The browser never receives them.

## Gemini

1. In [Google AI Studio](https://aistudio.google.com/apikey), create or select an API key.
2. For a local run, copy `.env.example` to `.env` and set `GEMINI_API_KEY` and `GEMINI_MODEL=gemini-2.5-flash`.
3. For the hosted Site, open its private runtime environment settings, add `GEMINI_API_KEY` as a secret, set `GEMINI_MODEL`, then redeploy.

## Gmail OAuth

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as private runtime variables. Keep `TOKEN_ENCRYPTION_KEY` unchanged after the first deployment; changing it makes saved Gmail refresh tokens unreadable.

## Safe key handling

Never put a key in source code, a committed `.env` file, a README, a browser bundle, or a chat message. `.env` is ignored locally; `.env.example` contains names only. To rotate a key, revoke the old key in its provider console, replace the hosted secret, and redeploy. If a key is pasted somewhere public, revoke it immediately and create a new one.

The app currently uses Gemini for summaries and reply suggestions. `GEMINI_MODEL` can be changed to another model that supports Gemini structured JSON output.
