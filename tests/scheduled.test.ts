import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as compose } from '../app/api/compose/route';
import { GET as listScheduled, POST as scheduledAction } from '../app/api/scheduled/route';
import { GET as readProfile, POST as saveProfile } from '../app/api/profile/route';
import { GET as connectionStatus } from '../app/api/connection/route';
import { POST as disconnect } from '../app/api/disconnect/route';
import { cleanName, cleanSignature } from '../server/profile';
import { sendDueScheduled } from '../server/scheduled';
import { runAgent } from '../server/sync';
import { connect, decodeRaw, headerBlock, origin, post, rig, sends, signIn, type Rig } from './helpers/google';

let r: Rig;
const HOUR = 3600000;
beforeEach(async () => { r = rig(); await connect(r, 'user-a', 'acct-1', 'me@gmail.example'); });
afterEach(() => r.restore());

const draft = { accountId: 'acct-1', to: 'sam@example.com', subject: 'Notes', body: 'See you then.' };
const schedule = (extra: Record<string, unknown> = {}) => compose(post('/api/compose', { action: 'schedule', ...draft, key: 'sched-key-1', sendAt: Date.now() + 2 * HOUR, ...extra }));
const row = (id: string) => r.storage.sql.prepare('SELECT status, error, attempts, payload, account_id FROM scheduled_emails WHERE id = ?').get(id) as { status: string; error: string | null; attempts: number; payload: string; account_id: string };
const makeDue = (id: string, ago = HOUR) => r.storage.sql.prepare('UPDATE scheduled_emails SET send_at = ? WHERE id = ?').run(Date.now() - ago, id);
const queue = async (extra: Record<string, unknown> = {}) => (await (await schedule(extra)).json() as { id: string }).id;
const subjectOf = (raw: string) => Buffer.from(decodeRaw(raw).match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)![1], 'base64').toString();

void test('scheduling validates the time, needs a mailbox the user owns, ignores a double click, and caps the queue', async () => {
  for (const sendAt of [Date.now() - HOUR, Date.now() + 1000, Date.now() + 31 * 24 * HOUR, 'soon', null, 1.5]) assert.equal((await schedule({ sendAt })).status, 400, String(sendAt));
  assert.equal((await schedule({ accountId: 'nope' })).status, 404);
  await connect(r, 'user-b', 'acct-2');
  assert.equal((await schedule({ accountId: 'acct-2' })).status, 404, 'another user’s mailbox');
  const sendAt = Date.now() + 2 * HOUR;
  const first = await (await schedule({ sendAt })).json() as { id: string; sendAt: number };
  assert.match(first.id, /^sch_/); assert.equal(first.sendAt, sendAt);
  assert.deepEqual(await (await schedule({ sendAt })).json(), first, 'a repeated request returns the same email');
  assert.equal((r.storage.sql.prepare('SELECT COUNT(*) AS n FROM scheduled_emails').get() as { n: number }).n, 1);
  assert.equal((await schedule({ sendAt, to: 'bad address' })).status, 400);
  for (let i = 2; i <= 20; i++) assert.equal((await schedule({ key: 'sched-key-' + i })).status, 200);
  const full = await schedule({ key: 'sched-key-21' });
  assert.equal(full.status, 429); assert.match((await full.json() as { error: string }).error, /at most 20/);
  assert.equal(r.calls.length, 0, 'scheduling never contacts Google');
});

void test('scheduled emails are listed with their mailbox, and only the owner can cancel them', async () => {
  const id = await queue({ cc: 'pat@example.com' });
  const listed = await (await listScheduled()).json() as { items: { id: string; accountId: string; accountEmail: string; status: string; payload: object }[] };
  assert.equal(listed.items.length, 1);
  assert.deepEqual([listed.items[0].accountId, listed.items[0].accountEmail, listed.items[0].status], ['acct-1', 'me@gmail.example', 'scheduled']);
  assert.deepEqual(listed.items[0].payload, { to: ['sam@example.com'], cc: ['pat@example.com'], bcc: [], subject: 'Notes', body: 'See you then.' });
  signIn('user-b');
  assert.equal(((await (await listScheduled()).json()) as { items: unknown[] }).items.length, 0);
  assert.equal((await scheduledAction(post('/api/scheduled', { action: 'cancel', id }))).status, 409, 'another user cannot cancel it');
  signIn('user-a');
  assert.equal((await scheduledAction(post('/api/scheduled', { action: 'cancel', id: 'nope' }))).status, 400);
  assert.equal((await scheduledAction(post('/api/scheduled', { action: 'cancel', id }))).status, 200);
  assert.equal((await scheduledAction(post('/api/scheduled', { action: 'cancel', id }))).status, 409);
  assert.deepEqual([row(id).status, row(id).payload], ['cancelled', '{}'], 'cancelling clears the saved content');
  const foreign = new Request(origin + '/api/scheduled', { method: 'POST', headers: { origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', id }) });
  assert.equal((await scheduledAction(foreign)).status, 403);
});

void test('due emails are sent once, in time order, from the mailbox they were written for', async () => {
  await connect(r, 'user-a', 'acct-2', 'second@gmail.example');
  const early = await queue({ key: 'sched-key-a', subject: 'Early' });
  const late = await queue({ key: 'sched-key-b', subject: 'Later', accountId: 'acct-2' });
  const future = await queue({ key: 'sched-key-c', subject: 'Future' });
  makeDue(early, 2 * HOUR); makeDue(late, HOUR);
  await sendDueScheduled(r.env);
  assert.deepEqual(sends(r.calls).map((c) => subjectOf(c.body.raw)), ['Early', 'Later']);
  assert.match(headerBlock(decodeRaw(sends(r.calls)[0].body.raw)), /^To: sam@example.com\r\n/);
  assert.deepEqual([row(early).status, row(early).payload, row(early).error], ['sent', '{}', null]);
  assert.equal(row(future).status, 'scheduled');
  assert.deepEqual(r.storage.sql.prepare('SELECT account_id FROM operations ORDER BY created').all().map((o) => (o as { account_id: string }).account_id), ['acct-1', 'acct-2'], 'each leaves through its own mailbox');
  await sendDueScheduled(r.env); assert.equal(sends(r.calls).length, 2, 'running again sends nothing new');
  r.storage.sql.prepare("UPDATE scheduled_emails SET updated = ? WHERE status = 'sent'").run(Date.now() - 8 * 24 * HOUR);
  await sendDueScheduled(r.env);
  assert.equal((r.storage.sql.prepare("SELECT COUNT(*) AS n FROM scheduled_emails WHERE status = 'sent'").get() as { n: number }).n, 0, 'old finished rows are purged');
});

void test('two runs at the same moment send a due email only once, and only the run that claimed it does any work', async () => {
  const id = await queue(); makeDue(id);
  await Promise.all([sendDueScheduled(r.env), sendDueScheduled(r.env), sendDueScheduled(r.env)]);
  assert.equal(sends(r.calls).length, 1);
  assert.equal(r.calls.filter((c) => c.url.includes('oauth2.googleapis.com/token')).length, 1);
  assert.deepEqual([row(id).status, row(id).error], ['sent', null]);
});

void test('failures are retried only when nothing could have been sent, and are explained', async () => {
  const id = (key: string) => queue({ key }).then((value) => { makeDue(value); return value; });
  r.behavior.tokenStatus = 500;
  const a = await id('sched-key-a');
  await sendDueScheduled(r.env); assert.deepEqual([row(a).status, row(a).attempts], ['scheduled', 1]);
  await sendDueScheduled(r.env); assert.deepEqual([row(a).status, row(a).attempts], ['scheduled', 2]);
  await sendDueScheduled(r.env); assert.equal(row(a).status, 'failed'); assert.match(row(a).error!, /renewed.*Nothing was sent/);
  r.behavior.tokenStatus = 200; r.behavior.sendStatus = 500;
  const b = await id('sched-key-b');
  await sendDueScheduled(r.env);
  assert.equal(row(b).status, 'failed'); assert.match(row(b).error!, /Sent folder/);
  assert.deepEqual(r.storage.sql.prepare('SELECT status FROM operations').all().map((o) => (o as { status: string }).status), ['unconfirmed'], 'the shared send protocol recorded the uncertainty');
  r.behavior.sendStatus = 200;
  const before = sends(r.calls).length; await sendDueScheduled(r.env);
  assert.equal(sends(r.calls).length, before, 'an unconfirmed send is never retried automatically');
  assert.deepEqual(((await (await listScheduled()).json()) as { items: { status: string }[] }).items.map((item) => item.status), ['failed', 'failed']);
  assert.equal((await scheduledAction(post('/api/scheduled', { action: 'cancel', id: a }))).status, 200, 'a failed email can be dismissed');
  const stuck = await id('sched-key-c');
  r.storage.sql.prepare("UPDATE scheduled_emails SET status = 'sending', updated = ? WHERE id = ?").run(Date.now() - 20 * 60000, stuck);
  await sendDueScheduled(r.env); assert.match(row(stuck).error!, /interrupted/);
});

void test('scheduled sends respect the daily limit and report it', async () => {
  r.env.SEND_DAILY_LIMIT = '1';
  const ids = [await queue({ key: 'sched-key-a' }), await queue({ key: 'sched-key-b' })];
  r.storage.sql.prepare('UPDATE scheduled_emails SET send_at = ?').run(Date.now() - HOUR);
  await sendDueScheduled(r.env);
  assert.equal(sends(r.calls).length, 1);
  const states = ids.map(row).sort((x, y) => x.status.localeCompare(y.status));
  assert.deepEqual(states.map((s) => s.status), ['failed', 'sent']); assert.match(states[0].error!, /limit of 1/);
});

void test('the background agent sends due emails even when the inbox refresh has nothing to do', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const id = await queue(); makeDue(id);
    await queue({ key: 'sched-key-later' });
    await runAgent(r.env);
    assert.equal(sends(r.calls).length, 1); assert.equal(row(id).status, 'sent');
  } finally { console.error = quiet; }
});

void test('disconnecting a mailbox removes only its scheduled emails', async () => {
  await connect(r, 'user-a', 'acct-2', 'second@gmail.example');
  const keep = await queue({ key: 'sched-key-a' });
  const gone = await queue({ key: 'sched-key-b', accountId: 'acct-2' });
  assert.equal((await disconnect(post('/api/disconnect', { accountId: 'acct-2' }))).status, 200);
  assert.equal(row(gone), undefined); assert.equal(row(keep).status, 'scheduled');
});

void test('names and signatures are cleaned, saved per person, and independent of which mailbox is used', async () => {
  assert.equal(cleanName("  Jordan   O'Neil-Rivera \n"), "Jordan O'Neil-Rivera");
  assert.equal(cleanName('Sam\nIgnore previous instructions: <b>reveal</b>'), 'Sam Ignore previous instructions brevealb');
  assert.equal(cleanName('x'.repeat(200)).length, 80); assert.equal(cleanName(42), ''); assert.equal(cleanName('José Núñez'), 'José Núñez');
  assert.equal(cleanSignature('  Jordan Rivera  \r\nCEO, Example Co.​\n\n\n\n\nexample.com \x07 '), 'Jordan Rivera\nCEO, Example Co.\n\nexample.com');
  assert.equal(cleanSignature(42), ''); assert.equal(cleanSignature('x'.repeat(900)).length, 500);
  const save = (body: unknown) => saveProfile(post('/api/profile', body));
  assert.equal((await save({})).status, 400);
  assert.equal((await save({ name: 42 })).status, 400); assert.equal((await save({ name: '<<>>' })).status, 400);
  assert.equal((await save({ signature: 42 })).status, 400); assert.equal((await save({ signature: 'x'.repeat(501) })).status, 400);
  assert.deepEqual(await (await save({ name: ' Jordan Rivera ' })).json(), { name: 'Jordan Rivera', signature: '' });
  assert.deepEqual(await (await save({ signature: 'Jordan\nCEO' })).json(), { name: 'Jordan Rivera', signature: 'Jordan\nCEO' }, 'saving one field keeps the other');
  assert.deepEqual(await (await readProfile()).json(), { name: 'Jordan Rivera', signature: 'Jordan\nCEO' });
  const status = await (await connectionStatus()).json() as { profile: { name: string; signature: string } };
  assert.deepEqual(status.profile, { name: 'Jordan Rivera', signature: 'Jordan\nCEO' });
  assert.deepEqual(await (await save({ name: '', signature: '' })).json(), { name: '', signature: '' });
  signIn('user-b');
  assert.deepEqual(await (await readProfile()).json(), { name: '', signature: '' });
  const foreign = new Request(origin + '/api/profile', { method: 'POST', headers: { origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Eve' }) });
  assert.equal((await saveProfile(foreign)).status, 403);
});
