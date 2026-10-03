import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as compose } from '../app/api/compose/route';
import { POST as reply } from '../app/api/reply/route';
import { POST as saveProfile } from '../app/api/profile/route';
import { buildMime, buildRawMessage, parseMessage, parseRecipientGroups } from '../server/gmail';
import { MAX_ATTACHMENT_BYTES, attachmentProblem, cleanFileName, cleanMediaType } from '../lib/attachments';
import { replyAllCc } from '../lib/recipients';
import { connect, decodeRaw, gmailMessage, headerBlock, origin, post, rig, sends, signIn, type Call, type Rig } from './helpers/google';

let r: Rig;
beforeEach(async () => { r = rig({ geminiKey: true }); await connect(r, 'user-a', 'acct-1', 'me@gmail.example'); });
afterEach(() => r.restore());

const base = { accountId: 'acct-1', action: 'send', to: 'sam@example.com', subject: 'Lunch Friday?', body: 'Are you free for lunch on Friday?', key: 'compose-key-1' };
const mail = (extra: Record<string, unknown> = {}) => compose(post('/api/compose', { ...base, ...extra }));
const subjectOf = (mime: string) => headerBlock(mime).replace(/\r\n /g, ' ').split('\r\n').find((l) => l.startsWith('Subject: '))!.slice(9)
  .split(' ').map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8')).join('');
const bodyOf = (mime: string) => Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
const operations = () => r.storage.sql.prepare('SELECT status, account_id, action, attempt FROM operations').all() as { status: string; account_id: string; action: string; attempt: string }[];
const multipart = (fields: Record<string, string>, files: File[]) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  for (const file of files) form.append('files', file);
  return new Request(origin + '/api/compose', { method: 'POST', headers: { origin }, body: form });
};
const file = (name: string, bytes: Uint8Array | string, type = 'application/pdf') => new File([bytes as BlobPart], name, { type });
const parseMultipart = (mime: string) => {
  const boundary = mime.match(/boundary="([^"]+)"/)![1];
  const body = mime.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  assert.ok(body.trimEnd().endsWith(`--${boundary}--`));
  return body.split(`--${boundary}`).slice(1, -1).map((chunk) => {
    const [head, ...rest] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head, bytes: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64') };
  });
};

void test('composing is refused for signed-out callers and foreign origins before any provider is contacted', async () => {
  globalThis.__briefTestHeaders = new Headers();
  assert.equal((await mail()).status, 401);
  signIn('user-a');
  const foreign = new Request(origin + '/api/compose', { method: 'POST', headers: { origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify(base) });
  assert.equal((await compose(foreign)).status, 403);
  assert.equal(r.calls.length, 0);
});

void test('an email can only leave from a mailbox the signed-in user owns', async () => {
  await connect(r, 'user-b', 'acct-2', 'other@gmail.example');
  for (const accountId of [undefined, '', 'all', 'nonexistent', 'acct-2', 42]) {
    const response = await mail({ accountId });
    assert.ok([400, 404].includes(response.status), `accountId ${String(accountId)} → ${response.status}`);
  }
  assert.equal(r.calls.length, 0, 'nothing reached Google');
  assert.equal(operations().length, 0);
  signIn('user-b');
  assert.equal((await mail({ accountId: 'acct-1' })).status, 404, 'and not the other way round');
});

void test('invalid compose requests are rejected before Gmail is contacted', async () => {
  const cases: Record<string, unknown>[] = [
    { action: 'forward' }, { to: '' }, { to: 'a@example.com\r\nBcc: spy@example.com' }, { to: 'Jane <jane@example.com>' }, { cc: 'bad address' }, { bcc: 42 },
    { subject: '  ' }, { subject: 'Hi\r\nBcc: spy@example.com' }, { subject: 'x'.repeat(201) }, { body: '   ' }, { body: 'x'.repeat(20001) }, { key: '' }, { key: undefined },
    { to: Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(',') },
  ];
  for (const extra of cases) assert.equal((await mail(extra)).status, 400, JSON.stringify(extra).slice(0, 80));
  assert.equal((await compose(new Request(origin + '/api/compose', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: 'not json' }))).status, 400);
  assert.equal(r.calls.length, 0);
});

void test('a large message body is accepted: the request reader allows a full 20,000-character email', async () => {
  const response = await mail({ body: 'é'.repeat(20000) });
  assert.equal(response.status, 200);
  assert.equal(bodyOf(decodeRaw(sends(r.calls)[0].body.raw)), 'é'.repeat(20000));
});

void test('recipients are parsed strictly: repeats collapse, To wins over Cc over Bcc, and the total is capped', () => {
  assert.deepEqual(parseRecipientGroups({ to: 'a@example.com, B@Example.com; a@EXAMPLE.com\nc@example.com' }).to, ['a@example.com', 'B@example.com', 'c@example.com']);
  assert.deepEqual(parseRecipientGroups({ to: 'a@example.com', cc: 'A@example.com, b@example.com', bcc: 'b@example.com; c@example.com' }), { to: ['a@example.com'], cc: ['b@example.com'], bcc: ['c@example.com'] });
  const many = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`).join(',');
  assert.throws(() => parseRecipientGroups({ to: many('t', 10), cc: many('c', 6), bcc: many('b', 5) }), /at most 20/);
  assert.equal(parseRecipientGroups({ to: many('t', 10), cc: many('c', 5), bcc: many('b', 5) }).bcc.length, 5);
  for (const bad of ['', '   ', 'a,b@example.com', '"a"@example.com', 'a@example', undefined, 42]) assert.throws(() => parseRecipientGroups({ to: bad }), /recipient|plain email/);
});

void test('an email is built exactly as written, with Cc and Bcc as headers, and sent once from the chosen mailbox', async () => {
  const response = await mail({ to: 'sam@example.com, Pat@example.com', cc: 'lee@example.com', bcc: 'hidden@example.com' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'gmail-' + r.calls.length, status: 'sent', threadId: 'thread-new' });
  assert.equal(sends(r.calls).length, 1);
  const mime = decodeRaw(sends(r.calls)[0].body.raw);
  assert.match(headerBlock(mime), /^To: sam@example.com, Pat@example.com\r\nCc: lee@example.com\r\nBcc: hidden@example.com\r\nSubject: /);
  assert.equal(subjectOf(mime), 'Lunch Friday?'); assert.equal(bodyOf(mime), 'Are you free for lunch on Friday?');
  assert.ok(!/^(In-Reply-To|References):/m.test(mime));
  assert.deepEqual(operations().map((o) => [o.status, o.account_id, o.action]), [['complete', 'acct-1', 'send']]);
});

void test('subjects and bodies in any script survive, and long subjects fold into valid encoded words', () => {
  const subject = 'Réunion équipe 日本語 ' + 'long subject '.repeat(12);
  const mime = buildMime({ to: ['sam@example.com'], subject, body: 'Bonjour 👋' });
  for (const word of headerBlock(mime).replace(/\r\n /g, ' ').split('\r\n').find((l) => l.startsWith('Subject: '))!.slice(9).split(' ')) assert.ok(word.length <= 75);
  assert.equal(subjectOf(mime), subject); assert.equal(bodyOf(mime), 'Bonjour 👋');
  assert.throws(() => buildRawMessage({ to: ['sam@example.com\r\nBcc: x@example.com'], subject: 'x', body: 'x' }));
  assert.throws(() => buildRawMessage({ to: ['sam@example.com'], subject: 'x', body: 'x', inReplyTo: '<a>\r\nBcc: x@example.com' }));
});

void test('a repeated request returns the stored receipt, and the same text from two mailboxes is two emails', async () => {
  await connect(r, 'user-a', 'acct-2', 'second@gmail.example');
  assert.equal((await mail()).status, 200); assert.equal((await mail()).status, 200);
  assert.equal(sends(r.calls).length, 1, 'same mailbox and key: one send');
  assert.equal((await mail({ accountId: 'acct-2' })).status, 200);
  assert.equal(sends(r.calls).length, 2, 'another mailbox is another email');
  assert.equal((await mail({ body: 'Different words.' })).status, 200); assert.equal(sends(r.calls).length, 3);
});

void test('an uncertain send is never repeated until the person confirms they checked Gmail', async () => {
  r.behavior.sendStatus = 500;
  const failed = await mail();
  assert.equal(failed.status, 502);
  assert.deepEqual(operations().map((o) => o.status), ['unconfirmed'], 'a server error might still have been delivered');
  r.behavior.sendStatus = 200;
  const blocked = await mail();
  assert.equal(blocked.status, 409); assert.match((await blocked.json() as { error: string }).error, /still unconfirmed\. Check Gmail/);
  assert.equal(sends(r.calls).length, 1, 'no second attempt without confirmation');
  const confirmed = await mail({ confirmUnsent: true });
  assert.equal(confirmed.status, 200); assert.equal(sends(r.calls).length, 2);
  assert.deepEqual(operations().map((o) => o.status), ['complete']);
  const viaForm = await compose(multipart({ ...base, key: 'compose-key-2', confirmUnsent: 'true' }, [file('a.txt', 'x', 'text/plain')]));
  assert.equal(viaForm.status, 200, 'the confirmation also works from a form submission');
});

void test('a message Gmail clearly refuses releases its claim, so the same email can be sent once the cause is fixed', async () => {
  r.behavior.sendStatus = 400;
  assert.equal((await mail()).status, 400);
  assert.deepEqual(operations(), [], 'nothing was created, so nothing is left blocking a retry');
  r.behavior.sendStatus = 200;
  assert.equal((await mail()).status, 200);
});

void test('a draft is saved through the drafts endpoint and never sent', async () => {
  const response = await mail({ action: 'draft' });
  assert.equal(response.status, 200); assert.equal((await response.json() as { status: string }).status, 'drafted');
  assert.equal(sends(r.calls).length, 0); assert.ok(r.calls.some((c) => c.url.endsWith('/drafts')));
});

void test('saving an edited draft updates the same Gmail draft and sending clears it', async () => {
  const first=await (await mail({action:'draft',key:'draft-session-1',saveKey:'first-save-key'})).json() as {id:string};
  const second=await (await mail({action:'draft',key:'draft-session-1',saveKey:'second-save-key',body:'Revised message',draftId:first.id})).json() as {id:string};
  assert.equal(second.id,first.id,'the Gmail draft identity stays the same');
  assert.ok(r.calls.some(call=>call.url.endsWith('/drafts/'+first.id)&&call.method==='PUT'));
  const reverted=await (await mail({action:'draft',key:'draft-session-1',saveKey:'third-save-key',draftId:first.id})).json() as {id:string};
  assert.equal(reverted.id,first.id);
  assert.equal(r.calls.filter(call=>call.url.endsWith('/drafts/'+first.id)&&call.method==='PUT').length,2,'returning to older wording still updates Gmail');
  assert.equal((await mail({action:'send',key:'draft-session-1',body:'Revised message',draftId:first.id})).status,200);
  assert.ok(r.calls.some(call=>call.url.endsWith('/drafts/'+first.id)&&call.method==='DELETE'));
});

void test('saving after the Gmail draft was deleted creates one replacement draft', async () => {
  const first=await (await mail({action:'draft',key:'deleted-draft-session',saveKey:'first-save-key'})).json() as {id:string};
  r.deletedDrafts.add(first.id);
  const saved=await mail({action:'draft',key:'deleted-draft-session',saveKey:'second-save-key',body:'Updated after deletion',draftId:first.id});
  assert.equal(saved.status,200);
  const replacement=(await saved.json() as {id:string}).id;
  assert.notEqual(replacement,first.id);
  assert.equal(r.calls.filter(call=>call.url.endsWith('/drafts/'+first.id)&&call.method==='PUT').length,1);
  assert.equal(r.calls.filter(call=>call.url.endsWith('/drafts')&&call.method==='POST').length,2);
  assert.equal((await mail({action:'draft',key:'deleted-draft-session',saveKey:'second-save-key',body:'Updated after deletion',draftId:first.id})).status,200);
  assert.equal(r.calls.filter(call=>call.url.endsWith('/drafts')&&call.method==='POST').length,2,'a retried save reuses its receipt');
  const next=await mail({action:'draft',key:'deleted-draft-session',saveKey:'third-save-key',body:'Final text',draftId:replacement});
  assert.equal(next.status,200);
  assert.equal((await next.json() as {id:string}).id,replacement);
});

void test('the daily sending limit blocks further sends, not drafts, and old sends stop counting', async () => {
  r.env.SEND_DAILY_LIMIT = '2';
  const send = (n: number, action = 'send') => mail({ action, subject: 'Note ' + n, body: 'Body ' + n, key: 'key-number-' + n });
  assert.equal((await send(1)).status, 200); assert.equal((await send(2)).status, 200);
  const blocked = await send(3);
  assert.equal(blocked.status, 429); assert.match((await blocked.json() as { error: string }).error, /limit of 2/);
  assert.equal(sends(r.calls).length, 2);
  assert.equal((await send(3, 'draft')).status, 200, 'drafts are not sends');
  assert.equal((await send(1)).status, 200, 'a completed email stays retrievable at the limit'); assert.equal(sends(r.calls).length, 2);
  r.storage.sql.prepare("UPDATE operations SET created = ? WHERE action = 'send'").run(Date.now() - 25 * 3600000);
  assert.equal((await send(4)).status, 200); assert.equal(sends(r.calls).length, 3);
});

void test('attachments are uploaded with the message byte for byte, retried requests are recognised, and drafts keep them', async () => {
  const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
  const fields = { ...base, cc: 'pat@example.com', key: 'attach-key-1' };
  const make = () => multipart(fields, [file('résumé 日本.pdf', everyByte), file('data.csv', 'a,b\n1,2', 'text/csv')]);
  assert.equal((await compose(make())).status, 200);
  const upload = sends(r.calls);
  assert.equal(upload.length, 1);
  assert.match(upload[0].url, /\/upload\/gmail\/v1\/users\/me\/messages\/send\?uploadType=media$/); assert.equal(upload[0].contentType, 'message/rfc822');
  const mime = upload[0].text!;
  assert.match(headerBlock(mime), /^To: sam@example.com\r\nCc: pat@example.com\r\n/);
  const parts = parseMultipart(mime);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].bytes.toString('utf8'), base.body);
  assert.deepEqual([...parts[1].bytes], [...everyByte]);
  assert.match(parts[1].head, /filename\*=UTF-8''r%C3%A9sum%C3%A9%20%E6%97%A5%E6%9C%AC\.pdf/);
  assert.equal(parts[2].bytes.toString(), 'a,b\n1,2'); assert.match(parts[2].head, /Content-Type: text\/csv; name="data.csv"/);
  for (const line of mime.split('\r\n')) assert.ok(line.length <= 998);
  assert.equal((await compose(make())).status, 200); assert.equal(sends(r.calls).length, 1, 'same files, same key: one send');
  assert.equal((await compose(multipart(fields, [file('résumé 日本.pdf', 'DIFFERENT'), file('data.csv', 'a,b\n1,2', 'text/csv')]))).status, 200);
  assert.equal(sends(r.calls).length, 2, 'different contents are a different email');
  assert.equal((await compose(multipart({ ...fields, action: 'draft', key: 'attach-key-2' }, [file('a.txt', 'x', 'text/plain')]))).status, 200);
  assert.match(r.calls.at(-1)!.url, /\/upload\/gmail\/v1\/users\/me\/drafts\?uploadType=media$/);
});

void test('long international attachment filenames use short encoded header lines', () => {
  const name='日本語'.repeat(55)+"Ethan's (final)*.pdf";
  const mime=buildMime({to:['sam@example.com'],subject:'File',body:'See attached.',attachments:[{name,type:'application/pdf',bytes:new Uint8Array([1])}]});
  for(const line of mime.split('\r\n'))assert.ok(line.length<=998,`overlong MIME line: ${line.length}`);
  assert.match(mime,/filename\*0\*=UTF-8''/);
  for(const escape of ['%27','%28','%29','%2A'])assert.ok(mime.includes(escape),escape);
});

void test('the reply-all preview excludes the actual Reply-To recipient', () => {
  const email=parseMessage(gmailMessage({id:'reply-to',from:'sender@corp.example',to:'me@corp.example',
    cc:'team@corp.example, lists@corp.example',replyTo:'lists@corp.example'}));
  assert.equal(email.replyTo,'lists@corp.example');
  assert.deepEqual(replyAllCc(email,['me@corp.example',email.address,email.replyTo||'']),['team@corp.example']);
});

void test('bad attachments are refused before Gmail is contacted, with plain explanations', async () => {
  const fields = { ...base, key: 'attach-key-3' };
  const cases: [File[], RegExp][] = [
    [Array.from({ length: 6 }, (_, i) => file(`f${i}.txt`, 'x')), /at most 5/], [[file('setup.exe', 'MZ')], /does not allow/],
    [[file('empty.txt', '')], /empty/], [[file('big.zip', new Uint8Array(MAX_ATTACHMENT_BYTES + 1))], /too large/],
  ];
  for (const [files, message] of cases) {
    const response = await compose(multipart(fields, files));
    assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, message);
  }
  const oversized = new Request(origin + '/api/compose', { method: 'POST', headers: { origin, 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(MAX_ATTACHMENT_BYTES * 3) }, body: '--x--' });
  assert.equal((await compose(oversized)).status, 413);
  const scheduled = await compose(multipart({ ...fields, action: 'schedule', sendAt: String(Date.now() + 7200000) }, [file('a.txt', 'x', 'text/plain')]));
  assert.equal(scheduled.status, 400); assert.match((await scheduled.json() as { error: string }).error, /cannot be scheduled/);
  assert.equal(r.calls.length, 0);
});

void test('attachment names and types are made safe, and problems are described in plain words', () => {
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('C:\\Users\\me\\report "final".pdf'), 'report _final_.pdf');
  assert.equal(cleanFileName('a\r\nBcc: spy@example.com.txt'), 'a__Bcc: spy@example.com.txt');
  assert.equal(cleanFileName('   '), 'attachment'); assert.equal(cleanFileName('x'.repeat(400)).length, 150);
  assert.equal(cleanMediaType('Application/PDF; charset=x'), 'application/pdf');
  assert.equal(cleanMediaType('text/plain\r\nBcc: spy'), 'application/octet-stream');
  assert.equal(attachmentProblem([{ name: 'a.pdf', size: 10 }]), null);
  assert.equal(attachmentProblem([{ name: 'a.zip', size: MAX_ATTACHMENT_BYTES / 2 }, { name: 'b.zip', size: MAX_ATTACHMENT_BYTES / 2 }]), null);
});

void test('AI drafting writes a subject and body for review, signs with the saved name or signature, and never sends', async () => {
  r.gemini.reply = () => ({ subject: 'Lunch\r\nBcc: spy@example.com Friday', body: '  Hi,\n\nFree for lunch on Friday?\n\nBest  ' });
  const ask = () => compose(post('/api/compose', { accountId: 'acct-1', action: 'assist', notes: 'ask Sam to lunch friday', tone: 'Friendly' }));
  const first = await ask();
  assert.deepEqual(await first.json(), { subject: 'Lunch Bcc: spy@example.com Friday', body: 'Hi,\n\nFree for lunch on Friday?\n\nBest' });
  const prompt = (call: Call) => call.body.systemInstruction.parts[0].text as string;
  assert.match(prompt(r.calls[0]), /ending with a sign-off but no name/, 'no saved name, so it does not guess one');
  assert.equal((await saveProfile(post('/api/profile', { name: 'Jordan Rivera' }))).status, 200);
  await ask();
  assert.match(prompt(r.calls.at(-1)!), /signed as Jordan Rivera/);
  assert.equal((await saveProfile(post('/api/profile', { signature: 'Jordan Rivera\nProduct lead' }))).status, 200);
  const signed = await (await ask()).json() as { body: string };
  assert.equal(signed.body, 'Hi,\n\nFree for lunch on Friday?\n\nBest\n\n-- \nJordan Rivera\nProduct lead');
  assert.doesNotMatch(prompt(r.calls.at(-1)!), /Product lead/, 'the signature is added by the server, never shown to the AI');
  assert.match(prompt(r.calls.at(-1)!), /Never send anything/);
  assert.equal(sends(r.calls).length, 0);
  assert.equal((await compose(post('/api/compose', { accountId: 'acct-1', action: 'assist', notes: '   ' }))).status, 400);
  assert.equal((await compose(post('/api/compose', { accountId: 'acct-1', action: 'assist', notes: 'x'.repeat(4001) }))).status, 400);
  assert.equal((await compose(post('/api/compose', { accountId: 'nope', action: 'assist', notes: 'hello' }))).status, 404);
});

void test('reply-all copies everyone else, working it out from Gmail rather than the browser', async () => {
  r.messages.m1 = gmailMessage({ id: 'm1', from: 'Sam Lee <sam@example.com>', to: 'Me <me@gmail.example>, Other <other@example.com>', cc: 'third@example.com', subject: 'Plan' });
  const send = (extra: Record<string, unknown>) => reply(post('/api/reply', { id: 'm1', accountId: 'acct-1', action: 'send', body: 'Sounds good.', ...extra }));
  assert.equal((await send({ replyAll: true, cc: 'evil@example.com', bcc: 'evil@example.com' })).status, 200);
  const mime = decodeRaw(sends(r.calls)[0].body.raw);
  assert.match(headerBlock(mime), /^To: sam@example.com\r\nCc: other@example.com, third@example.com\r\nSubject: /);
  assert.ok(!mime.includes('evil@example.com')); assert.ok(!/^Bcc:/m.test(mime));
  assert.equal(sends(r.calls)[0].body.threadId, 'thread-m1');
  assert.equal((await send({ body: 'Just you.' })).status, 200);
  assert.ok(!/^Cc:/m.test(decodeRaw(sends(r.calls)[1].body.raw)), 'a plain reply copies no one');
  assert.deepEqual(replyAllCc({ to: ['Me@Gmail.example', 'other@example.com', 'sam@example.com'], cc: ['third@example.com', 'OTHER@example.com', 'not an address'] }, ['me@gmail.example', 'sam@example.com']), ['other@example.com', 'third@example.com']);
});

void test('a reply-all honours Reply-To as the main recipient and does not copy them a second time', async () => {
  r.messages.m2 = gmailMessage({ id: 'm2', from: 'Sam <sam@example.com>', replyTo: 'desk@example.com', to: 'me@gmail.example, desk@example.com, other@example.com', subject: 'Plan' });
  assert.equal((await reply(post('/api/reply', { id: 'm2', accountId: 'acct-1', action: 'send', body: 'On it.', replyAll: true }))).status, 200);
  assert.match(headerBlock(decodeRaw(sends(r.calls)[0].body.raw)), /^To: desk@example.com\r\nCc: other@example.com\r\n/);
});

void test('AI replies are signed with the person’s saved name, and with no name when none is saved', async () => {
  r.messages.m3 = gmailMessage({ id: 'm3', from: 'Sam <sam@example.com>', subject: 'Plan' });
  r.gemini.reply = () => ({ options: ['One', 'Two', 'Three'] });
  const options = () => reply(post('/api/reply', { id: 'm3', accountId: 'acct-1', action: 'options', tone: 'Friendly' }));
  assert.equal((await options()).status, 200);
  const prompt = (call: Call) => call.body.systemInstruction.parts[0].text as string;
  const last = () => prompt(r.calls.filter((c) => c.url.startsWith('https://generativelanguage')).at(-1)!);
  assert.match(last(), /no name/); assert.doesNotMatch(last(), /Alex/);
  await saveProfile(post('/api/profile', { name: 'Jordan Rivera' }));
  await options();
  assert.match(last(), /signed as Jordan Rivera/);
});
