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
    if (url.includes('/users/me/messages?maxResults=100&q='))
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
async function seed(
  user = 'user-a',
  email = 'me@example.com',
  lease = 0,
  account = user,
) {
  const token = await encrypt('old-refresh', user, env);
  storage.sql
    .prepare(
      'INSERT INTO connections (id,user_id,provider_identity,email,token,token_version,last_sync,sync_lock,error,created) VALUES (?,?,NULL,?,?,1,123,?,NULL,123)',
    )
    .run(account, user, email, token, lease);
  storage.sql
    .prepare(
      'INSERT INTO account_preferences (user_id,default_account_id) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET default_account_id=excluded.default_account_id',
    )
    .run(user, account);
  storage.sql
    .prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,123)')
    .run(
      account,
      user,
      JSON.stringify({ emails: [{ id: 'cached' }], ai: false, updated: 123 }),
    );
  storage.sql
    .prepare(
      'INSERT INTO unsubscribed (id,user_id,account_id,address,created) VALUES (?,?,?,?,123)',
    )
    .run(account + ':newsletter', user, account, 'newsletter@example.com');
  storage.sql
    .prepare(
      "INSERT INTO operations (id,user_id,account_id,status,result) VALUES (?,?,?,'complete','receipt')",
    )
    .run(account + ':sent', user, account);
  return token;
}
/**
 * The mailbox route reads its target account from the query string. With no account it
 * returns the combined view, which is what these tests want: a connection created through
 * the OAuth callback gets a generated account id that the test cannot predict.
 */
function mailboxRequest(accountId?: string) {
  const url = new URL(`${env.APP_URL}/api/mailbox`);
  if (accountId) url.searchParams.set('accountId', accountId);
  return new Request(url);
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
  // Credentials written by the callback are bound to owner *and* account (version 2),
  // so decrypting requires both. Another user cannot read them, and neither can the same
  // user against a different account id.
  assert.equal(
    await decrypt(String(stored.token), 'user-a', env, String(stored.id)),
    'new-refresh',
  );
  await assert.rejects(decrypt(String(stored.token), 'user-b', env, String(stored.id)));
  await assert.rejects(decrypt(String(stored.token), 'user-a', env, 'other-account'));
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
    accounts: { id: string; email: string }[];
    defaultAccountId: string | null;
  };
  assert.equal(status.connected, true);
  // The status response lists every mailbox the user owns rather than a single address.
  assert.deepEqual(
    status.accounts.map((a) => a.email),
    ['me@example.com'],
  );
  assert.equal(status.defaultAccountId, status.accounts[0].id);
  // The account id was generated by the callback, so the refresh must use the id the
  // connection actually has rather than assuming it matches the owner.
  const accountId = status.accounts[0].id;
  const snapshot = await syncInbox('user-a', accountId, env);
  assert.equal(snapshot.emails[0].id, 'message');
  assert.ok(requests.some(request=>request.url.includes('-in%3Adrafts')),'sync must not classify unsent drafts');
  assert.deepEqual(
    (await (await mailbox(mailboxRequest(accountId))).json() as {emails:unknown[]}).emails.length,
    snapshot.emails.length,
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

void test('one malformed Gmail message is skipped without losing the valid batch', async () => {
  await seed();
  const provider = globalThis.fetch;
  const ids = ['good-1', 'good-2', 'bad', 'good-3', 'good-4', 'good-5'];
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/users/me/messages?maxResults=100&q='))
      return Response.json({ messages: ids.map((id) => ({ id })) });
    const match = /\/users\/me\/messages\/([^?]+)\?format=full$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      return Response.json({
        id,
        threadId: 'thread-' + id,
        snippet: 'Hello',
        internalDate: '1788960000000',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Sender <sender@example.com>' },
            { name: 'Subject', value: id },
          ],
          body: { data: id === 'bad' ? '%%%invalid-base64%%%' : encode('Hello') },
        },
      });
    }
    return provider(input, init);
  };
  const snapshot = await syncInbox('user-a', 'user-a', env);
  assert.deepEqual(snapshot.emails.map((email) => email.id), ids.filter((id) => id !== 'bad'));
  assert.equal(snapshot.skipped, 1);
  const stored = JSON.parse(String(row('snapshots')!.data)) as InboxSnapshot;
  assert.equal(stored.emails.length, 5);
  assert.equal(stored.skipped, 1);
  assert.equal(storage.sql.prepare('SELECT COUNT(*) count FROM mailbox_messages WHERE account_id=?').get('user-a')!.count,5,'messages are stored as independent rows');
});

void test('a mailbox refresh preserves the durable replied state',async()=>{
  await seed();
  storage.sql.prepare('INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,?,?,1)')
    .run('user-a','user-a','message',JSON.stringify({id:'message',address:'sender@example.com',subject:'Hello',needsReply:false}),123,'old');
  await syncInbox('user-a','user-a',env);
  const saved=storage.sql.prepare('SELECT data,replied FROM mailbox_messages WHERE account_id=? AND message_id=?').get('user-a','message') as {data:string;replied:number};
  assert.equal(saved.replied,1);
  assert.equal((JSON.parse(saved.data) as {needsReply:boolean}).needsReply,false);
});

void test('mailbox scans resume through Gmail pages and retain earlier pages',async()=>{
  await seed();
  storage.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(JSON.stringify({emails:[{id:'cached',address:'cached@example.com',subject:'Cached'}],ai:false,updated:123}),'user-a');
  const provider=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=requestUrl(input);
    if(url.includes('/users/me/messages?maxResults=100&q=')){
      return url.includes('pageToken=page-2')
        ?Response.json({messages:[{id:'older'}]})
        :Response.json({messages:[{id:'newer'}],nextPageToken:'page-2'});
    }
    const match=/\/users\/me\/messages\/([^?]+)\?format=full$/.exec(url);
    if(match){
      const id=decodeURIComponent(match[1]);
      return Response.json({id,threadId:'thread-'+id,snippet:'Hello',internalDate:id==='newer'?'1788960000000':'1788950000000',labelIds:['INBOX'],
        payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:id}],body:{data:encode('Hello')}}});
    }
    return provider(input,init);
  };
  const first=await syncInbox('user-a','user-a',env);
  assert.equal(first.hasMore,true);
  // Mid-scan the previously cached message is deliberately retained. Only part of the
  // mailbox has been re-read, so dropping it here would blank most of the inbox until
  // the scan finished. It is kept until the scan reaches its last page.
  assert.deepEqual(new Set(first.emails.map(email=>email.id)),new Set(['newer','cached']));
  assert.equal(row('connections')!.sync_page_token,'page-2');
  const second=await syncInbox('user-a','user-a',env);
  assert.equal(second.hasMore,false);
  // The final page completes the generation, so anything not seen during this scan —
  // here the stale cached message — is dropped. That is how deleted mail disappears.
  assert.deepEqual(new Set(second.emails.map(email=>email.id)),new Set(['newer','older']));
  assert.ok(!second.emails.some(email=>email.id==='cached'),'a completed scan removes mail it never saw');
  assert.equal(row('connections')!.sync_page_token,null);
  assert.equal(row('connections')!.content_version,1,'the rich-body backfill is complete only after the last page');
});

void test('a corrupt override row falls back to empty tags without aborting sync', async () => {
  await seed();
  storage.sql.prepare(
    'INSERT INTO overrides (user_id,account_id,message_id,category,add_tags,remove_tags,not_junk,obligation_state,source,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run('user-a','user-a','message','invalid-section','{bad json','null',0,'invalid-state','message',Date.now());
  const snapshot=await syncInbox('user-a','user-a',env);
  assert.equal(snapshot.emails.length,1);
  assert.equal(snapshot.emails[0].id,'message');
  assert.equal(snapshot.skipped,0);
});

void test('a downstream classify/build failure skips only that message', async () => {
  await seed();
  const provider=globalThis.fetch;
  const ids=['good-a','bad-labels','good-b','good-c','good-d','good-e'];
  globalThis.fetch=async(input,init)=>{
    const url=requestUrl(input);
    if(url.includes('/users/me/messages?maxResults=100&q='))
      return Response.json({messages:ids.map(id=>({id}))});
    const match=/\/users\/me\/messages\/([^?]+)\?format=full$/.exec(url);
    if(match){
      const id=decodeURIComponent(match[1]);
      return Response.json({
        id,threadId:'thread-'+id,snippet:'Hello',internalDate:'1788960000000',
        labelIds:id==='bad-labels'?1:['INBOX'],
        payload:{mimeType:'text/plain',headers:[
          {name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:id},
        ],body:{data:encode('Hello')}},
      });
    }
    return provider(input,init);
  };
  const snapshot=await syncInbox('user-a','user-a',env);
  assert.deepEqual(snapshot.emails.map(email=>email.id),ids.filter(id=>id!=='bad-labels'));
  assert.equal(snapshot.skipped,1);
});

void test('returning from Google automatically loads summaries of the connected Gmail messages', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  connected(await callback());
  const provider = globalThis.fetch;
  let summarized = false;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url === '/api/mailbox') return mailbox(mailboxRequest());
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
        text: string;
      }[];
      // The classifier receives normalized messages: current text, quotes separated.
      assert.deepEqual(
        messages.map(({ id, subject, text }) => ({ id, subject, text })),
        [{ id: 'message', subject: 'Hello', text: 'Hello' }],
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
                        context: 'personal',
                        topics: [],
                        disposition: 'useful',
                        replyRequired: false,
                        securityEvent: false,
                        summary:
                          'Your sender is checking in with a greeting.',
                        reason: 'A short personal greeting with no request.',
                        obligations: [],
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
  // The refresh response carries the same mail as the stored view, plus counters saying
  // how many accounts refreshed. Compare the mail itself rather than the envelope.
  const stored = (await (await mailbox(mailboxRequest())).json()) as typeof result;
  assert.deepEqual(stored.emails, result.emails);
  assert.deepEqual(stored.accounts, result.accounts);
  assert.equal(stored.ai, result.ai);
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

void test('connecting another mailbox adds an account and leaves existing data intact', async () => {
  await seed();
  await seed('user-b', 'other@example.com', 0, 'user-b');
  const other = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table, 'user-b'),
  );
  const before = storage.sql
    .prepare('SELECT * FROM snapshots WHERE account_id=?')
    .get('user-a');
  // Connecting a second Gmail address is an addition, not a replacement: the first
  // mailbox keeps its account row, its cached mail and its saved decisions.
  profileEmail = 'different@example.com';
  connected(await callback());
  const accounts = storage.sql
    .prepare('SELECT * FROM connections WHERE user_id=? ORDER BY email')
    .all('user-a') as { id: string; email: string }[];
  assert.deepEqual(
    accounts.map((a) => a.email),
    ['different@example.com', 'me@example.com'],
    'both mailboxes are connected to the same user',
  );
  assert.deepEqual(
    storage.sql.prepare('SELECT * FROM snapshots WHERE account_id=?').get('user-a'),
    before,
    'the original mailbox keeps its cached mail',
  );
  for (const table of ['unsubscribed', 'operations'])
    assert.ok(
      storage.sql
        .prepare(`SELECT * FROM ${table} WHERE account_id=?`)
        .get('user-a'),
      `${table} for the original mailbox is preserved`,
    );
  // The first mailbox stays the default; a newly added account does not take it.
  assert.equal(
    (storage.sql
      .prepare('SELECT default_account_id FROM account_preferences WHERE user_id=?')
      .get('user-a') as { default_account_id: string }).default_account_id,
    'user-a',
  );
  // Another user's records are untouched throughout.
  assert.deepEqual(
    ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
      row(table, 'user-b'),
    ),
    other,
  );
});


void test('reconnecting a mailbox is refused while that mailbox is being refreshed', async () => {
  await seed('user-a', 'me@example.com', Date.now() + 600000);
  const before = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table),
  );
  // Reconnecting the *same* mailbox must wait for its in-flight refresh to finish,
  // otherwise the credential would change underneath a sync that still holds the lease.
  assert.match(connectionError(await callback()), /refresh|try again/i);
  assert.deepEqual(
    ['connections', 'snapshots', 'unsubscribed', 'operations'].map((table) =>
      row(table),
    ),
    before,
  );
});


void test('a failed connection write leaves the mailbox unchanged', async () => {
  await seed();
  const before = ['connections', 'snapshots', 'unsubscribed', 'operations'].map(
    (table) => row(table),
  );
  storage.sql.exec(
    "CREATE TRIGGER reject_connection BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
  );
  // Reconnecting the same mailbox upserts its existing row, so a rejected write must
  // leave the connection and every record that depends on it exactly as it was.
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
  const pending = syncInbox('user-a', 'user-a', env);
  const rejected = assert.rejects(
    pending,
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  await entered.promise;
  try {
    await assert.rejects(
      syncInbox('user-a', 'user-a', env),
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
    const pending = syncInbox('user-a', 'user-a', env);
    const rejected = assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof HttpError && error.status === (fail ? 502 : 409),
    );
    await entered.promise;
    try {
      now += 600001;
      // Reconnecting the *same* mailbox is what invalidates the in-flight refresh: the
      // stored credential is rewritten, so the lease this sync is holding goes stale.
      // Connecting a different address is deliberately not used here — that adds a
      // second account rather than replacing this one, so it cannot express this case.
      connected(await callback());
      await syncInbox('user-a', 'user-a', env);
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

// ── Section 3: OAuth account matching ───────────────────────────────────────

/** Starts OAuth with an explicit intent and completes the callback. */
async function callbackWith(params: Record<string, string> = {}) {
  const url = new URL(`${env.APP_URL}/api/auth/google`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const start = await startGoogle(new Request(url));
  if (start.status !== 302) return start;
  const state = new URL(start.headers.get('location')!).searchParams.get(
    'state',
  )!;
  return googleCallback(
    new Request(
      `${env.APP_URL}/api/auth/google/callback?state=${state}&code=code`,
    ),
  );
}
const accountsOf = (user = 'user-a') =>
  storage.sql
    .prepare('SELECT * FROM connections WHERE user_id=? ORDER BY email')
    .all(user) as { id: string; email: string; token: string }[];

void test('adding the same mailbox twice renews it instead of duplicating it', async () => {
  await seed();
  const before = accountsOf();
  connected(await callbackWith());
  const after = accountsOf();
  assert.equal(after.length, 1, 'the mailbox is not duplicated');
  assert.equal(after[0].id, before[0].id, 'it keeps its original account id');
  assert.notEqual(after[0].token, before[0].token, 'its credential is renewed');
});

void test('a targeted reconnect renews the account it was aimed at', async () => {
  await seed();
  const [target] = accountsOf();
  connected(
    await callbackWith({ action: 'reconnect', accountId: target.id }),
  );
  const after = accountsOf();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, target.id);
  assert.notEqual(after[0].token, target.token);
});

void test('a targeted reconnect with a different Google account is refused', async () => {
  await seed();
  const [target] = accountsOf();
  // The user picked the wrong Google account on the consent screen.
  profileEmail = 'someone-else@example.com';
  const error = connectionError(
    await callbackWith({ action: 'reconnect', accountId: target.id }),
  );
  assert.match(error, /does not match|add/i);
  const after = accountsOf();
  assert.equal(after.length, 1, 'no second account was created');
  assert.equal(after[0].email, 'me@example.com', 'the target is untouched');
  assert.equal(after[0].token, target.token, 'its credential is unchanged');
});

void test('a reconnect cannot target another user’s account', async () => {
  await seed();
  await seed('user-b', 'other@example.com', 0, 'user-b');
  const before = storage.sql
    .prepare('SELECT * FROM connections WHERE user_id=?')
    .get('user-b');
  // user-a is signed in and aims the flow at user-b's mailbox.
  const response = await callbackWith({
    action: 'reconnect',
    accountId: 'user-b',
  });
  assert.notEqual(response.status, 302, 'the flow never reaches Google');
  assert.deepEqual(
    storage.sql.prepare('SELECT * FROM connections WHERE user_id=?').get('user-b'),
    before,
  );
});

void test('a new mailbox without offline access is not stored as connected', async () => {
  await seed();
  const before = accountsOf();
  const provider = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input) === 'https://oauth2.googleapis.com/token') {
      const body = init?.body as URLSearchParams;
      // Google omits the refresh token on repeat consent.
      if (body.get('grant_type') !== 'refresh_token')
        return Response.json({ access_token: 'access', scope: scopes });
    }
    return provider(input, init);
  };
  try {
    profileEmail = 'brand-new@example.com';
    assert.match(connectionError(await callbackWith()), /offline|reconnect/i);
    assert.deepEqual(accountsOf(), before, 'nothing new was stored');
  } finally {
    globalThis.fetch = provider;
  }
});

// ── Section 4: single-account disconnect ────────────────────────────────────

import { POST as disconnectAccount } from '../app/api/disconnect/route';

const disconnectRequest = (body: unknown) =>
  new Request(`${env.APP_URL}/api/disconnect`, {
    method: 'POST',
    headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const rowsFor = (account: string) =>
  ['snapshots', 'unsubscribed', 'operations', 'overrides'].map((table) =>
    storage.sql.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(account),
  );

void test('disconnecting one mailbox leaves the other usable', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  const keep = rowsFor('acct-2');
  const response = await disconnectAccount(
    disconnectRequest({ accountId: 'acct-1' }),
  );
  assert.equal(response.status, 200);
  const remaining = accountsOf();
  assert.deepEqual(
    remaining.map((a) => a.email),
    ['second@example.com'],
    'only the named mailbox is removed',
  );
  assert.deepEqual(rowsFor('acct-2'), keep, 'the other mailbox keeps its data');
  for (const rows of rowsFor('acct-1'))
    assert.equal(rows.length, 0, 'the removed mailbox leaves nothing behind');
});

void test('disconnecting the default mailbox promotes another one', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  storage.sql
    .prepare('UPDATE account_preferences SET default_account_id=? WHERE user_id=?')
    .run('acct-1', 'user-a');
  await disconnectAccount(disconnectRequest({ accountId: 'acct-1' }));
  const preference = storage.sql
    .prepare('SELECT default_account_id FROM account_preferences WHERE user_id=?')
    .get('user-a') as { default_account_id: string } | undefined;
  assert.equal(preference?.default_account_id, 'acct-2');
});

void test('disconnecting cannot remove another user’s mailbox', async () => {
  await seed('user-a', 'mine@example.com', 0, 'acct-1');
  await seed('user-b', 'theirs@example.com', 0, 'acct-b');
  const before = storage.sql
    .prepare('SELECT * FROM connections WHERE id=?')
    .get('acct-b');
  const response = await disconnectAccount(
    disconnectRequest({ accountId: 'acct-b' }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(
    storage.sql.prepare('SELECT * FROM connections WHERE id=?').get('acct-b'),
    before,
  );
});

void test('disconnecting the last mailbox clears the default', async () => {
  await seed('user-a', 'only@example.com', 0, 'acct-1');
  await disconnectAccount(disconnectRequest({ accountId: 'acct-1' }));
  assert.equal(accountsOf().length, 0);
  assert.equal(
    storage.sql
      .prepare('SELECT * FROM account_preferences WHERE user_id=?')
      .get('user-a'),
    undefined,
  );
});

// ── Section 5: the combined "All inboxes" view ──────────────────────────────

/** Replaces an account's stored mail so a test can describe the exact combined input. */
function seedMail(
  account: string,
  mail: { id: string; address: string; receivedAt: number; subject: string }[],
  user = 'user-a',
) {
  storage.sql
    .prepare('UPDATE snapshots SET data=? WHERE account_id=? AND user_id=?')
    .run(
      JSON.stringify({ emails: mail, ai: false, updated: 123 }),
      account,
      user,
    );
}

void test('the combined view merges both mailboxes and keeps each message attributed', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  // The same Gmail id exists in both mailboxes: ids are unique per mailbox, not globally.
  seedMail('acct-1', [
    { id: 'shared', address: 'billing@vendor.example', receivedAt: 300, subject: 'First copy' },
    { id: 'only-1', address: 'a@vendor.example', receivedAt: 100, subject: 'Older first-account mail' },
  ]);
  seedMail('acct-2', [
    { id: 'shared', address: 'billing@vendor.example', receivedAt: 200, subject: 'Second copy' },
  ]);

  const response = await mailbox(mailboxRequest());
  assert.equal(response.status, 200);
  const view = (await response.json()) as InboxSnapshot;

  // Every message survives: a shared Gmail id must not collapse two mailboxes into one.
  assert.equal(view.emails.length, 3, 'no message is dropped by a colliding Gmail id');
  assert.deepEqual(
    view.emails.map((email) => `${email.accountId}:${email.id}`),
    ['acct-1:shared', 'acct-2:shared', 'acct-1:only-1'],
    'newest first, with the composite identity breaking ties',
  );
  // Attribution is what lets every later action reach the right Gmail account.
  const shared = view.emails.filter((email) => email.id === 'shared');
  assert.deepEqual(
    shared.map((email) => email.accountEmail).sort((a, b) => String(a).localeCompare(String(b))),
    ['first@example.com', 'second@example.com'],
    'each copy names the mailbox that received it',
  );
  assert.deepEqual(
    (view.accounts || []).map((account) => account.email).sort((a, b) => a.localeCompare(b)),
    ['first@example.com', 'second@example.com'],
    'both mailboxes are reported individually',
  );
});

void test('a failing mailbox is identified without hiding the healthy one', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  seedMail('acct-1', [
    { id: 'kept', address: 'a@vendor.example', receivedAt: 100, subject: 'Still readable' },
  ]);
  seedMail('acct-2', [
    { id: 'saved', address: 'b@vendor.example', receivedAt: 50, subject: 'Saved before the failure' },
  ]);
  storage.sql
    .prepare('UPDATE connections SET error=? WHERE id=?')
    .run('Reconnect Gmail', 'acct-2');

  const view = (await (await mailbox(mailboxRequest())).json()) as InboxSnapshot;
  // A refresh failure must not discard mail that was already saved for that account.
  assert.deepEqual(
    view.emails.map((email) => email.id),
    ['kept', 'saved'],
    'the failing account keeps contributing its saved mail',
  );
  const failing = (view.accounts || []).find((account) => account.id === 'acct-2');
  assert.equal(failing?.error, 'Reconnect Gmail', 'the affected account is named');
  const healthy = (view.accounts || []).find((account) => account.id === 'acct-1');
  assert.equal(healthy?.error, null, 'the healthy account is not blamed for it');
});

void test('disconnecting a mailbox removes its messages from the combined view', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  seedMail('acct-1', [
    { id: 'stays', address: 'a@vendor.example', receivedAt: 100, subject: 'Kept mail' },
  ]);
  seedMail('acct-2', [
    { id: 'goes', address: 'b@vendor.example', receivedAt: 200, subject: 'Removed mail' },
  ]);
  const before = (await (await mailbox(mailboxRequest())).json()) as InboxSnapshot;
  assert.deepEqual(before.emails.map((email) => email.id), ['goes', 'stays']);

  const provider = globalThis.fetch;
  globalThis.fetch = async () => Response.json({});
  try {
    assert.equal(
      (await disconnectAccount(disconnectRequest({ accountId: 'acct-2' }))).status,
      200,
    );
  } finally {
    globalThis.fetch = provider;
  }

  const after = (await (await mailbox(mailboxRequest())).json()) as InboxSnapshot;
  assert.deepEqual(
    after.emails.map((email) => email.id),
    ['stays'],
    'the disconnected mailbox no longer contributes mail',
  );
  assert.deepEqual(
    (after.accounts || []).map((account) => account.id),
    ['acct-1'],
    'and is no longer listed as part of the combined view',
  );
});
