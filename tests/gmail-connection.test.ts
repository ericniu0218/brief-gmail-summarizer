import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from './database';
import { GET as startGoogle } from '../app/api/auth/google/route';
import { GET as googleCallback } from '../app/api/auth/google/callback/route';
import { GET as connectionStatus } from '../app/api/connection/route';
import { GET as mailbox } from '../app/api/mailbox/route';
import { POST as syncMailbox } from '../app/api/sync/route';
import { loadConnectedInbox, type InboxSnapshot } from '../lib/inbox-client';
import { analysisVersion } from '../server/ai';
import { CONTENT_VERSION, syncInbox } from '../server/sync';
import { loadMessages, markMessageReplied, snapshotSentIds } from '../server/messages';
import { POST as unsubscribeRoute } from '../app/api/unsubscribe/route';
import { POST as replyRoute } from '../app/api/reply/route';
import { POST as classificationRoute } from '../app/api/classification/route';
import { POST as disconnectRoute } from '../app/api/disconnect/route';
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
/** Lets a test make the Gmail list report a continuation page. */
let paging: 'done' | 'more';
/** Lets a test choose what the newsletter service answers, and when. */
let provider: { status: number; delay?: { promise: Promise<void>; resolve: () => void }; started?: { promise: Promise<void>; resolve: () => void } };
/** The messages Gmail reports, and the headers each carries. */
let inbox: { id: string; from?: string; headers?: [string, string][]; body?:string; threadId?:string; receivedAt?:number }[];
let sentThreads:Record<string,{labelIds:string[];internalDate:string}[]>;

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
    'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id': 'user-a',
    'oai-authenticated-user-email': 'a@example.com',
  });
  profileEmail = 'Me@Example.com';
  requests = [];
  paging = 'done';
  provider = { status: 200 };
  inbox = [{ id: 'message' }];
  sentThreads={};
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
    if (url.includes('/users/me/messages?labelIds=SENT'))return Response.json({messages:[]});
    if (url.includes('/users/me/messages?maxResults=100&q='))
      return Response.json(
        paging === 'more'
          ? { messages: inbox.map((m) => ({ id: m.id })), nextPageToken: 'next-page' }
          : { messages: inbox.map((m) => ({ id: m.id })) },
      );
    const thread=/\/users\/me\/threads\/([^?]+)\?format=metadata/.exec(url)?.[1];
    if(thread)return Response.json({id:thread,messages:sentThreads[decodeURIComponent(thread)]||[]});
    const wanted = /\/users\/me\/messages\/([^?]+)\?format=full/.exec(url)?.[1];
    if (wanted) {
      const described = inbox.find((m) => m.id === wanted);
      if (!described) return new Response('not found', { status: 404 });
      // A signed one-click newsletter unless the test says otherwise.
      const headers = described.headers ?? [
        ['List-Id', 'Daily <daily.news.example.com>'],
        ['List-Unsubscribe', '<https://news.list-manage.com/u?id=1>'],
        ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
        ['Authentication-Results', 'mx.google.com; dkim=pass header.d=list-manage.com'],
        ['DKIM-Signature', 'v=1; d=list-manage.com; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=x'],
      ];
      return Response.json({
        id: described.id,
        threadId: described.threadId||'thread-' + described.id,
        snippet: described.body||'Hello',
        internalDate: String(described.receivedAt||1788960000000),
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: described.from ?? 'Sender <sender@example.com>' },
            { name: 'Subject', value: 'Hello' },
            ...headers.map(([name, value]) => ({ name, value })),
          ],
          body: { data: encode(described.body||'Hello') },
        },
      });
    }
    if (url.startsWith('https://news.list-manage.com/')) {
      provider.started?.resolve();
      if (provider.delay) await provider.delay.promise;
      return new Response(null, { status: provider.status });
    }
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
  assert.equal(row('connections')!.content_version,CONTENT_VERSION,'the backfill is complete only after the last page');
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

/** One unsubscribe request for the message the Gmail stub describes. */
function unsubscribeRequest(id = 'message', accountId = 'user-a', confirmRetry=false) {
  return unsubscribeRoute(
    new Request(`${env.APP_URL}/api/unsubscribe`, {
      method: 'POST',
      headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, accountId, confirmRetry }),
    }),
  );
}
const sentToProvider = () =>
  requests.filter((r) => r.url.startsWith('https://news.list-manage.com/')).length;

void test('a second click while the first is running does not reach the provider twice', async () => {
  await seed();
  const started=deferred();
  provider = { status: 200, delay: deferred(), started };
  const first = unsubscribeRequest();
  await started.promise;
  // The second arrives while the first still holds the claim, so it is answered from the
  // stored row instead of producing another request to the newsletter service.
  const second = (await (await unsubscribeRequest()).json()) as { outcome: string; saved?: boolean };
  assert.equal(second.outcome, 'pending', 'the request already in flight is reported');
  assert.equal(second.saved, true, 'and it came from the record, not from a new request');

  provider.delay!.resolve();
  const firstBody = (await (await first).json()) as { outcome: string };
  assert.equal(firstBody.outcome, 'accepted');
  assert.equal(sentToProvider(), 1, 'exactly one request reached the provider');
});

void test('an uncertain outcome is never retried by itself, a refusal can be', async () => {
  await seed();
  provider = { status: 504 };
  const uncertain = (await (await unsubscribeRequest()).json()) as { outcome: string };
  assert.equal(uncertain.outcome, 'unknown', 'a broken service is not a refusal');

  // Clicking again returns what is stored rather than repeating a request that may already
  // have unsubscribed the person.
  provider = { status: 200 };
  const again = (await (await unsubscribeRequest()).json()) as { outcome: string; saved?: boolean };
  assert.equal(again.outcome, 'unknown');
  assert.equal(again.saved, true);
  assert.equal(sentToProvider(), 1, 'no second request was sent for an uncertain outcome');

  // A definite refusal is recoverable: the next attempt really does try again.
  storage.sql.prepare("UPDATE unsubscribe_requests SET outcome='failed'").run();
  const retried = (await (await unsubscribeRequest()).json()) as { outcome: string };
  assert.equal(retried.outcome, 'accepted');
  assert.equal(sentToProvider(), 2, 'a failed request may be tried again');
});

void test('a stale attempt cannot overwrite the result of a newer one', async () => {
  await seed();
  provider = { status: 200 };
  await unsubscribeRequest();
  const row = () =>
    storage.sql.prepare('SELECT outcome, attempt FROM unsubscribe_requests').get() as
      { outcome: string; attempt: string | null };
  assert.equal(row().outcome, 'accepted');
  assert.ok(row().attempt, 'the winning attempt is recorded on the row');

  // A slow earlier attempt writes against the attempt id it was given, which the row no
  // longer carries, so nothing is overwritten.
  const overwritten = storage.sql
    .prepare("UPDATE unsubscribe_requests SET outcome='failed' WHERE attempt=?")
    .run('an-attempt-that-lost');
  assert.equal(overwritten.changes, 0);
  assert.equal(row().outcome, 'accepted', 'the newer result stands');
});

void test('the provider response decides the outcome, and no outcome touches the mailbox', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  const stored = () =>
    (storage.sql
      .prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=?')
      .get('user-a') as { n: number }).n;
  const before = stored();
  assert.ok(before > 0, 'there is mail to lose');

  for (const [status, expected] of
    [[200, 'accepted'], [302, 'action-required'], [400, 'failed'], [500, 'unknown']] as const) {
    storage.sql.prepare('DELETE FROM unsubscribe_requests').run();
    provider = { status };
    const body = (await (await unsubscribeRequest()).json()) as { outcome: string };
    assert.equal(body.outcome, expected, `status ${status}`);
  }
  assert.equal(stored(), before, 'no unsubscribe outcome removes stored mail');
});

void test('after unsubscribing, receipts and later newsletters from that sender still arrive', async () => {
  await seed();
  provider = { status: 200 };
  await syncInbox('user-a', 'user-a', env);
  assert.equal((await (await unsubscribeRequest()).json() as { outcome: string }).outcome, 'accepted');

  // The same sending address later delivers a receipt and another newsletter issue. Both are
  // stored: the sender decides what it sends, and a receipt is not a newsletter.
  inbox = [
    { id: 'message' },
    { id: 'receipt', headers: [['Subject', 'Your receipt']] },
    { id: 'issue-2' },
  ];
  await syncInbox('user-a', 'user-a', env);
  const ids = (storage.sql
    .prepare('SELECT message_id FROM mailbox_messages WHERE account_id=? ORDER BY message_id')
    .all('user-a') as { message_id: string }[]).map((r) => r.message_id);
  assert.deepEqual(ids, ['issue-2', 'message', 'receipt'],
    'nothing from that sender is filtered out after an unsubscribe');
});

void test('an unsubscribe leaves an explicit junk rule exactly as it was', async () => {
  await seed();
  storage.sql
    .prepare(`INSERT INTO sender_rules (user_id,account_id,address,junk_preference,revision,updated,active)
      VALUES (?,?,?,'junk',3,7,1)`)
    .run('user-a', 'user-a', 'sender@example.com');
  const before = storage.sql.prepare('SELECT * FROM sender_rules').get();
  provider = { status: 200 };
  await unsubscribeRequest();
  assert.deepEqual(storage.sql.prepare('SELECT * FROM sender_rules').get(), before,
    'unsubscribing is not a filing decision and never touches a junk rule');
});

void test('the same newsletter in two mailboxes is two separate records', async () => {
  await seed();
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  provider = { status: 200 };
  await unsubscribeRequest('message', 'user-a');
  await unsubscribeRequest('message', 'acct-2');
  const rows = storage.sql
    .prepare('SELECT id, account_id FROM unsubscribe_requests ORDER BY account_id')
    .all() as { id: string; account_id: string }[];
  assert.deepEqual(rows.map((r) => r.account_id), ['acct-2', 'user-a']);
  assert.equal(new Set(rows.map((r) => r.id)).size, 2, 'one mailbox is never the other');
});

void test('a forged account id and a browser-supplied destination are both refused', async () => {
  await seed();
  provider = { status: 200 };
  // An account belonging to nobody, and one belonging to another user, are indistinguishable.
  await seed('user-b', 'other@example.com', 0, 'acct-b');
  for (const accountId of ['acct-b', 'does-not-exist', 'all']) {
    const response = await unsubscribeRequest('message', accountId);
    assert.ok(response.status === 404 || response.status === 400, `${accountId} -> ${response.status}`);
  }
  assert.equal(
    (storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribe_requests').get() as { n: number }).n,
    0, 'no record is created for an account the user does not own');

  // A destination in the request body is ignored: the endpoint comes from the message.
  const response = await unsubscribeRoute(new Request(`${env.APP_URL}/api/unsubscribe`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'message', accountId: 'user-a', url: 'https://attacker.example/steal' }),
  }));
  assert.equal((await response.json() as { outcome: string }).outcome, 'accepted');
  assert.equal(requests.filter((r) => r.url.includes('attacker.example')).length, 0,
    'the browser cannot choose where the request goes');
  assert.equal(sentToProvider(), 1);
});

void test('a dropped connection is reported as uncertain, not as success or refusal', async () => {
  await seed();
  provider = { status: 0 };
  const saved = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input).startsWith('https://news.list-manage.com/')) throw new Error('socket closed');
    return saved(input, init);
  };
  const body = await (await unsubscribeRequest()).json() as { outcome: string; reason: string };
  globalThis.fetch = saved;
  assert.equal(body.outcome, 'unknown');
  assert.equal(body.reason, 'uncertain');
  const row = storage.sql.prepare('SELECT outcome FROM unsubscribe_requests').get() as { outcome: string };
  assert.equal(row.outcome, 'unknown', 'and the record says so, so nothing retries it by itself');
});

void test('a provider acceptance that cannot be recorded is described accurately', async () => {
  await seed();
  provider = { status: 200 };
  // The row vanishes between the claim and the completion write, as a database fault would.
  const real = env.DB;
  let dropped = false;
  env.DB = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== 'prepare') return Reflect.get(target, property, receiver) as unknown;
      return (query: string) => {
        if (!dropped && query.startsWith('UPDATE unsubscribe_requests SET outcome=?')) {
          dropped = true;
          storage.sql.prepare('DELETE FROM unsubscribe_requests').run();
        }
        return target.prepare(query);
      };
    },
  });
  const body = await (await unsubscribeRequest()).json() as { outcome: string; reason: string };
  assert.equal(body.outcome, 'accepted', 'the provider did accept, and that is what is reported');
  assert.equal(body.reason, 'record-not-saved', 'and the failure to save it is stated separately');
});

void test('disconnecting a mailbox takes its unsubscribe history with it', async () => {
  await seed();
  provider = { status: 200 };
  await unsubscribeRequest();
  assert.equal(
    (storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribe_requests').get() as { n: number }).n,
    1, 'there is history to leave behind');

  const response = await disconnectAccount(new Request(`${env.APP_URL}/api/disconnect`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'user-a' }),
  }));
  assert.equal(response.status, 200);
  assert.equal(
    (storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribe_requests').get() as { n: number }).n,
    0, 'no row survives the account it belonged to');
});

void test('a disconnected account cannot gain an orphaned record', async () => {
  await seed();
  storage.sql.prepare('DELETE FROM connections WHERE id=?').run('user-a');
  const response = await unsubscribeRequest();
  assert.equal(response.status, 404);
  assert.equal(
    (storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribe_requests').get() as { n: number }).n,
    0);
});

void test('a recovery scan restores mail an earlier version deleted', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  const count = () =>
    (storage.sql.prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=?')
      .get('user-a') as { n: number }).n;
  assert.equal(count(), 1);

  // Exactly what the old code did: the rows are gone, and the account is queued.
  storage.sql.prepare('DELETE FROM mailbox_messages WHERE account_id=?').run('user-a');
  storage.sql.prepare('UPDATE connections SET recovery_needed=1, last_full_scan=? WHERE id=?')
    .run(Date.now(), 'user-a');
  assert.equal(count(), 0);

  // An interrupted scan keeps the flag and its position, then a later run finishes it.
  paging = 'more';
  await syncInbox('user-a', 'user-a', env);
  assert.equal(count(), 1, 'the message still in Gmail comes back');
  assert.equal((storage.sql.prepare('SELECT recovery_needed FROM connections WHERE id=?')
    .get('user-a') as { recovery_needed: number }).recovery_needed, 1, 'and recovery is not yet done');
  paging = 'done';
  await syncInbox('user-a', 'user-a', env);
  assert.equal((storage.sql.prepare('SELECT recovery_needed FROM connections WHERE id=?')
    .get('user-a') as { recovery_needed: number }).recovery_needed, 0);
  assert.equal(count(), 1);
});

void test('a request is recorded against the newsletter, not the sender', async () => {
  await seed();
  provider = { status: 200 };
  await unsubscribeRequest();
  const row = storage.sql
    .prepare('SELECT id, list_id, scope, message_id FROM unsubscribe_requests')
    .get() as { id: string; list_id: string | null; scope: string; message_id: string };
  assert.equal(row.scope, 'list');
  assert.equal(row.list_id, 'daily.news.example.com', 'the List-ID, not the sender address');
  assert.equal(row.id, 'user-a:list:daily.news.example.com');
  assert.equal(row.message_id, 'message', 'the message it was made from is kept too');
});

void test('unsubscribing keeps every stored message, now and on the next sync', async () => {
  await seed();
  const accountId = 'user-a';
  await syncInbox('user-a', accountId, env);
  const stored = () =>
    storage.sql
      .prepare('SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=?')
      .get(accountId) as { n: number };
  assert.equal(stored().n, 1, 'the mailbox has the synced message');

  // A history row exists for this sender, as a completed unsubscribe would leave behind.
  storage.sql
    .prepare(
      `INSERT INTO unsubscribe_requests (id,user_id,account_id,message_id,list_id,address,scope,outcome,detail,created,updated)
       VALUES (?,?,?,?,NULL,?,'message','accepted',NULL,1,1)`,
    )
    .run(accountId + ':message:message', 'user-a', accountId, 'message', 'sender@example.com');

  // Nothing is removed by the record's existence, and a later sync writes the sender's
  // mail again rather than skipping it: the sender still decides what it sends, and its
  // receipts and account notices travel on the same address as its newsletters.
  await syncInbox('user-a', accountId, env);
  assert.equal(stored().n, 1, 'the message survives a sync taken after the unsubscribe');
  const message = storage.sql
    .prepare('SELECT message_id FROM mailbox_messages WHERE account_id=?')
    .get(accountId) as { message_id: string };
  assert.equal(message.message_id, 'message', 'and it is the same message, not a placeholder');
});

void test('a legacy unsubscribe row becomes history and schedules a recovery scan', async () => {
  // Recreate the pre-retirement state before exercising the data migration.
  storage.sql.exec('DROP TRIGGER unsubscribed_legacy_insert; DROP TRIGGER unsubscribed_no_update;');
  // Written the way the previous version wrote it: sender-wide, with no outcome recorded.
  storage.sql
    .prepare('INSERT INTO unsubscribed (id,user_id,account_id,address,created) VALUES (?,?,?,?,7)')
    .run('acct-legacy:news@example.com', 'user-legacy', 'acct-legacy', 'news@example.com');
  storage.sql
    .prepare(
      'INSERT INTO connections (id,user_id,provider_identity,email,token,token_version,last_sync,sync_lock,error,created) VALUES (?,?,NULL,?,?,1,123,0,NULL,123)',
    )
    .run('acct-legacy', 'user-legacy', 'legacy@example.com', 'token');

  // The harness applies every migration when the database is built, so the schema is
  // already in place. Replaying only the data statements runs the same conversion this
  // migration performs on a deployment where rows already exist.
  for (const statement of readFileSync('drizzle/0014_unsubscribe_requests.sql', 'utf8')
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .filter((part) => part && !/^(CREATE|ALTER)\b/i.test(part.replace(/^--[^\n]*\n/gm, '').trim())))
    storage.sql.exec(statement);

  const history = storage.sql
    .prepare('SELECT * FROM unsubscribe_requests WHERE account_id=?')
    .get('acct-legacy') as { scope: string; outcome: string; message_id: string | null };
  assert.equal(history.scope, 'legacy-sender', 'its limited meaning is recorded, not guessed');
  assert.equal(history.outcome, 'unknown', 'no provider response was ever stored for it');
  assert.equal(history.message_id, null, 'it cannot name the newsletter it came from');

  // Emptying the old table is what stops a still-running old version from deleting mail.
  const legacy = storage.sql
    .prepare('SELECT COUNT(*) AS n FROM unsubscribed')
    .get() as { n: number };
  assert.equal(legacy.n, 0, 'nothing is left for the previous version to act on');

  const connection = storage.sql
    .prepare('SELECT recovery_needed FROM connections WHERE id=?')
    .get('acct-legacy') as { recovery_needed: number };
  assert.equal(connection.recovery_needed, 1, 'the affected account is queued for reconciliation');
});

void test('recovery is marked complete only when a full scan finishes', async () => {
  await seed();
  const accountId = 'user-a';
  storage.sql.prepare('UPDATE connections SET recovery_needed=1 WHERE id=?').run(accountId);
  const flag = () =>
    (storage.sql
      .prepare('SELECT recovery_needed, sync_page_token FROM connections WHERE id=?')
      .get(accountId) as { recovery_needed: number; sync_page_token: string | null });

  // A page that reports more to come leaves the scan in progress, so the flag stays set
  // and the saved cursor is the one the next run resumes from.
  paging = 'more';
  await syncInbox('user-a', accountId, env);
  assert.equal(flag().recovery_needed, 1, 'an unfinished scan has recovered nothing yet');
  assert.equal(flag().sync_page_token, 'next-page', 'and its position is kept');

  paging = 'done';
  await syncInbox('user-a', accountId, env);
  assert.equal(flag().recovery_needed, 0, 'a completed full scan clears it');
  assert.equal(flag().sync_page_token, null);
});

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
  for (const table of ['operations'])
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

// ── Blocked senders ─────────────────────────────────────────────────────────

import { POST as blockRoute } from '../app/api/block/route';

const blockRequest = (body: unknown) =>
  blockRoute(new Request(`${env.APP_URL}/api/block`, {
    method: 'POST',
    headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
const viewOf = async (accountId?: string) =>
  (await (await mailbox(mailboxRequest(accountId))).json()) as InboxSnapshot;
const storedMail = (account: string) =>
  storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get(account);

void test('blocking a sender hides its mail without deleting it, and unblocking restores it', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  seedMail('acct-1', [
    { id: 'promo', address: 'Deals@Shop.example', receivedAt: 200, subject: 'Sale' },
    { id: 'friend', address: 'friend@example.com', receivedAt: 100, subject: 'Hi' },
  ]);
  const before = storedMail('acct-1');

  // The address is matched without regard to case, as sender rules are.
  const response = await blockRequest({ accountId: 'acct-1', address: 'deals@shop.example', name: 'Shop', blocked: true });
  assert.equal(response.status, 200);
  const view = await viewOf('acct-1');
  assert.deepEqual(view.emails.map((email) => email.id), ['friend'], 'the blocked sender is hidden');
  assert.deepEqual(view.blocked?.map((sender) => [sender.address, sender.name, sender.accountEmail]),
    [['deals@shop.example', 'Shop', 'first@example.com']], 'and listed so it can be unblocked');
  assert.deepEqual(storedMail('acct-1'), before, 'the stored mail itself is untouched');
  assert.equal(requests.filter((r) => !r.url.includes('oauth2')).length, 0, 'nothing is sent anywhere');

  // Blocking twice is harmless.
  assert.equal((await blockRequest({ accountId: 'acct-1', address: 'deals@shop.example', blocked: true })).status, 200);

  await blockRequest({ accountId: 'acct-1', address: 'DEALS@shop.example', blocked: false });
  const restored = await viewOf('acct-1');
  assert.deepEqual(restored.emails.map((email) => email.id), ['promo', 'friend'], 'unblocking brings every message back');
  assert.deepEqual(restored.blocked, []);
});

void test('a block applies only to the mailbox it was made in', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await seed('user-a', 'second@example.com', 0, 'acct-2');
  seedMail('acct-1', [{ id: 'one', address: 'news@example.org', receivedAt: 200, subject: 'A' }]);
  seedMail('acct-2', [{ id: 'two', address: 'news@example.org', receivedAt: 100, subject: 'B' }]);
  await blockRequest({ accountId: 'acct-1', address: 'news@example.org', blocked: true });
  const combined = await viewOf();
  assert.deepEqual(combined.emails.map((email) => `${email.accountId}:${email.id}`), ['acct-2:two']);
  assert.deepEqual(combined.blocked?.map((sender) => sender.accountId), ['acct-1'],
    'the combined view lists blocks from every mailbox');
});

void test('blocking refuses another user’s mailbox, the combined view and invalid input', async () => {
  await seed('user-a', 'mine@example.com', 0, 'acct-1');
  await seed('user-b', 'theirs@example.com', 0, 'acct-b');
  assert.equal((await blockRequest({ accountId: 'acct-b', address: 'x@example.com', blocked: true })).status, 404);
  assert.notEqual((await blockRequest({ accountId: 'all', address: 'x@example.com', blocked: true })).status, 200);
  assert.equal((await blockRequest({ accountId: 'acct-1', address: 'not an address', blocked: true })).status, 400);
  assert.equal((await blockRequest({ accountId: 'acct-1', address: 'x@example.com' })).status, 400,
    'block or unblock must be stated, never assumed');
  assert.equal(storage.sql.prepare('SELECT COUNT(*) AS n FROM blocked_senders').get()?.n, 0);
});

void test('disconnecting a mailbox removes its blocked senders', async () => {
  await seed('user-a', 'first@example.com', 0, 'acct-1');
  await blockRequest({ accountId: 'acct-1', address: 'news@example.org', blocked: true });
  await disconnectAccount(disconnectRequest({ accountId: 'acct-1' }));
  assert.equal(storage.sql.prepare('SELECT COUNT(*) AS n FROM blocked_senders').get()?.n, 0);
});

// ── Rule changes reach mail that is already stored ─────────────────────────

const listQueries = () =>
  requests
    .filter((r) => r.url.includes('/users/me/messages?maxResults=100&q='))
    .map((r) => decodeURIComponent(new URL(r.url).searchParams.get('q') || ''));

void test('a classification rule change rescans older mail once, then refreshes return to two days', async () => {
  await seed();
  // A mailbox whose last complete scan ran under the previous rules.
  storage.sql
    .prepare('UPDATE connections SET backfill_complete=1, last_full_scan=?, content_version=? WHERE id=?')
    .run(Date.now() - 86400000, CONTENT_VERSION - 1, 'user-a');
  await syncInbox('user-a', 'user-a', env);
  assert.ok(!listQueries()[0].includes('newer_than'), 'the whole mailbox is revisited under the new rules');
  assert.equal(row('connections')!.content_version, CONTENT_VERSION, 'recorded once the scan reaches its last page');

  requests = [];
  await syncInbox('user-a', 'user-a', env);
  assert.ok(listQueries()[0].includes('newer_than:2d'), 'the next refresh is incremental again');
});

void test('an interrupted rescan resumes from its cursor and records the new rules only at the end', async () => {
  await seed();
  storage.sql
    .prepare('UPDATE connections SET backfill_complete=1, last_full_scan=?, content_version=? WHERE id=?')
    .run(Date.now() - 86400000, CONTENT_VERSION - 1, 'user-a');
  paging = 'more';
  await syncInbox('user-a', 'user-a', env);
  assert.equal(row('connections')!.sync_page_token, 'next-page');
  assert.equal(row('connections')!.content_version, CONTENT_VERSION - 1, 'not recorded mid-scan');
  paging = 'done';
  requests = [];
  await syncInbox('user-a', 'user-a', env);
  assert.ok(requests.some((r) => r.url.includes('pageToken=next-page')), 'the scan resumes where it stopped');
  assert.equal(row('connections')!.content_version, CONTENT_VERSION);
});

void test('a model result from older rules is rechecked locally; a current one is reused', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  await seed();
  let calls = 0;
  const provider = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      calls++;
      const request = JSON.parse(init!.body as string) as { contents: { parts: { text: string }[] }[] };
      const ids = (JSON.parse(request.contents[0].parts[0].text) as { id: string }[]).map((m) => m.id);
      const items = ids.map((id) => ({ id, context: 'personal', topics: [], disposition: 'useful', replyRequired: false,
        securityEvent: false, summary: 'A greeting.', reason: 'A short greeting.', obligations: [] }));
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items }) }] }, finishReason: 'STOP' }] });
    }
    return provider(input, init);
  };
  const stored = () => JSON.parse((storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?').get('message') as { data: string }).data) as { analysisVersion: string; classificationSource: string };

  await syncInbox('user-a', 'user-a', env);
  assert.equal(calls, 1);
  assert.equal(stored().classificationSource, 'ai');

  await syncInbox('user-a', 'user-a', env);
  assert.equal(calls, 1, 'unchanged content under the current prompt is not sent again');

  // A result produced by the previous prompt, before the purpose checks existed.
  const older = 'gemini:gemini-3.5-flash-lite:2026-09-21-categories';
  const data = JSON.parse((storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?').get('message') as { data: string }).data) as Record<string, unknown> & { automaticClassification: Record<string, unknown> };
  storage.sql.prepare('UPDATE mailbox_messages SET data=? WHERE message_id=?')
    .run(JSON.stringify({ ...data, analysisVersion: older,
      automaticClassification: { ...data.automaticClassification, version: 'policy-2026-09-22-1' } }), 'message');
  await syncInbox('user-a', 'user-a', env);
  assert.equal(calls, 2, 'an older prompt is refreshed through the bounded queue');
  assert.equal(stored().classificationSource, 'ai', 'the model’s result is kept, not replaced by the rule-based one');
  assert.equal(stored().analysisVersion, analysisVersion(env), 'the new version names the successful refresh');
  await syncInbox('user-a', 'user-a', env);
  assert.equal(calls, 2, 'once refreshed, the result is reused');
});

void test('an uncertain unsubscribe can be retried only after an explicit confirmation',async()=>{
  await seed();provider={status:504};
  await unsubscribeRequest();
  provider={status:200};
  const result=await (await unsubscribeRequest('message','user-a',true)).json() as {outcome:string};
  assert.equal(result.outcome,'accepted');assert.equal(sentToProvider(),2);
});

// ── Audit 2026-09-29, section 1: duplicate sends and destructive races ─────────

/** The statements an older running version issues when it unsubscribes a sender. */
function olderInstanceUnsubscribes(address = 'sender@example.com') {
  storage.sql.prepare('INSERT OR IGNORE INTO unsubscribed (id,user_id,account_id,address,created) VALUES (?,?,?,?,?)')
    .run('user-a:' + address, 'user-a', 'user-a', address, Date.now());
  return storage.sql.prepare("DELETE FROM mailbox_messages WHERE account_id=? AND user_id=? AND json_extract(data,'$.address')=?")
    .run('user-a', 'user-a', address);
}
const storedCount = () => (storage.sql.prepare('SELECT COUNT(*) AS n FROM mailbox_messages').get() as { n: number }).n;

void test('an older instance unsubscribing during a rollout cannot delete stored mail', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  assert.equal(storedCount(), 1);
  const removed = olderInstanceUnsubscribes();
  assert.equal(Number(removed.changes), 0, 'the delete is refused while the guard stands');
  assert.equal(storedCount(), 1);
  assert.equal((storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get() as { n: number }).n, 0,
    'no suppression row survives for an older sync to act on');
  assert.equal(row('connections')!.recovery_needed, 1, 'a recovery scan is scheduled anyway');
  assert.equal(row('unsubscribe_requests')!.scope, 'legacy-sender', 'the request is kept as history');

  // The current version takes over: guards are cleared and recovery completes.
  await syncInbox('user-a', 'user-a', env);
  assert.equal(row('connections')!.recovery_needed, 0);
  assert.equal((storage.sql.prepare('SELECT COUNT(*) AS n FROM legacy_unsubscribe_guards').get() as { n: number }).n, 0);
  assert.equal(storedCount(), 1);
});

void test('a guarded sender does not survive disconnecting the account', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  olderInstanceUnsubscribes();
  const response = await disconnectRoute(new Request(`${env.APP_URL}/api/disconnect`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: 'user-a' }) }));
  assert.equal(response.status, 200);
  assert.equal(storedCount(), 0);
  assert.equal((storage.sql.prepare('SELECT COUNT(*) AS n FROM legacy_unsubscribe_guards').get() as { n: number }).n, 0);
});

void test('a disconnect during the Gmail read stops the unsubscribe before the provider', async () => {
  await seed();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    if (requestUrl(input).includes('/messages/message?')) storage.sql.prepare('DELETE FROM connections WHERE id=?').run('user-a');
    return response;
  };
  const result = await (await unsubscribeRequest()).json() as { reason: string };
  assert.equal(result.reason, 'account-disconnected');
  assert.equal(sentToProvider(), 0, 'nothing reaches the newsletter service');
  assert.equal((storage.sql.prepare('SELECT COUNT(*) AS n FROM unsubscribe_requests').get() as { n: number }).n, 0,
    'no history is recreated for a removed account');
});

void test('unsubscribe and reply refuse a message id that is not a string', async () => {
  await seed();
  const unsubscribe = await unsubscribeRoute(new Request(`${env.APP_URL}/api/unsubscribe`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: ['message'], accountId: 'user-a' }) }));
  assert.equal(unsubscribe.status, 400);
  let sends = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => requestUrl(input).endsWith('/messages/send')
    ? (sends++, Response.json({ id: 'sent-' + sends })) : original(input, init);
  const send = (id: unknown) => replyRoute(new Request(`${env.APP_URL}/api/reply`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, accountId: 'user-a', action: 'send', body: 'Thanks!' }) }));
  assert.equal((await send('message')).status, 200);
  assert.equal((await send(['message'])).status, 400);
  assert.equal((await send('message')).status, 200, 'the identical string request is answered from its receipt');
  assert.equal(sends, 1);
});

void test('two confirmed retries of the same unconfirmed reply send it once', async () => {
  await seed();
  let phase: 'initial' | 'retry' = 'initial';
  let sends = 0;
  const release = deferred();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!requestUrl(input).endsWith('/messages/send')) return original(input, init);
    if (phase === 'initial') return new Response('unknown', { status: 503 });
    sends++;
    await release.promise;
    return Response.json({ id: 'send-' + sends });
  };
  const send = (confirmUnsent = false) => replyRoute(new Request(`${env.APP_URL}/api/reply`, {
    method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'message', accountId: 'user-a', action: 'send', body: 'Same reply', confirmUnsent }) }));
  assert.equal((await send()).status, 502, 'Gmail did not confirm the send');
  // The seeded receipt is a different operation; this one is the reply just attempted.
  const reply = () => (storage.sql.prepare("SELECT status FROM operations WHERE id<>'user-a:sent'").get() as { status: string }).status;
  assert.equal(reply(), 'unconfirmed');
  phase = 'retry';

  // Hold both requests after they read the unconfirmed operation, so each believes it may
  // take it over. Only one may.
  const db = env.DB;
  let reads = 0;
  const bothRead = deferred();
  const wrapped = Object.create(db) as typeof db;
  wrapped.prepare = (query: string) => {
    const statement = db.prepare(query);
    if (!query.startsWith('SELECT status, result, created, attempt FROM operations')) return statement;
    const first = statement.first.bind(statement);
    // `bind` returns the statement itself, so replacing `first` here covers the bound call.
    return Object.assign(statement, {
      async first() { const result = await first(); if (++reads === 2) bothRead.resolve(); await bothRead.promise; return result; } });
  };
  env.DB = wrapped;
  globalThis.__briefTestEnv = env;
  const both = Promise.all([send(true), send(true)]);
  await bothRead.promise;
  // Let the winner reach the provider before releasing it.
  for (let i = 0; i < 20 && sends === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  release.resolve();
  const statuses = (await both).map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(sends, 1, 'one reply reaches Gmail');
  assert.equal(reply(), 'complete');
});

// ── Audit 2026-09-29, section 2: AI cache and rule upgrades ────────────────────

/** A model stub: `respond` decides each answer; returns how many calls were made. */
function modelStub(respond: (ids: string[]) => Response | object[]) {
  // `calls` counts classification requests only. The daily digest asks the model a different
  // question (wording for the top items), which is counted apart so these assertions keep
  // meaning "no second classification".
  const counter = { calls: 0, digestCalls: 0 };
  const provider = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return provider(input, init);
    const request = JSON.parse(init!.body as string) as { systemInstruction?: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
    if (/daily digest/.test(request.systemInstruction?.parts[0]?.text ?? '')) {
      counter.digestCalls++;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: [] }) }] }, finishReason: 'STOP' }] });
    }
    counter.calls++;
    const ids = (JSON.parse(request.contents[0].parts[0].text) as { id: string }[]).map((m) => m.id);
    const answer = respond(ids);
    if (answer instanceof Response) return answer;
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items: answer }) }] }, finishReason: 'STOP' }] });
  };
  return counter;
}
const greeting = (ids: string[]) => ids.map((id) => ({ id, context: 'personal', topics: [], disposition: 'useful',
  replyRequired: false, securityEvent: false, summary: 'A greeting.', reason: 'A short greeting.', obligations: [] }));
const storedMessage = () => JSON.parse((storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?')
  .get('message') as { data: string }).data) as { classificationSource: string; analysisVersion: string; needsReply: boolean;
  automaticClassification: { obligations: { kind: string; required: boolean }[]; replyRequired: boolean } };

void test('after a model outage, retries back off and a due retry reaches the recovered model', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  await seed();
  let failing = true;
  const model = modelStub((ids) => failing ? new Response('unavailable', { status: 503 }) : greeting(ids));
  const first = await syncInbox('user-a', 'user-a', env);
  assert.equal(first.pending, 1);
  assert.equal(first.ai, false);
  assert.equal(storedMessage().classificationSource, 'deterministic');
  const failedCalls = model.calls;
  failing = false;
  await syncInbox('user-a', 'user-a', env);
  assert.equal(model.calls, failedCalls, 'an immediate refresh does not repeat the failed call');
  storage.sql.prepare("UPDATE mailbox_messages SET data=json_set(data,'$.modelRetryAt',0) WHERE account_id=?").run('user-a');
  const second = await syncInbox('user-a', 'user-a', env);
  assert.ok(model.calls > failedCalls, 'the stand-in result is sent to the recovered model');
  assert.equal(second.pending, 0);
  assert.equal(storedMessage().classificationSource, 'ai', '“ai” is reported only once the model really answered');
  const settled = model.calls;
  await syncInbox('user-a', 'user-a', env);
  assert.equal(model.calls, settled, 'and then it is reused');
});

void test('a permanently rejected model result cannot force repeated full Gmail scans', async () => {
  env.GEMINI_API_KEY='test-gemini-key';
  await seed();
  const model=modelStub(()=>new Response('unavailable',{status:503}));
  await syncInbox('user-a','user-a',env);
  const calls=model.calls;
  const before=requests.length;
  await syncInbox('user-a','user-a',env);
  assert.equal(model.calls,calls,'the failed item waits for its retry time');
  const next=requests.slice(before).find(request=>request.url.includes('/messages?maxResults=100&q='));
  assert.ok(next?.url.includes('newer_than%3A2d'),'the next refresh uses the incremental Gmail window');
});

void test('a scan part-way through the mailbox fetches newly arrived mail first', async () => {
  inbox=[{id:'old-1'},{id:'old-2'},{id:'new-1'}];
  paging='more';
  await seed();
  const provider=globalThis.fetch;
  const fetched:string[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=requestUrl(input);
    // Every page of the scan holds older mail; only the newest-mail listing sees new-1.
    if(url.includes('/users/me/messages?maxResults=100&q='))
      return Response.json({messages:[{id:'old-1'},{id:'old-2'}],nextPageToken:'next-page'});
    if(url.includes('/users/me/messages?maxResults=50&q='))
      return Response.json({messages:[{id:'new-1'},{id:'old-1'}]});
    const full=/\/users\/me\/messages\/([^?]+)\?format=full/.exec(url)?.[1];
    if(full)fetched.push(full);
    return provider(input,init);
  };
  await syncInbox('user-a','user-a',env);
  assert.deepEqual(fetched,['old-1','old-2'],'a fresh scan starts at the newest page, so nothing extra is listed');
  fetched.length=0;
  const continued=await syncInbox('user-a','user-a',env);
  assert.equal(fetched[0],'new-1','new mail is fetched ahead of the older page');
  assert.equal(fetched.filter(id=>id==='new-1').length,1);
  assert.ok(continued.emails.some(email=>email.id==='new-1'),'and is stored with this page');
  fetched.length=0;
  await syncInbox('user-a','user-a',env);
  assert.ok(!fetched.includes('new-1'),'stored mail is not fetched again by the newest-mail check');
});

void test('a mailbox already being refreshed is reported as deferred, never as a failure', async () => {
  inbox=[{id:'m1'}];
  await seed();
  await seed('user-a','busy@example.com',Date.now()+600000,'busy-account');
  const response=await syncMailbox(new Request(`${env.APP_URL}/api/sync`,{method:'POST',headers:{origin:env.APP_URL!,'Content-Type':'application/json'},body:JSON.stringify({explicit:true})}));
  assert.equal(response.status,200);
  const body=await response.json() as {refreshed:number;failed:number;failures:unknown[];deferred:{accountId:string;email:string;reason:string}[]};
  assert.equal(body.refreshed,1,'the free mailbox refreshed');
  assert.deepEqual([body.failed,body.failures],[0,[]],'nothing failed');
  assert.deepEqual(body.deferred,[{accountId:'busy-account',email:'busy@example.com',reason:'busy'}]);
  const real=storage.sql.prepare('SELECT error FROM connections WHERE id=?').get('busy-account') as {error:string|null};
  assert.equal(real.error,null,'and no error is recorded on it');
});

void test('the Inbox mirrors Gmail: mail archived there leaves it on the next refresh', async () => {
  inbox=[{id:'kept'},{id:'archived'}];
  await seed();
  const provider=globalThis.fetch;
  let gmailInbox:string[]|undefined=['kept','archived'];
  let quiet=false;
  globalThis.fetch=async(input,init)=>{
    const url=requestUrl(input);
    if(url.includes('/users/me/messages?labelIds=INBOX'))
      return gmailInbox?Response.json({messages:gmailInbox.map(id=>({id}))}):new Response('bad request',{status:400});
    // Once both messages are older than the two-day window, refreshes no longer fetch them.
    if(quiet&&url.includes('/users/me/messages?maxResults=100&q='))return Response.json({messages:[]});
    return provider(input,init);
  };
  const state=()=>Object.fromEntries((storage.sql.prepare("SELECT message_id, json_extract(data,'$.inInbox') AS inbox FROM mailbox_messages WHERE account_id=?")
    .all('user-a') as {message_id:string;inbox:number}[]).map(row=>[row.message_id,row.inbox]));
  await syncInbox('user-a','user-a',env);
  assert.deepEqual(state(),{kept:1,archived:1});
  // Archived in Gmail after the window passed: only the inbox listing can say it left.
  quiet=true;
  gmailInbox=['kept'];
  const mirrored=await syncInbox('user-a','user-a',env);
  assert.deepEqual(state(),{kept:1,archived:0});
  assert.equal(mirrored.emails.find(email=>email.id==='archived')?.inInbox,false,'the refresh returns the mirrored state');
  // A failed listing keeps the last known inbox instead of emptying or refilling it.
  gmailInbox=undefined;
  await syncInbox('user-a','user-a',env);
  assert.deepEqual(state(),{kept:1,archived:0});
});

void test('older fallback mail is upgraded in bounded batches after a model outage', async () => {
  env.GEMINI_API_KEY='test-gemini-key';
  inbox=Array.from({length:10},(_,index)=>({id:`older-${index}`}));
  await seed();
  let failing=true;
  const model=modelStub(ids=>failing?new Response('unavailable',{status:503}):greeting(ids));
  await syncInbox('user-a','user-a',env);
  const firstRetry=storage.sql.prepare("SELECT json_extract(data,'$.modelRetryAt') AS retry FROM mailbox_messages WHERE message_id=?").get('older-0') as {retry:number};
  assert.ok(firstRetry.retry<=Date.now()+30*60000,'a provider outage is retried at the next scheduled refresh');
  failing=false;
  // The normal incremental Gmail listing correctly omits these old messages. The
  // retry queue must fetch their IDs directly once each message's backoff expires.
  const provider=globalThis.fetch;
  const queries:string[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=requestUrl(input);
    // Mailbox scans only; the inbox mirror's id listing is not one.
    if(url.includes('/users/me/messages?')&&!url.includes('labelIds=INBOX')&&!url.includes('labelIds=SENT')){
      queries.push(new URL(url).searchParams.get('q')||'');
      if(queries.at(-1)?.includes('newer_than:2d'))return Response.json({messages:[]});
    }
    return provider(input,init);
  };
  storage.sql.prepare("UPDATE mailbox_messages SET data=json_set(data,'$.modelRetryAt',0) WHERE account_id=?").run('user-a');
  const before=requests.length;
  const recovered=await syncInbox('user-a','user-a',env);
  const queried=requests.slice(before);
  assert.deepEqual(queries.length,1);
  assert.ok(queries[0].includes('newer_than:2d'));
  assert.equal(queried.filter(request=>request.url.includes('/messages/older-')&&request.url.includes('format=full')).length,10);
  assert.equal(model.calls>0,true);
  assert.equal(recovered.pending,0);
  assert.equal(storage.sql.prepare("SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=? AND json_extract(data,'$.classificationSource')='ai'").get('user-a')?.n,10);
});

void test('adding a model key later reaches mail classified without one', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  await syncInbox('user-a', 'user-a', env);
  assert.equal(storedMessage().classificationSource, 'deterministic');
  assert.equal(storedMessage().analysisVersion, '', 'a rule-based result never claims a model version');
  env.GEMINI_API_KEY = 'test-gemini-key';
  const model = modelStub(greeting);
  await syncInbox('user-a', 'user-a', env);
  assert.equal(model.calls, 1);
  assert.equal(storedMessage().classificationSource, 'ai');
});

void test('enabling AI revisits fallback mail outside the incremental window', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  const provider = globalThis.fetch;
  const queries: string[] = [];
  // Gmail correctly excludes this older message from a two-day incremental query.
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/users/me/messages?') && !url.includes('labelIds=INBOX')&&!url.includes('labelIds=SENT')) {
      const query = new URL(url).searchParams.get('q') || '';
      queries.push(query);
      if (query.includes('newer_than:2d')) return Response.json({ messages: [] });
    }
    return provider(input, init);
  };
  env.GEMINI_API_KEY = 'test-gemini-key';
  const model = modelStub(greeting);
  await syncInbox('user-a', 'user-a', env);
  assert.ok(queries[0].includes('newer_than:2d'), 'one fallback message does not justify listing the whole mailbox');
  assert.equal(model.calls, 1, 'it is fetched by ID and sent to the model');
  assert.equal(storedMessage().classificationSource, 'ai');
  await syncInbox('user-a', 'user-a', env);
  assert.ok(queries[1].includes('newer_than:2d'), 'and refreshes stay incremental');
  assert.equal(model.calls, 1, 'already classified mail is not sent again');
});

void test('a prompt change re-lists the mailbox only when many messages still lack a model result', async () => {
  await seed();
  inbox = Array.from({ length: 60 }, (_, index) => ({ id: `older-${index}` }));
  await syncInbox('user-a', 'user-a', env);
  const provider = globalThis.fetch;
  const queries: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.includes('/users/me/messages?') && !url.includes('labelIds=INBOX')&&!url.includes('labelIds=SENT')) queries.push(new URL(url).searchParams.get('q') || '');
    return provider(input, init);
  };
  env.GEMINI_API_KEY = 'test-gemini-key';
  const model = modelStub(greeting);
  await syncInbox('user-a', 'user-a', env);
  assert.ok(!queries[0].includes('newer_than'), 'sixty stand-ins are reached in one full pass');
  assert.equal(storage.sql.prepare("SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=? AND json_extract(data,'$.classificationSource')='ai'").get('user-a')?.n, 60);
  // Everything now has a model result. A new prompt version must not download it all again.
  env.GEMINI_MODEL = 'gemini-next';
  const calls = model.calls;
  await syncInbox('user-a', 'user-a', env);
  assert.ok(queries[1].includes('newer_than:2d'), 'a prompt or model change alone stays incremental');
  assert.equal(model.calls, calls+1, 'eight stale model results are refreshed in one batch');
  assert.equal(storage.sql.prepare("SELECT COUNT(*) AS n FROM mailbox_messages WHERE json_extract(data,'$.analysisVersion')=?").get(analysisVersion(env))?.n,8);
  assert.equal((row('connections') as { model_backfill_version: string }).model_backfill_version, 'gemini:gemini-next:' + (row('connections') as { model_backfill_version: string }).model_backfill_version.split(':').slice(2).join(':'), 'the new version is recorded');
});

void test('a rule upgrade keeps a request only the model recognised', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  await seed();
  const body = 'Would you mind taking a look at the proposal and sending your decision today?';
  inbox = [{ id: 'message', headers: [] }];
  const model = modelStub((ids) => ids.map((id) => ({ id, context: 'work', topics: [], disposition: 'useful', replyRequired: true,
    securityEvent: false, reason: 'Direct decision request', summary: 'Review proposal',
    obligations: [{ kind: 'request', description: 'Review proposal', owner: 'recipient', ownerIsUser: 'yes', required: true,
      evidence: body, state: 'open', datePhrase: 'today' }] })));
  const provider = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await provider(input, init);
    if (!requestUrl(input).includes('/messages/message?')) return response;
    const message = await response.json() as { payload: { body: { data: string } } };
    message.payload.body.data = encode(body);
    return Response.json(message);
  };
  await syncInbox('user-a', 'user-a', env);
  assert.equal(storedMessage().automaticClassification.obligations.length, 1);

  // Pretend the result was produced under older rules, with a demotion those rules made.
  const data = storedMessage() as unknown as Record<string, unknown> & { automaticClassification: Record<string, unknown> & { obligations: Record<string, unknown>[] } };
  const obligations = data.automaticClassification.obligations.map((o) => ({ ...o, required: false, commercial: true,
    uncertainty: 'Optional commercial call to action.' }));
  storage.sql.prepare('UPDATE mailbox_messages SET data=? WHERE message_id=?').run(JSON.stringify({ ...data,
    analysisVersion: analysisVersion(env),
    automaticClassification: { ...data.automaticClassification, obligations, version: 'policy-2026-09-22-1' } }), 'message');
  await syncInbox('user-a', 'user-a', env);
  assert.equal(model.calls, 1, 'no second model call');
  const after = storedMessage();
  assert.equal(after.automaticClassification.obligations.length, 1, 'the request survives');
  assert.equal(after.automaticClassification.obligations[0].required, true, 'an old demotion is re-decided, and this is not selling');
  assert.equal(after.automaticClassification.replyRequired, true);
  assert.equal(after.classificationSource, 'ai');
});

// ── Audit 2026-09-29, section 9: legacy reply state ─────────────────────────────

void test('a reply sent before the replied marker existed keeps its badge cleared', async () => {
  await seed();
  const classification = { context: 'work', topics: [], obligations: [{ id: 'r', kind: 'request', description: 'Review', owner: 'recipient',
    ownerIsUser: true, required: true, evidence: 'Please review', state: 'open' }], disposition: 'useful', replyRequired: true,
  securityEvent: false, processingStatus: 'classified', reason: 'request', version: 'older' };
  const answered = { id: 'old-sent', sender: 'Client', address: 'client@example.com', subject: 'Review', body: 'Please review', summary: 'Review',
    needsReply: false, category: 'work', priority: 'normal', classification, automaticClassification: classification };
  const waiting = { ...answered, id: 'still-waiting', needsReply: true };
  storage.sql.prepare('UPDATE snapshots SET data=?').run(JSON.stringify({ emails: [answered, waiting], updated: Date.now(), ai: false, pending: 0, skipped: 0 }));
  const result = await (await mailbox(mailboxRequest('user-a'))).json() as { emails: { id: string; needsReply: boolean }[] };
  assert.equal(result.emails.find((e) => e.id === 'old-sent')?.needsReply, false, 'the legacy send is honoured');
  assert.equal(result.emails.find((e) => e.id === 'still-waiting')?.needsReply, true, 'an unanswered one is not hidden');

  // Importing the snapshot records the send in the column, so a sync rewriting the row keeps it.
  inbox = [{ id: 'old-sent' }];
  await syncInbox('user-a', 'user-a', env);
  const stored = storage.sql.prepare('SELECT replied FROM mailbox_messages WHERE message_id=?').get('old-sent') as { replied: number } | undefined;
  assert.equal(stored?.replied, 1);
});

void test('a stored row showing an earlier send reads as answered even before the migration marks it', async () => {
  await seed();
  const data = (id: string, needsReply: boolean) => JSON.stringify({ id, sender: 'Client', address: 'client@example.com', subject: 'Review',
    body: 'Please review', summary: 'Review', needsReply, category: 'work', priority: 'normal', classification: { replyRequired: true } });
  const insert = storage.sql.prepare('INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,0,?,0)');
  insert.run('user-a', 'user-a', 'sent-row', data('sent-row', false), 'g');
  insert.run('user-a', 'user-a', 'open-row', data('open-row', true), 'g');
  const rows = await loadMessages('user-a', 'user-a', env);
  assert.equal(rows.find((e) => e.id === 'sent-row')?.replied, true);
  assert.equal(rows.find((e) => e.id === 'open-row')?.replied, undefined);
});

void test('the migration records earlier sends in the replied column', () => {
  const statement = readFileSync('drizzle/0018_legacy_unsubscribe_guard.sql', 'utf8').split('--> statement-breakpoint').at(-1)!;
  const data = (needsReply: boolean, replyRequired: boolean) => JSON.stringify({ needsReply, classification: { replyRequired } });
  const insert = storage.sql.prepare('INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,0,?,0)');
  insert.run('user-a', 'acct', 'sent', data(false, true), 'g');
  insert.run('user-a', 'acct', 'waiting', data(true, true), 'g');
  insert.run('user-a', 'acct', 'nothing-owed', data(false, false), 'g');
  storage.sql.exec(statement);
  const replied = (id: string) => (storage.sql.prepare('SELECT replied FROM mailbox_messages WHERE message_id=?').get(id) as { replied: number }).replied;
  assert.deepEqual([replied('sent'), replied('waiting'), replied('nothing-owed')], [1, 0, 0]);
});

void test('a damaged stored record is not mistaken for an answered one', async () => {
  await seed();
  const classification = { replyRequired: true };
  storage.sql.prepare('UPDATE snapshots SET data=?').run(JSON.stringify({ emails: [{ id: 'damaged', classification }], updated: Date.now(), ai: false }));
  const insert = storage.sql.prepare('INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,0,?,0)');
  insert.run('user-a', 'user-a', 'damaged-row', JSON.stringify({ id: 'damaged-row', classification }), 'g');
  const rows = await loadMessages('user-a', 'user-a', env);
  assert.equal(rows.find((e) => e.id === 'damaged-row')?.replied, undefined, 'a missing badge is not a cleared one');
  assert.equal(snapshotSentIds(JSON.stringify({ emails: [{ id: 'damaged', classification }] })).size, 0);
});

void test('a recovery requested while a recovery scan runs survives that scan', async () => {
  await seed();
  storage.sql.prepare('UPDATE connections SET recovery_needed=1').run();
  const original = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async (input, init) => {
    // An older instance unsubscribes while this scan is between its start and completion.
    if (!requested && requestUrl(input).includes('/messages?maxResults')) { requested = true; olderInstanceUnsubscribes(); }
    return original(input, init);
  };
  await syncInbox('user-a', 'user-a', env);
  assert.equal(row('connections')!.recovery_needed, 1, 'the new request is still outstanding');
  globalThis.fetch = original;
  await syncInbox('user-a', 'user-a', env);
  assert.equal(row('connections')!.recovery_needed, 0);
  assert.equal((storage.sql.prepare('SELECT COUNT(*) AS n FROM legacy_unsubscribe_guards').get() as { n: number }).n, 0);
});

void test('a model result stored before the source field existed is still treated as the model’s', async () => {
  env.GEMINI_API_KEY = 'test-gemini-key';
  await seed();
  modelStub((ids) => ids.map((id) => ({ id, context: 'work', topics: [], disposition: 'useful', replyRequired: true, securityEvent: false,
    reason: 'Direct request', summary: 'Hello', obligations: [{ kind: 'request', description: 'Reply', owner: 'recipient', ownerIsUser: 'yes',
      required: true, evidence: 'Hello', state: 'open' }] })));
  await syncInbox('user-a', 'user-a', env);
  const data = storedMessage() as unknown as Record<string, unknown> & { automaticClassification: Record<string, unknown> };
  delete data.classificationSource;
  storage.sql.prepare('UPDATE mailbox_messages SET data=? WHERE message_id=?').run(JSON.stringify({ ...data,
    automaticClassification: { ...data.automaticClassification, version: 'policy-2026-09-22-1' } }), 'message');
  delete env.GEMINI_API_KEY;
  await syncInbox('user-a', 'user-a', env);
  assert.equal(storedMessage().classificationSource, 'ai');
  assert.equal(storedMessage().automaticClassification.obligations.length, 1, 'the model’s request is not replaced by the rule-based result');
});

// ── Reply state through sends, refreshes, upgrades and accounts ──────────────

/** Gmail serves `body` as the message text, and accepts drafts and sends. */
function gmailWithBody(body: string, outcome: { send: 'ok' | 'refused' } = { send: 'ok' }) {
  const provider = globalThis.fetch;
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith('/messages/send')) {
      if (outcome.send === 'refused') return new Response('bad request', { status: 400 });
      sent.push(url); return Response.json({ id: 'sent-' + sent.length });
    }
    if (url.endsWith('/drafts')) return Response.json({ id: 'draft-1' });
    const response = await provider(input, init);
    if (!/\/messages\/[^/?]+\?format=full/.test(url)) return response;
    const message = await response.json() as { payload: { body: { data: string } } };
    message.payload.body.data = encode(body);
    return Response.json(message);
  };
  return { sent, restore: () => { globalThis.fetch = provider; } };
}
const replyAs = (action: 'draft' | 'send', accountId = 'user-a', id = 'message') => replyRoute(new Request(`${env.APP_URL}/api/reply`, {
  method: 'POST', headers: { origin: env.APP_URL!, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, accountId, action, body: `Reply ${action} ${Math.random()}` }) }));
async function needsReply(accountId = 'user-a', id = 'message') {
  const view = await (await mailbox(mailboxRequest(accountId))).json() as { emails: { id: string; needsReply: boolean; replied?: boolean }[] };
  return view.emails.find((email) => email.id === id);
}

void test('a draft or a refused send leaves the reply pending; a send clears it through later refreshes', async () => {
  await seed();
  inbox = [{ id: 'message', headers: [] }];
  const gmail = gmailWithBody('Could you send the signed contract by Friday?');
  await syncInbox('user-a', 'user-a', env);
  assert.equal((await needsReply())?.needsReply, true);
  assert.equal((await replyAs('draft')).status, 200);
  assert.equal((await needsReply())?.needsReply, true, 'saving a draft is not replying');
  gmail.restore();
  const refused = gmailWithBody('Could you send the signed contract by Friday?', { send: 'refused' });
  assert.notEqual((await replyAs('send')).status, 200);
  assert.equal((await needsReply())?.needsReply, true, 'a refused send is not a reply');
  refused.restore();
  gmailWithBody('Could you send the signed contract by Friday?');
  assert.equal((await replyAs('send')).status, 200);
  assert.equal((await needsReply())?.needsReply, false);
  await syncInbox('user-a', 'user-a', env);
  assert.equal((await needsReply())?.needsReply, false, 'a refresh keeps the recorded send');
});

void test('answering a conversation clears earlier requests but leaves later ones open', async () => {
  await seed();
  for(const [id,at] of [['old',100],['answered',200],['later',300]] as const)
    storage.sql.prepare('INSERT INTO mailbox_messages (user_id,account_id,message_id,data,received_at,scan_generation,replied) VALUES (?,?,?,?,?,?,0)')
      .run('user-a','user-a',id,JSON.stringify({id,threadId:'same-thread',needsReply:true}),at,'test');
  assert.equal(await markMessageReplied('user-a','user-a','answered',env),true);
  const rows=storage.sql.prepare('SELECT message_id,replied FROM mailbox_messages ORDER BY received_at').all() as {message_id:string;replied:number}[];
  assert.deepEqual(rows.map(row=>[row.message_id,row.replied]),[['old',1],['answered',1],['later',0]]);
});

void test('a reply written in Gmail clears earlier requests but leaves later mail open', async () => {
  await seed();
  const start=Date.now()-3600000;
  inbox=[
    {id:'old',threadId:'conversation',receivedAt:start,body:'Please reply with your availability.'},
    {id:'latest',threadId:'conversation',receivedAt:start+60000,body:'Please reply with your decision.'},
  ];
  sentThreads.conversation=[{labelIds:['SENT'],internalDate:String(start+30000)}];
  await syncInbox('user-a','user-a',env);
  assert.equal((await needsReply('user-a','old'))?.needsReply,false);
  assert.equal((await needsReply('user-a','latest'))?.needsReply,true);
  sentThreads.conversation.push({labelIds:['SENT'],internalDate:String(start+120000)});
  storage.sql.prepare("UPDATE mailbox_messages SET data=json_set(data,'$.replyCheckedAt',0) WHERE account_id=?").run('user-a');
  await syncInbox('user-a','user-a',env);
  assert.equal((await needsReply('user-a','latest'))?.needsReply,false);
  assert.equal(storage.sql.prepare("SELECT COUNT(*) AS n FROM mailbox_messages WHERE account_id=? AND replied=1").get('user-a')?.n,2);
  assert.equal(requests.filter(request=>request.url.includes('/threads/conversation?format=metadata')).length,2);
});

void test('marking a conversation answered clears older requests and undo restores them', async () => {
  await seed();
  const start=Date.now()-3600000;
  inbox=[
    {id:'old',threadId:'conversation',receivedAt:start,body:'Please reply with your availability.'},
    {id:'latest',threadId:'conversation',receivedAt:start+60000,body:'Please reply with your decision.'},
  ];
  await syncInbox('user-a','user-a',env);
  assert.equal((await needsReply('user-a','old'))?.needsReply,true);
  const correct=(revision:number,type:'set-reply-preference'|'clear-reply-preference')=>classificationRoute(new Request(`${env.APP_URL}/api/classification`,{
    method:'POST',headers:{origin:env.APP_URL!,'Content-Type':'application/json'},
    body:JSON.stringify({messageId:'latest',accountId:'user-a',expectedRevision:revision,action:type==='set-reply-preference'?{type,value:'answered'}:{type}})}));
  assert.equal((await correct(0,'set-reply-preference')).status,200);
  assert.equal((await needsReply('user-a','old'))?.needsReply,false);
  assert.equal((await needsReply('user-a','latest'))?.needsReply,false);
  assert.equal((await correct(1,'clear-reply-preference')).status,200);
  assert.equal((await needsReply('user-a','old'))?.needsReply,true);
  assert.equal((await needsReply('user-a','latest'))?.needsReply,true);
});

void test('a deliberate second reply with identical wording sends again', async () => {
  await seed();
  inbox=[{id:'message',headers:[]}];
  const provider=gmailWithBody('Can you confirm?');
  const send=(sendKey:string)=>replyRoute(new Request(`${env.APP_URL}/api/reply`,{
    method:'POST',headers:{origin:env.APP_URL!,'Content-Type':'application/json'},
    body:JSON.stringify({id:'message',accountId:'user-a',action:'send',body:'Thanks!',sendKey})}));
  try{
    assert.equal((await send('first-reply-key')).status,200);
    assert.equal((await send('first-reply-key')).status,200,'a retry reuses the first receipt');
    assert.equal((await send('second-reply-key')).status,200);
    assert.equal(provider.sent.length,2);
  }finally{provider.restore();}
});

void test('a model result that lands after the reply was sent cannot restore the badge', async () => {
  await seed();
  inbox = [{ id: 'message', headers: [] }];
  gmailWithBody('Could you confirm the venue for Thursday?');
  await syncInbox('user-a', 'user-a', env);
  env.GEMINI_API_KEY = 'test-gemini-key';
  const answer = deferred();
  const started = deferred();
  const provider = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!requestUrl(input).startsWith('https://generativelanguage.googleapis.com/')) return provider(input, init);
    started.resolve();
    await answer.promise;
    const items = [{ id: 'message', context: 'work', topics: [], disposition: 'useful', replyRequired: true, securityEvent: false,
      reason: 'Venue question', summary: 'Venue question',
      reply: { status: 'required', urgency: 'prompt', channel: 'email', reasonCode: 'information_requested', evidence: 'Could you confirm the venue for Thursday?', explanation: 'Jordan needs the venue.' },
      obligations: [{ kind: 'request', description: 'Confirm venue', owner: 'recipient', ownerIsUser: 'yes', required: true, evidence: 'Could you confirm the venue for Thursday?', state: 'open' }] }];
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ items }) }] }, finishReason: 'STOP' }] });
  };
  const sync = syncInbox('user-a', 'user-a', env);
  await started.promise;
  assert.equal((await replyAs('send')).status, 200, 'the reply is sent while classification is still running');
  answer.resolve();
  await sync;
  assert.equal((await needsReply())?.needsReply, false);
  assert.equal((await needsReply())?.replied, true);
});

void test('a policy upgrade re-decides stored mail without inventing a send', async () => {
  await seed();
  inbox = [{ id: 'message', headers: [] }];
  gmailWithBody('My timesheet is ready in the time-tracking portal.\nPlease approve it there before Thursday.');
  await syncInbox('user-a', 'user-a', env);
  // Pretend the row was written by the previous policy, which put portal approvals in the tab.
  const row = storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?').get('message') as { data: string };
  const data = JSON.parse(row.data) as Record<string, unknown> & { automaticClassification: Record<string, unknown>; classification: Record<string, unknown> };
  const older = { ...data.automaticClassification, replyRequired: true, reply: undefined, version: 'policy-2026-09-29-audit-fixes:deterministic' };
  storage.sql.prepare('UPDATE mailbox_messages SET data=? WHERE message_id=?').run(JSON.stringify({ ...data, needsReply: true,
    automaticClassification: older, classification: { ...data.classification, replyRequired: true, reply: undefined } }), 'message');
  assert.equal((await needsReply())?.needsReply, true, 'before the rescan the old decision is still shown');
  await syncInbox('user-a', 'user-a', env);
  const after = await needsReply();
  assert.equal(after?.needsReply, false, 'the new policy reaches the stored message');
  assert.notEqual(after?.replied, true, 'and the change is not mistaken for a sent reply');
  assert.equal((storage.sql.prepare('SELECT replied FROM mailbox_messages WHERE message_id=?').get('message') as { replied: number }).replied, 0);
});

void test('the same Gmail id in two mailboxes keeps separate reply state', async () => {
  await seed('user-a', 'a@example.com', 0, 'acct-1');
  await seed('user-a', 'b@example.com', 0, 'acct-2');
  inbox = [{ id: 'message', headers: [] }];
  gmailWithBody('Could you confirm the delivery address?');
  await syncInbox('user-a', 'acct-1', env);
  await syncInbox('user-a', 'acct-2', env);
  assert.equal((await replyAs('send', 'acct-1')).status, 200);
  assert.equal((await needsReply('acct-1'))?.needsReply, false);
  assert.equal((await needsReply('acct-2'))?.needsReply, true, 'answering one mailbox’s copy is not answering the other');
});

void test('a first page of large newsletters still refreshes: the snapshot keeps a slim copy', async () => {
  await seed();
  // D1 refuses any single value over about 2 MB. Forty 60 KB newsletters are 2.4 MB of HTML.
  inbox = Array.from({ length: 40 }, (_, index) => ({ id: `news-${index}` }));
  const provider = globalThis.fetch;
  const html = `<table><tr><td>${'Weekly roundup. '.repeat(3750)}</td></tr></table>`;
  globalThis.fetch = async (input, init) => {
    const response = await provider(input, init);
    if (!/\/messages\/[^/?]+\?format=full/.test(requestUrl(input))) return response;
    const message = await response.json() as { payload: { mimeType: string; body: { data: string } } };
    message.payload.mimeType = 'text/html';
    message.payload.body.data = encode(html);
    return Response.json(message);
  };
  const result = await syncInbox('user-a', 'user-a', env);
  assert.equal(result.emails.length, 40, 'every message is returned in full');
  assert.ok(result.emails.every((email) => email.html === html), 'the response keeps each message’s HTML');
  const stored = storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get('user-a') as { data: string };
  assert.ok(new TextEncoder().encode(stored.data).byteLength < 1_000_000, 'the snapshot stays well under the 2 MB value limit');
  const snapshot = JSON.parse(stored.data) as { emails: { html?: string; body: string }[] };
  assert.equal(snapshot.emails.length, 40);
  assert.ok(snapshot.emails.every((email) => email.html === undefined && email.body === ''), 'text and HTML live only in the message rows');
  const row = storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?').get('news-0') as { data: string };
  assert.equal((JSON.parse(row.data) as { html?: string }).html, html, 'each message row keeps its full content');
  const view = await (await mailbox(mailboxRequest('user-a'))).json() as { emails: { html?: string }[] };
  assert.ok(view.emails.length === 40 && view.emails.every((email) => email.html === html), 'the inbox still shows full messages');
});

void test('Gmail saying "slow down" is retried, never reported as a broken connection', async () => {
  await seed();
  inbox = [{ id: 'message' }];
  const provider = globalThis.fetch;
  let refusals = 0;
  globalThis.fetch = async (input, init) => {
    // Gmail reports its per-user rate limit as a 403 with this reason.
    if (/\/messages\/message\?format=full/.test(requestUrl(input)) && refusals < 2) {
      refusals++;
      return Response.json({ error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403, headers: { 'retry-after': '0' } });
    }
    return provider(input, init);
  };
  const result = await syncInbox('user-a', 'user-a', env);
  assert.equal(refusals, 2);
  assert.equal(result.skipped, 0, 'the message arrived after the pause');
  assert.ok(result.emails.some((email) => email.id === 'message'));
  assert.equal((row('connections') as { error: string | null }).error, null, 'nobody is told to reconnect');
});

void test('a message Gmail was too busy to hand over arrives on the next refresh', async () => {
  await seed();
  inbox = [{ id: 'calm' }, { id: 'busy' }];
  const provider = globalThis.fetch;
  let busy = true;
  globalThis.fetch = async (input, init) => {
    if (busy && /\/messages\/busy\?format=full/.test(requestUrl(input)))
      return new Response('{"error":{"code":429}}', { status: 429, headers: { 'retry-after': '0' } });
    return provider(input, init);
  };
  const first = await syncInbox('user-a', 'user-a', env);
  assert.equal(first.skipped, 0, 'a busy message is queued, not written off as unreadable');
  assert.ok(!first.emails.some((email) => email.id === 'busy'));
  // Gmail recovers, and the next listing no longer includes the message (for example an
  // incremental refresh that cannot see it). It is still fetched by ID.
  busy = false;
  inbox = [{ id: 'calm' }, { id: 'busy' }];
  const listOnlyCalm = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input).includes('/users/me/messages?maxResults=100&q=')) return Response.json({ messages: [{ id: 'calm' }] });
    return listOnlyCalm(input, init);
  };
  const second = await syncInbox('user-a', 'user-a', env);
  assert.ok(second.emails.some((email) => email.id === 'busy'), 'the queued message is fetched by ID');
  const snapshot = JSON.parse((storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get('user-a') as { data: string }).data) as { fetchRetry?: unknown[] };
  assert.equal(snapshot.fetchRetry, undefined, 'and leaves the retry queue');
});

void test('sending is never retried automatically, even when Gmail is busy', async () => {
  await seed();
  await syncInbox('user-a', 'user-a', env);
  const provider = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (input, init) => {
    if (requestUrl(input).endsWith('/messages/send')) { sends++; return new Response('{}', { status: 503 }); }
    return provider(input, init);
  };
  const response = await replyAs('send');
  assert.notEqual(response.status, 200);
  assert.equal(sends, 1, 'one attempt only; the person confirms in Gmail before any retry');
});

void test('correcting an earlier message keeps the conversation’s "I already replied" mark', async () => {
  await seed();
  const start=Date.now()-3600000;
  inbox=[
    {id:'old',threadId:'conversation',receivedAt:start,body:'Please reply with your availability.'},
    {id:'latest',threadId:'conversation',receivedAt:start+60000,body:'Please reply with your decision.'},
  ];
  await syncInbox('user-a','user-a',env);
  const correct=(messageId:string,revision:number,action:Record<string,unknown>)=>classificationRoute(new Request(`${env.APP_URL}/api/classification`,{
    method:'POST',headers:{origin:env.APP_URL!,'Content-Type':'application/json'},
    body:JSON.stringify({messageId,accountId:'user-a',expectedRevision:revision,expectedSenderRevision:0,action})}));
  assert.equal((await correct('latest',0,{type:'set-reply-preference',value:'answered'})).status,200);
  const response=await correct('old',0,{type:'set-section',section:'work'});
  assert.equal(response.status,200);
  const body=await response.json() as {email:{needsReply:boolean;manualThreadAnswered?:boolean}};
  assert.equal(body.email.needsReply,false,'the correction response agrees with the mailbox');
  assert.equal(body.email.manualThreadAnswered,true);
  const later=await correct('latest',1,{type:'clear-reply-preference'});
  assert.equal(later.status,200);
  const reopened=await correct('old',1,{type:'clear-section'});
  assert.equal((await reopened.json() as {email:{needsReply:boolean}}).email.needsReply,true,'undoing the mark reopens it');
});
