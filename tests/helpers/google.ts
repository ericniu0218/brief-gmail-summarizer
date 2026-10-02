import { database } from '../database';
import { encode, encrypt, type Runtime } from '../../server/runtime';

/**
 * Test double for everything the app calls outside itself: a real-schema database built from the
 * committed migrations, a signed-in user, and a fake Google and Gemini that record each request.
 */
export const origin = 'https://brief.example';
const SCOPES = ['readonly', 'send', 'compose'].map((s) => 'https://www.googleapis.com/auth/gmail.' + s).join(' ');
/** The union of what the app sends: a Gmail JSON body or a Gemini request. A test reads only the fields that apply. */
export type Body = { raw: string; threadId?: string; systemInstruction: { parts: { text: string }[] }; contents: { parts: { text: string }[] }[] };
/** `body` is present only for JSON requests; uploads carry their message in `text`. */
export type Call = { url: string; body: Body; text?: string; contentType?: string };
export type Behavior = { tokenStatus: number; sendStatus: number; geminiStatus: number };
export type Rig = ReturnType<typeof rig>;

export function rig(options: { geminiKey?: boolean; env?: Partial<Runtime> } = {}) {
  const storage = database();
  const env: Runtime = {
    DB: storage.db, APP_URL: origin, GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret',
    TOKEN_ENCRYPTION_KEY: encode(crypto.getRandomValues(new Uint8Array(32))),
    ...(options.geminiKey ? { GEMINI_API_KEY: 'test-gemini-key' } : {}), ...options.env,
  };
  globalThis.__briefTestEnv = env;
  signIn('user-a');
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const behavior: Behavior = { tokenStatus: 200, sendStatus: 200, geminiStatus: 200 };
  /** What Gmail holds, by message id. */
  const messages: Record<string, object> = {};
  /** Answers Gemini; receives the parsed request body. */
  const gemini: { reply?: (request: Body) => object } = {};
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    let body: Body | undefined; try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    calls.push({ url, body: body as Body, text: typeof init?.body === 'string' ? init.body : undefined, contentType: new Headers(init?.headers).get('content-type') || undefined });
    if (url.includes('oauth2.googleapis.com/revoke')) return Response.json({});
    if (url.includes('oauth2.googleapis.com/token')) {
      if (behavior.tokenStatus !== 200) return new Response('{}', { status: behavior.tokenStatus });
      return Response.json({ access_token: 'access-token', refresh_token: 'refresh-token', scope: SCOPES });
    }
    if (url.includes('messages/send') || url.includes('/drafts')) {
      if (behavior.sendStatus !== 200) return new Response('{}', { status: behavior.sendStatus });
      return Response.json({ id: 'gmail-' + calls.length, threadId: 'thread-new' });
    }
    if (url.includes('/users/me/messages?maxResults=')) return Response.json({ messages: Object.keys(messages).map((id) => ({ id })) });
    const wanted = /\/users\/me\/messages\/([^?/]+)\?format=full/.exec(url)?.[1];
    if (wanted && messages[decodeURIComponent(wanted)]) return Response.json(messages[decodeURIComponent(wanted)]);
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      if (behavior.geminiStatus !== 200) return new Response('{}', { status: behavior.geminiStatus });
      const reply = gemini.reply?.(body as Body) ?? {};
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(reply) }] } }] });
    }
    throw new Error('Unexpected request ' + url);
  };
  return {
    storage, env, calls, behavior, messages, gemini,
    restore() { globalThis.fetch = original; globalThis.__briefTestHeaders = new Headers(); },
  };
}

export function signIn(user: string) {
  globalThis.__briefTestHeaders = new Headers({ 'oai-authenticated-user-id': user, 'oai-authenticated-user-email': user + '@example.com' });
}
export async function connect(r: Rig, user: string, account: string, email = account + '@gmail.example') {
  const token = await encrypt('refresh-token', user, r.env, account);
  r.storage.sql.prepare('INSERT INTO connections (id,user_id,provider_identity,email,token,token_version,last_sync,sync_lock,error,created) VALUES (?,?,NULL,?,?,2,123,0,NULL,123)').run(account, user, email, token);
  r.storage.sql.prepare('INSERT INTO account_preferences (user_id,default_account_id) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING').run(user, account);
}
export const post = (path: string, body: unknown) =>
  new Request(origin + path, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8');
export const headerBlock = (mime: string) => mime.split('\r\n\r\n')[0];
/** The calls that sent or uploaded a message to Gmail (not drafts). */
export const sends = (calls: Call[]) => calls.filter((c) => c.url.includes('messages/send'));
/** A message in the shape Gmail returns, readable by the app's own normalizer. */
export function gmailMessage(m: { id: string; from: string; to?: string; cc?: string; subject?: string; body?: string; replyTo?: string; receivedAt?: number }) {
  const headers = [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject || 'Hello' }, { name: 'Message-ID', value: `<${m.id}@orig.example>` }];
  if (m.to) headers.push({ name: 'To', value: m.to });
  if (m.cc) headers.push({ name: 'Cc', value: m.cc });
  if (m.replyTo) headers.push({ name: 'Reply-To', value: m.replyTo });
  return { id: m.id, threadId: 'thread-' + m.id, snippet: (m.body || 'Hi').slice(0, 100), internalDate: String(m.receivedAt ?? Date.now() - 3600000), labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers, body: { data: encode(m.body || 'Hi') } } };
}
