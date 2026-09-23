import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { GET as startGoogle } from '../app/api/auth/google/route';
import { GET as googleCallback } from '../app/api/auth/google/callback/route';
import { GET as connectionStatus } from '../app/api/connection/route';
import { GET as mailbox } from '../app/api/mailbox/route';
import { POST as syncMailbox } from '../app/api/sync/route';
import { loadConnectedInbox, type InboxSnapshot } from '../lib/inbox-client';
import { syncInbox } from '../server/sync';
import {
  decrypt,
  encode,
  encrypt,
  HttpError,
  type Runtime,
} from '../server/runtime';

let storage: ReturnType<typeof database>;
let env: Runtime;
let profileEmail: string;
const originalFetch = globalThis.fetch;
const scopes = ['gmail.readonly', 'gmail.send', 'gmail.compose']
  .map((s) => 'https://www.googleapis.com/auth/' + s)
  .join(' ');
let requests: { url: string; init?: RequestInit }[];

beforeEach(() => {
  storage = database();
  env = {
    DB: storage.db,
    APP_URL: 'https://brief.example',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: encode(crypto.getRandomValues(new Uint8Array(32))),
  };
  globalThis.__briefTestEnv = env;
  globalThis.__briefTestHeaders = new Headers({
    'oai-authenticated-user-id': 'user-a',
    'oai-authenticated-user-email': 'a@example.com',
  });
  profileEmail = 'Me@Example.com';
  requests = [];
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = init?.body as URLSearchParams;
      return body.get('grant_type') === 'refresh_token'
        ? Response.json({ access_token: body.get('refresh_token') })
        : Response.json({
            access_token: 'access',
            refresh_token: 'new-refresh',
            scope: scopes,
          });
    }
    if (url.endsWith('/users/me/profile'))
      return Response.json({ emailAddress: profileEmail });
    if (url.endsWith('/users/me/messages?labelIds=INBOX&maxResults=60'))
      return Response.json({ messages: [{ id: 'message' }] });
    if (url.endsWith('/users/me/messages/message?format=full'))
      return Response.json({
        id: 'message',
        threadId: 'thread',
        snippet: 'Hello',
        internalDate: '1788960000000',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Sender <sender@example.com>' },
            { name: 'Subject', value: 'Hello' },
          ],
          body: { data: encode('Hello') },
        },
      });
    throw new Error(`Unexpected provider request: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.__briefTestHeaders = new Headers();
  storage.sql.close();
});

async function callback() {
  const start = await startGoogle();
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')!).searchParams.get(
    'state',
  )!;
  return googleCallback(
    new Request(
      `${env.APP_URL}/api/auth/google/callback?state=${state}&code=code`,
    ),
  );
}
function connected(response: Response) {
  assert.equal(response.status, 302);
  assert.equal(
    new URL(response.headers.get('location')!).searchParams.get('connected'),
    '1',
  );
}
function connectionError(response: Response) {
  assert.equal(response.status, 302);
  const error = new URL(response.headers.get('location')!).searchParams.get(
    'connection_error',
  );
  assert.ok(error, 'Expected an actionable connection error');
  return error;
}
async function seed(user = 'user-a', email = 'me@example.com', lease = 0) {
  const token = await encrypt('old-refresh', user, env);
  storage.sql
    .prepare(
      'INSERT INTO connections (user_id,email,token,last_sync,sync_lock,error) VALUES (?,?,?,123,?,NULL)',
    )
    .run(user, email, token, lease);
  storage.sql
    .prepare('INSERT INTO snapshots (user_id,data,updated) VALUES (?,?,123)')
    .run(
      user,
      JSON.stringify({ emails: [{ id: 'cached' }], ai: false, updated: 123 }),
    );
  storage.sql
    .prepare(
      'INSERT INTO unsubscribed (id,user_id,address,created) VALUES (?,?,?,123)',
    )
    .run(user + ':newsletter', user, 'newsletter@example.com');
  storage.sql
    .prepare(
      "INSERT INTO operations (id,user_id,status,result) VALUES (?,?,'complete','receipt')",
    )
    .run(user + ':sent', user);
  return token;
}
function row(table: string, user = 'user-a') {
  return storage.sql
    .prepare(`SELECT * FROM ${table} WHERE user_id=?`)
    .get(user);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

void test('OAuth persists a real-schema connection, consumes PKCE state and loads the mailbox with the stored refresh token', async () => {
  const start = await startGoogle();
  const destination = new URL(start.headers.get('location')!);
  const state = destination.searchParams.get('state')!;
  const saved = storage.sql
    .prepare('SELECT * FROM oauth_states WHERE state=?')
    .get(state)!;
  const request = new Request(
    `${env.APP_URL}/api/auth/google/callback?state=${state}&code=code`,
  );
  connected(await googleCallback(request));
  const stored = row('connections')!;
  assert.equal(stored.email, 'me@example.com');
  assert.equal(
    await decrypt(String(stored.token), 'user-a', env),
    'new-refresh',
  );
  await assert.rejects(decrypt(String(stored.token), 'user-b', env));
  assert.equal(
    storage.sql.prepare('SELECT * FROM oauth_states WHERE state=?').get(state),
    undefined,
  );
  const exchange = requests[0].init?.body as URLSearchParams;
  assert.equal(exchange.get('code_verifier'), saved.verifier);
  assert.equal(
    exchange.get('redirect_uri'),
    destination.searchParams.get('redirect_uri'),
  );
  assert.equal(exchange.get('client_id'), 'client-id');
  assert.equal(exchange.get('client_secret'), 'client-secret');
  const count = requests.length;
  assert.match(connectionError(await googleCallback(request)), /expired/i);
  assert.equal(requests.length, count, 'A replay must not contact Google');
  const status = (await (await connectionStatus()).json()) as {
    connected: boolean;
    email: string;
  };
  assert.equal(status.connected, true);
  assert.equal(status.email, 'me@example.com');
  const snapshot = await syncInbox('user-a', env);
  assert.equal(snapshot.emails[0].id, 'message');
  assert.deepEqual(
    await (await mailbox()).json(),
    JSON.parse(JSON.stringify(snapshot)),
  );
  assert.equal(
    (
      requests.find(
        (r) =>
          (r.init?.body as URLSearchParams)?.get?.('grant_type') ===
          'refresh_token',
      )!.init!.body as URLSearchParams
    ).get('refresh_token'),
    'new-refresh',
  );
});

void test('returning from Google automatically loads summaries of the connected Gmail messages', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  connected(await callback());
  const provider = globalThis.fetch;
  let summarized = false;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === '/api/mailbox') return mailbox();
    if (url === '/api/sync')
      return syncMailbox(
        new Request(`${env.APP_URL}/api/sync`, {
          method: 'POST',
          headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = init?.body;
      assert.ok(typeof body === 'string');
      const request = JSON.parse(body) as {
        contents: { parts: { text: string }[] }[];
      };
      const messages = JSON.parse(request.contents[0].parts[0].text) as {
        id: string;
        subject: string;
        body: string;
      }[];
      assert.deepEqual(
        messages.map(({ id, subject, body }) => ({ id, subject, body })),
        [{ id: 'message', subject: 'Hello', body: 'Hello' }],
      );
      summarized = true;
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    items: [
                      {
                        id: 'message',
                        summary: 'Your sender is checking in with a greeting.',
                        category: 'personal',
                        priority: 'normal',
                        needsReply: false,
                        label: 'Personal',
                      },
                    ],
                  }),
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      });
    }
    return provider(input, init);
  };
  const displayed: InboxSnapshot[] = [];
  const result = await loadConnectedInbox((snapshot) =>
    displayed.push(snapshot),
  );
  assert.equal(summarized, true);
  assert.equal(displayed[0].emails.length, 0);
  assert.equal(result.ai, true);
  assert.equal(
    result.emails[0].summary,
    'Your sender is checking in with a greeting.',
  );
  assert.deepEqual(displayed.at(-1), result);
  assert.deepEqual(await (await mailbox()).json(), result);
});

void test('the Connect Gmail browser flow signs in first and resumes Google consent', async () => {
  globalThis.__briefTestHeaders=new Headers();
  const response=await startGoogle(new Request(`${env.APP_URL}/api/auth/google`,{headers:{accept:'text/html'}}));
  assert.equal(response.status,302);
  const destination=new URL(response.headers.get('location')!);
  assert.equal(destination.pathname,'/signin-with-chatgpt');
  assert.equal(destination.searchParams.get('return_to'),'/api/auth/google');
  assert.equal(requests.length,0);
});

void test('missing Gmail setup returns browser visitors to the dashboard with an actionable error', async () => {
  env.TOKEN_ENCRYPTION_KEY=undefined;
  const response=await startGoogle(new Request(`${env.APP_URL}/api/auth/google`,{headers:{accept:'text/html'}}));
  const error=connectionError(response);
  assert.match(error,/configured/i);
  assert.match(error,/TOKEN_ENCRYPTION_KEY/);
  assert.equal(requests.length,0);
});

void test('connection status names missing or invalid settings without revealing their values', async () => {
  type Status = { configured: boolean; missingSettings: string[]; callbackUrl: string | null };
  const read = async () => {
    const response = await connectionStatus();
    const text = await response.text();
    assert.doesNotMatch(text, /client-secret|client-id/);
    return JSON.parse(text) as Status;
  };
  const ready = await read();
  assert.equal(ready.configured, true);
  assert.deepEqual(ready.missingSettings, []);
  assert.equal(ready.callbackUrl, 'https://brief.example/api/auth/google/callback');
  env.TOKEN_ENCRYPTION_KEY = undefined;
  env.GOOGLE_CLIENT_SECRET = '  ';
  const missing = await read();
  assert.equal(missing.configured, false);
  assert.deepEqual(missing.missingSettings, ['GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']);
  env.GOOGLE_CLIENT_SECRET = 'client-secret';
  // AES-GCM needs a 16, 24 or 32 byte key; anything else fails only at encryption time.
  env.TOKEN_ENCRYPTION_KEY = encode(crypto.getRandomValues(new Uint8Array(20)));
  assert.deepEqual((await read()).missingSettings, ['TOKEN_ENCRYPTION_KEY']);
  env.TOKEN_ENCRYPTION_KEY = 'not base64!';
  assert.deepEqual((await read()).missingSettings, ['TOKEN_ENCRYPTION_KEY']);
  env.TOKEN_ENCRYPTION_KEY = encode(crypto.getRandomValues(new Uint8Array(32)));
  env.APP_URL = 'brief.example';
  const badUrl = await read();
  assert.deepEqual(badUrl.missingSettings, ['APP_URL']);
  assert.equal(badUrl.callbackUrl, null);
});

void test('a trailing slash in APP_URL does not change the registered Google redirect URI', async () => {
  env.APP_URL = 'https://brief.example/';
  const start = await startGoogle();
  const destination = new URL(start.headers.get('location')!);
  assert.equal(
    destination.searchParams.get('redirect_uri'),
    'https://brief.example/api/auth/google/callback',
  );
  const response = await googleCallback(
    new Request(
      `https://brief.example/api/auth/google/callback?state=${destination.searchParams.get('state')}&code=code`,
    ),
  );
  assert.equal(
    response.headers.get('location'),
    'https://brief.example/?connected=1',
  );
  const exchange = requests[0].init?.body as URLSearchParams;
  assert.equal(
    exchange.get('redirect_uri'),
    'https://brief.example/api/auth/google/callback',
  );
});

for (const [googleError, expected] of [
  ['invalid_client', /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET/],
  ['redirect_uri_mismatch', /https:\/\/brief\.example\/api\/auth\/google\/callback/],
  ['invalid_grant', /expired|try again/i],
] as const) {
  void test(`a Google ${googleError} token response explains how to fix it`, async () => {
    const provider = globalThis.fetch;
    globalThis.fetch = async (input, init) =>
      requestUrl(input) === 'https://oauth2.googleapis.com/token'
        ? Response.json({ error: googleError }, { status: 400 })
        : provider(input, init);
    assert.match(connectionError(await callback()), expected);
    assert.equal(row('connections'), undefined);
  });
}

void test('renewing the same mailbox preserves unsubscribe history, snapshot and send receipts', async () => {
  const oldToken = await seed();
  const before = ['snapshots', 'unsubscribed', 'operations'].map((table) =>
    row(table),
  );
  connected(await callback());
  assert.deepEqual(
    ['snapshots', 'unsubscribed', 'operations'].map((table) => row(table)),
    before,
  );
  assert.notEqual(row('connections')!.token, oldToken);
  assert.equal(row('connections')!.last_sync, null);
});

void test('changing mailboxes clears only the owner’s previous mailbox state', async () => {
  await seed();
  await seed('user-b', 'other@example.com');
  const other = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table, 'user-b'),
  );
  profileEmail = 'different@example.com';
  connected(await callback());
  assert.equal(row('connections')!.email, profileEmail);
  for (const table of ['snapshots', 'unsubscribed', 'operations'])
    assert.equal(row(table), undefined);
  assert.deepEqual(
    ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
      row(table, 'user-b'),
    ),
    other,
  );
});

void test('reconnect cannot replace a connection or clear its data while a sync lease is active', async () => {
  await seed('user-a', 'me@example.com', Date.now() + 600000);
  const before = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table),
  );
  profileEmail = 'different@example.com';
  assert.match(connectionError(await callback()), /refresh|try again/i);
  assert.deepEqual(
    ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
      row(table),
    ),
    before,
  );
});

void test('a failed connection write rolls back mailbox cleanup', async () => {
  await seed();
  const before = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table),
  );
  storage.sql.exec(
    "CREATE TRIGGER reject_connection BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
  );
  profileEmail = 'different@example.com';
  connectionError(await callback());
  assert.deepEqual(
    ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
      row(table),
    ),
    before,
  );
});

void test('an expired refresh cannot release a newer refresh lease for the same connection', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await seed();
  const provider = globalThis.fetch;
  const entered = deferred();
  const resume = deferred();
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input).includes('/messages?')) {
      entered.resolve();
      await resume.promise;
    }
    return provider(input, init);
  };
  const pending = syncInbox('user-a', env);
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  await entered.promise;
  try {
    await assert.rejects(
      syncInbox('user-a', env),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    now += 600001;
    // Simulate another worker claiming the expired lease without changing credentials.
    storage.sql
      .prepare('UPDATE connections SET sync_lock=? WHERE user_id=?')
      .run(now + 600000, 'user-a');
    const before = ['connections', 'snapshots'].map((table) => row(table));
    resume.resolve();
    await rejected;
    assert.deepEqual(
      ['connections', 'snapshots'].map((table) => row(table)),
      before,
    );
  } finally {
    resume.resolve();
    await rejected;
  }
});

for (const fail of [false, true]) {
  void test(`an expired sync cannot ${fail ? 'clear a newer lease on failure' : 'overwrite a new mailbox on completion'}`, async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    await seed();
    const provider = globalThis.fetch;
    const entered = deferred();
    const resume = deferred();
    globalThis.fetch = async (input, init) => {
      if (
        requestUrl(input).includes('/messages?') &&
        new Headers(init?.headers).get('Authorization') === 'Bearer old-refresh'
      ) {
        entered.resolve();
        await resume.promise;
        if (fail) throw new HttpError(502, 'Old mailbox request failed');
      }
      return provider(input, init);
    };
    const pending = syncInbox('user-a', env);
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof HttpError && error.status === (fail ? 502 : 409),
    );
    await entered.promise;
    try {
      now += 600001;
      profileEmail = 'different@example.com';
      connected(await callback());
      await syncInbox('user-a', env);
      if (fail)
        storage.sql
          .prepare('UPDATE connections SET sync_lock=? WHERE user_id=?')
          .run(now + 600000, 'user-a');
      const before = ['connections', 'snapshots'].map((table) => row(table));
      resume.resolve();
      await rejected;
      assert.deepEqual(
        ['connections', 'snapshots'].map((table) => row(table)),
        before,
      );
    } finally {
      resume.resolve();
      await rejected;
    }
  });
}

for (const stateCase of ['missing', 'expired', 'foreign']) {
  void test(`OAuth rejects ${stateCase} state before contacting Google`, async () => {
    if (stateCase !== 'missing')
      storage.sql
        .prepare(
          'INSERT INTO oauth_states (state,user_id,verifier,expires) VALUES (?,?,?,?)',
        )
        .run(
          'state',
          stateCase === 'foreign' ? 'user-b' : 'user-a',
          'verifier',
          stateCase === 'expired' ? 0 : Date.now() + 600000,
        );
    connectionError(
      await googleCallback(
        new Request(
          `${env.APP_URL}/api/auth/google/callback?state=state&code=code`,
        ),
      ),
    );
    assert.equal(requests.length, 0);
    assert.equal(row('connections'), undefined);
  });
}

for (const failure of [
  'denied',
  'token',
  'refresh-token',
  'scope',
  'profile',
]) {
  void test(`OAuth ${failure} failure leaves the existing mailbox intact`, async () => {
    await seed();
    const before = [
      'connections',
      'snapshots',
      'unsubscribed',
      'operations',
    ].map((table) => row(table));
    const provider = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (requestUrl(input).endsWith('/token')) {
        if (failure === 'token')
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        if (failure === 'refresh-token')
          return Response.json({ access_token: 'access', scope: scopes });
        if (failure === 'scope')
          return Response.json({
            access_token: 'access',
            refresh_token: 'refresh',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          });
      }
      if (failure === 'profile' && requestUrl(input).endsWith('/profile'))
        return Response.json({}, { status: 403 });
      return provider(input, init);
    };
    connectionError(
      failure === 'denied'
        ? await googleCallback(
            new Request(
              `${env.APP_URL}/api/auth/google/callback?error=access_denied`,
            ),
          )
        : await callback(),
    );
    assert.deepEqual(
      ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
        row(table),
      ),
      before,
    );
  });
}
