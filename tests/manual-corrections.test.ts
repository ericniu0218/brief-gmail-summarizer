import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from './database';
import { POST as correctMessage } from '../app/api/classification/route';
import {
  applyCorrection,
  applyOverride,
  composeClassification,
  loadOverride,
  loadSenderRules,
  saveSenderRule,
  withSenderRule,
  type SenderRule,
  reduceOverride,
  type Override,
} from '../server/overrides';
import {
  obligationCorrectionKey,
  type Classification,
  type Obligation,
} from '../lib/classification';
import type { Runtime } from '../server/runtime';
import type { Email } from '../lib/mail';
import { mutateSnapshot, parseSnapshot } from '../server/snapshots';
import { readMailbox } from '../server/mailbox';

declare global { var __briefTestEnv:Runtime; var __briefTestHeaders:Headers; }

const NOW=Date.UTC(2026,8,24);
const obligation=(over:Partial<Obligation>={}):Obligation=>({
  id:'generated-index',kind:'request',description:'Approve invoice',owner:'recipient',
  ownerIsUser:true,required:true,evidence:'Please approve invoice 42.',state:'open',...over,
});
const automatic=(over:Partial<Classification>={}):Classification=>({
  context:'work',topics:[],obligations:[obligation()],disposition:'useful',replyRequired:true,
  securityEvent:false,processingStatus:'classified',reason:'Automatic work request.',version:'test',...over,
});
const blank=(messageId='m1'):Override=>({messageId,addTags:[],removeTags:[],source:'message',createdAt:NOW,revision:0,active:false});

void test('independent corrections accumulate and reset restores the untouched automatic result',()=>{
  const baseline=automatic({obligations:[obligation({kind:'meeting',meetingState:'confirmed'})]});
  let manual=reduceOverride(blank(), 'm1',{type:'add-tag',tag:'research'},NOW+1);
  manual=reduceOverride(manual,'m1',{type:'remove-tag',tag:'meetings'},NOW+2);
  manual=reduceOverride(manual,'m1',{type:'set-obligation-state',obligationKey:obligationCorrectionKey(baseline.obligations[0]),state:'completed'},NOW+3);
  const corrected=composeClassification(baseline,manual,NOW);
  assert.ok(corrected.tags.includes('research'));
  assert.ok(!corrected.tags.includes('meetings'));
  assert.equal(corrected.classification.obligations[0].state,'completed');
  assert.equal(baseline.obligations[0].state,'open','composition must not mutate automatic facts');

  manual=reduceOverride(manual,'m1',{type:'reset-all'},NOW+4);
  const reset=composeClassification(baseline,manual,NOW);
  assert.equal(reset.category,'work');
  assert.ok(reset.tags.includes('meetings'));
  assert.ok(!reset.tags.includes('research'));
  assert.equal(reset.classification.obligations[0].state,'open');
  assert.equal(manual.active,false);
});

void test('incompatible tag intent stays stored but inactive until its section is restored',()=>{
  const baseline=automatic({obligations:[]});
  let manual=reduceOverride(blank(),'m1',{type:'add-tag',tag:'research'},NOW);
  manual=reduceOverride(manual,'m1',{type:'set-section',section:'personal'},NOW+1);
  assert.ok(manual.addTags.includes('research'),'manual intent remains persisted');
  assert.ok(!composeClassification(baseline,manual,NOW).tags.includes('research'),'Personal filters Work-only tags');
  manual=reduceOverride(manual,'m1',{type:'set-section',section:'work'},NOW+2);
  assert.ok(composeClassification(baseline,manual,NOW).tags.includes('research'),'switching back restores compatible intent');
});

void test('section and Junk corrections can be cleared independently',()=>{
  const baseline=automatic({obligations:[],context:'work'});
  let manual=reduceOverride(blank(),'m1',{type:'set-section',section:'personal'},NOW);
  manual=reduceOverride(manual,'m1',{type:'set-junk-preference',value:'junk'},NOW+1);
  assert.equal(composeClassification(baseline,manual,NOW).category,'noise');
  manual=reduceOverride(manual,'m1',{type:'clear-junk-preference'},NOW+2);
  assert.equal(composeClassification(baseline,manual,NOW).category,'personal');
  assert.equal(manual.category,'personal');
});

void test('reset resumes Junk conflict protection rather than forcing a risky message into Noise',()=>{
  const baseline=automatic({disposition:'junk'});
  let manual=reduceOverride(blank(),'m1',{type:'set-section',section:'noise'},NOW);
  assert.equal(composeClassification(baseline,manual,NOW).category,'noise');
  manual=reduceOverride(manual,'m1',{type:'reset-all'},NOW+1);
  const reset=composeClassification(baseline,manual,NOW);
  assert.notEqual(reset.category,'noise');
  assert.equal(reset.classification.processingStatus,'needs_review');
  assert.equal(reset.classification.proposedDisposition,'junk');
});

void test('obligation corrections survive reorder and do not attach to ambiguous duplicates',()=>{
  const target=obligation({id:'old-0',evidence:'Please approve invoice 42.'});
  const other=obligation({id:'old-1',kind:'action',description:'Upload receipt',evidence:'Please upload the receipt.'});
  const key=obligationCorrectionKey(target);
  const manual=reduceOverride(blank(),'m1',{type:'set-obligation-state',obligationKey:key,state:'completed'},NOW);
  const reordered=applyOverride(automatic({obligations:[{...other,id:'new-0'},{...target,id:'new-1'}]}),manual);
  assert.equal(reordered.obligations[0].state,'open');
  assert.equal(reordered.obligations[1].state,'completed');

  const ambiguous=applyOverride(automatic({obligations:[{...target,id:'a'},{...target,id:'b'}]}),manual);
  assert.deepEqual(ambiguous.obligations.map(item=>item.state),['open','open']);
  assert.equal(ambiguous.processingStatus,'needs_review');
});

void test('obligation correction identities preserve every canonical field without hash collisions',()=>{
  const first=obligation({kind:'deadline',evidence:'Aa',owner:'recipient'});
  const second=obligation({kind:'deadline',evidence:'BB',owner:'recipient'});
  assert.notEqual(obligationCorrectionKey(first),obligationCorrectionKey(second));
  assert.deepEqual(JSON.parse(obligationCorrectionKey(first)),['deadline','aa','','recipient']);
});

void test('snapshot parsing drops null and primitive email entries',()=>{
  const snapshot=parseSnapshot(JSON.stringify({emails:[null,3,'bad',{id:'ok'}],updated:NOW}));
  assert.deepEqual(snapshot?.emails.map(email=>email.id),['ok']);
});

let storage:ReturnType<typeof database>;
let env:Runtime;
beforeEach(()=>{
  storage=database();env={DB:storage.db,APP_URL:'https://brief.example'};
  globalThis.__briefTestEnv=env;
  globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
});
afterEach(()=>{storage.sql.close();globalThis.__briefTestHeaders=new Headers();});

function seedAccount(accountId:string,user='user-a'){
  storage.sql.prepare('INSERT INTO connections (id,user_id,provider_identity,email,token,token_version,last_sync,sync_lock,error,created) VALUES (?,?,NULL,?,?,2,NULL,0,NULL,?)')
    .run(accountId,user,`${accountId}@example.com`,'token',NOW);
}

void test('compare-and-swap preserves one concurrent correction and rejects the stale writer',async()=>{
  seedAccount('acct-1');
  const attempts=await Promise.allSettled([
    applyCorrection('user-a','acct-1','m1',0,{type:'add-tag',tag:'research'},env),
    applyCorrection('user-a','acct-1','m1',0,{type:'set-section',section:'personal'},env),
  ]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(attempts.filter(result=>result.status==='rejected').length,1);
  const saved=await loadOverride('user-a','acct-1','m1',env);
  assert.equal(saved?.revision,1);
});

void test('reset tombstone blocks a stale request and account scopes isolate identical message ids',async()=>{
  seedAccount('acct-a');seedAccount('acct-b');
  await applyCorrection('user-a','acct-a','same',0,{type:'add-tag',tag:'research'},env);
  await applyCorrection('user-a','acct-b','same',0,{type:'set-section',section:'personal'},env);
  const reset=await applyCorrection('user-a','acct-a','same',1,{type:'reset-all'},env);
  assert.equal(reset.active,false);
  await assert.rejects(applyCorrection('user-a','acct-a','same',1,{type:'add-tag',tag:'actions'},env),/changed in another tab/i);
  assert.equal((await loadOverride('user-a','acct-a','same',env))?.active,false);
  assert.equal((await loadOverride('user-a','acct-b','same',env))?.category,'personal');
});

void test('a disconnected account cannot gain an orphaned correction after ownership was checked',async()=>{
  seedAccount('acct-1');
  storage.sql.prepare('DELETE FROM connections WHERE id=? AND user_id=?').run('acct-1','user-a');
  await assert.rejects(applyCorrection('user-a','acct-1','m1',0,{type:'add-tag',tag:'research'},env),/changed in another tab/i);
  assert.equal(await loadOverride('user-a','acct-1','m1',env),undefined);
});

function request(body:unknown){return new Request('https://brief.example/api/classification',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify(body)});}

void test('HTTP corrections accumulate and reset returns the genuine automatic baseline',async()=>{
  seedAccount('acct-1');
  const baseline=automatic({obligations:[]});
  const email={id:'m1',accountId:'acct-1',accountEmail:'acct-1@example.com',sender:'Sender',address:'sender@example.com',initials:'S',subject:'Subject',summary:'Summary',body:'Body',time:'Now',category:'work',priority:'normal',needsReply:false,unread:false,color:'blue',classification:baseline,automaticClassification:baseline} as Email&{automaticClassification:Classification};
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)').run('acct-1','user-a',JSON.stringify({emails:[email],ai:false,pending:0,skipped:0,analysisVersion:'test',updated:NOW,limit:60,hasMore:false}),NOW);

  const first=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,action:{type:'set-section',section:'personal'}}));
  assert.equal(first.status,200);
  const firstBody=await first.json() as {email:Email;revision:number};
  assert.equal(firstBody.email.category,'personal');
  const second=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:firstBody.revision,action:{type:'add-tag',tag:'low-priority'}}));
  const secondBody=await second.json() as {email:Email;revision:number};
  assert.equal(secondBody.email.category,'personal','the tag command must preserve the category command');
  assert.ok(secondBody.email.tags?.includes('low-priority'));

  const reset=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:secondBody.revision,action:{type:'reset-all'}}));
  const resetBody=await reset.json() as {email:Email;revision:number};
  assert.equal(resetBody.email.category,'work');
  assert.equal(resetBody.email.manuallyCorrected,false);
  assert.equal(resetBody.email.classification?.reason,'Automatic work request.');
});

void test('reset refuses a legacy manually contaminated snapshot without deleting its correction',async()=>{
  seedAccount('acct-1');
  await applyCorrection('user-a','acct-1','legacy',0,{type:'set-section',section:'personal'},env);
  const contaminated=applyOverride(automatic({obligations:[]}),await loadOverride('user-a','acct-1','legacy',env));
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)').run('acct-1','user-a',JSON.stringify({emails:[{id:'legacy',classification:contaminated}],updated:NOW}),NOW);
  const response=await correctMessage(request({accountId:'acct-1',messageId:'legacy',expectedRevision:1,action:{type:'reset-all'}}));
  assert.equal(response.status,409);
  assert.equal((await loadOverride('user-a','acct-1','legacy',env))?.active,true,'failed recovery must not clear user intent');
});

void test('invalid correction commands are rejected without creating override state',async()=>{
  seedAccount('acct-1');
  const baseline=automatic({obligations:[]});
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)').run('acct-1','user-a',JSON.stringify({emails:[{id:'m1',classification:baseline,automaticClassification:baseline}],updated:NOW}),NOW);
  const response=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,action:{type:'add-tag',tag:'made-up-tag'}}));
  assert.equal(response.status,400);
  assert.equal(await loadOverride('user-a','acct-1','m1',env),undefined);
});

void test('sender Junk preferences persist and can be cleared without changing message corrections',async()=>{
  seedAccount('acct-1');
  const baseline=automatic({obligations:[]});
  const email={id:'m1',address:'sender@example.com',subject:'Subject',classification:baseline,automaticClassification:baseline};
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)').run('acct-1','user-a',JSON.stringify({emails:[email],updated:NOW}),NOW);
  const saved=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,expectedSenderRevision:0,action:{type:'set-sender-junk-preference',value:'not-junk'}}));
  assert.equal(saved.status,200);
  assert.equal((await loadSenderRules('user-a','acct-1',env)).get('sender@example.com')?.junkPreference,'not-junk');
  const cleared=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,expectedSenderRevision:1,action:{type:'clear-sender-junk-preference'}}));
  assert.equal(cleared.status,200);
  // Clearing leaves an inactive tombstone rather than deleting the row. It carries no
  // preference, so classification is unaffected, but its revision keeps counting up.
  const tombstone=(await loadSenderRules('user-a','acct-1',env)).get('sender@example.com');
  assert.equal(tombstone?.active,false,'the rule no longer applies');
  assert.equal(tombstone?.junkPreference,undefined,'and carries no preference');
  assert.equal(tombstone?.revision,2,'while its revision advanced past the cleared one');
  // The cleared revision reaches the browser, so the next write is not sent against zero.
  const body=await cleared.json() as {senderRuleRevision:number;senderJunkPreference:string|null};
  assert.equal(body.senderRuleRevision,2);
  assert.equal(body.senderJunkPreference,null);
  // A request written before the clear cannot recreate the rule it was meant to remove.
  const stale=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,expectedSenderRevision:1,action:{type:'set-sender-junk-preference',value:'junk'}}));
  assert.equal(stale.status,409,'a stale write is refused rather than resurrecting the rule');
  assert.equal((await loadSenderRules('user-a','acct-1',env)).get('sender@example.com')?.active,false);
  assert.equal(await loadOverride('user-a','acct-1','m1',env),undefined);
});

void test('sender actions require exact fields and never clear by omission',async()=>{
  seedAccount('acct-1');
  seedMessage('acct-1','m1','sender@example.com');
  const initial=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,
    expectedSenderRevision:0,action:{type:'set-sender-junk-preference',value:'junk'}}));
  assert.equal(initial.status,200);

  const missing=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,
    expectedSenderRevision:1,action:{type:'set-sender-junk-preference'}}));
  assert.equal(missing.status,400,'set must name the intended value');
  const extra=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,
    expectedSenderRevision:1,action:{type:'clear-sender-junk-preference',value:'junk'}}));
  assert.equal(extra.status,400,'clear accepts no hidden value');
  const unchanged=(await loadSenderRules('user-a','acct-1',env)).get('sender@example.com');
  assert.equal(unchanged?.junkPreference,'junk');
  assert.equal(unchanged?.revision,1,'rejected actions do not advance or clear the rule');
});

void test('sender rules reject unusable and oversized stored addresses',async()=>{
  seedAccount('acct-1');
  for(const [index,address] of ['', '   ', 'missing-at.example', 'sender\u0000@example.com', `${'a'.repeat(321)}@example.com`].entries()){
    const id=`bad-${index}`;
    seedMessage('acct-1',id,address);
    const response=await correctMessage(request({accountId:'acct-1',messageId:id,expectedRevision:0,
      expectedSenderRevision:0,action:{type:'set-sender-junk-preference',value:'junk'}}));
    assert.equal(response.status,409,`stored address ${JSON.stringify(address)} is refused`);
  }
  assert.equal((await loadSenderRules('user-a','acct-1',env)).size,0,'invalid identities create no rules');
  await assert.rejects(saveSenderRule('user-a','acct-1','not-an-address',0,'junk',env),
    /usable sender address/,'the persistence boundary validates callers too');
});

void test('correction body limit is enforced without trusting Content-Length',async()=>{
  const response=await correctMessage(new Request('https://brief.example/api/classification',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(17000)})}));
  assert.equal(response.status,413);
});

void test('concurrent snapshot mutations preserve both successful actions',async()=>{
  seedAccount('acct-1');
  const baseline=automatic({obligations:[]});
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)')
    .run('acct-1','user-a',JSON.stringify({emails:[{id:'a',classification:baseline},{id:'b',classification:baseline}],updated:NOW}),NOW);
  await Promise.all([
    mutateSnapshot('user-a','acct-1',env,snapshot=>{snapshot.emails=snapshot.emails.map(email=>email.id==='a'?{...email,needsReply:false}:email);}),
    mutateSnapshot('user-a','acct-1',env,snapshot=>{snapshot.emails=snapshot.emails.filter(email=>email.id!=='b');}),
  ]);
  const saved=storage.sql.prepare('SELECT data,revision FROM snapshots WHERE account_id=?').get('acct-1') as {data:string;revision:number};
  const parsed=JSON.parse(saved.data) as {emails:Email[]};
  assert.deepEqual(parsed.emails.map(email=>email.id),['a']);
  assert.equal(saved.revision,2);
});

void test('mailbox output puts an invalid future arrival after real mail',async()=>{
  seedAccount('acct-1');
  seedMessage('acct-1','recent','recent@example.com');
  seedMessage('acct-1','future','future@example.com');
  const row=storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get('acct-1') as {data:string};
  const snapshot=JSON.parse(row.data) as {emails:Email[];updated:number};
  snapshot.emails=snapshot.emails.map(email=>({...email,
    receivedAt:email.id==='future'?Date.now()+400*86400000:Date.now()-3600000}));
  storage.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(JSON.stringify(snapshot),'acct-1');
  const mailbox=await readMailbox('user-a','acct-1',env);
  assert.deepEqual(mailbox.emails.map(email=>email.id),['recent','future'],
    'the server order used by the first paint has already rejected the future timestamp');
});

// ── Sender rules: precedence against the automatic junk safeguard ───────────

const withObligation=()=>automatic({obligations:[obligation()]});
const senderRule=(junkPreference:'junk'|'not-junk'):SenderRule=>
  ({address:'sender@example.com',junkPreference,revision:1,active:true});
const compose=(manual:Override|undefined,rule?:SenderRule)=>
  composeClassification(withObligation(),withSenderRule(manual,rule,'m1'),NOW);

void test('a confirmed sender junk rule is intent, and an automatic guess is not',()=>{
  // The safeguard exists so an automatic Junk prediction cannot bury a real request.
  const predicted={...withObligation(),disposition:'junk' as const};
  const automaticGuess=composeClassification(predicted,undefined,NOW);
  assert.notEqual(automaticGuess.category,'noise','an automatic prediction is still held for review');
  assert.equal(automaticGuess.classification.reviewReason,'junk-with-open-obligation');

  // A rule the user was asked about and confirmed is a decision, not a guess.
  const confirmed=compose(undefined,senderRule('junk'));
  assert.equal(confirmed.category,'noise','a confirmed sender rule moves the message to Noise');
  assert.equal(confirmed.classification.reviewReason,undefined,'and leaves no stale review note');
  assert.equal(confirmed.classification.override?.junkPreference,'junk','the intent is recorded, not invented');
});

void test('message intent outranks a sender rule, and unrelated corrections do not',()=>{
  // Explicitly keeping one message is an exception to its sender's rule.
  const kept=reduceOverride(blank(),'m1',{type:'set-junk-preference',value:'not-junk'},NOW);
  assert.notEqual(compose(kept,senderRule('junk')).category,'noise','a kept message stays out of Noise');

  // A tag correction says nothing about Junk, so the sender rule still applies.
  const tagged=reduceOverride(blank(),'m1',{type:'add-tag',tag:'research'},NOW);
  assert.equal(compose(tagged,senderRule('junk')).category,'noise','an unrelated tag does not suppress the rule');

  // Routing a message to Work is an explicit exception and is preserved.
  const routed=reduceOverride(blank(),'m1',{type:'set-section',section:'work'},NOW);
  assert.notEqual(compose(routed,senderRule('junk')).category,'noise','explicit routing keeps it out of Noise');
});

void test('clearing a sender rule restores automatic behaviour and its protection',()=>{
  const cleared=senderRule('junk');
  // An inactive tombstone carries no preference, so composition runs as if it never existed.
  const undone=compose(undefined,{...cleared,active:false,junkPreference:undefined});
  assert.notEqual(undone.category,'noise','the message returns to automatic sorting');
  assert.equal(undone.classification.override?.junkPreference,undefined,'no stale intent is left behind');

  // A message the user separately marked Junk stays in Noise after the sender rule goes.
  const markedJunk=reduceOverride(blank(),'m1',{type:'set-junk-preference',value:'junk'},NOW);
  assert.equal(compose(markedJunk,{...cleared,active:false,junkPreference:undefined}).category,'noise',
    'a message-specific Junk correction survives removing the sender rule');

  // Composing the same inputs again gives the same answer, so a second render or a repeated
  // save cannot drift the result.
  const once=compose(undefined,senderRule('junk'));
  const again=compose(undefined,senderRule('junk'));
  assert.equal(again.category,once.category,'repeated composition is stable');
  assert.deepEqual(again.tags,once.tags);
  assert.equal(again.classification.reviewReason,once.classification.reviewReason);
});

// ── Sender rules: scope, concurrency and cleanup ───────────────────────────

/** Seeds one stored message so the route can read its sender from the server's own copy. */
function seedMessage(accountId:string,messageId:string,address:string){
  const baseline=automatic({obligations:[]});
  const email={id:messageId,address,subject:'Subject',classification:baseline,automaticClassification:baseline};
  const existing=storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get(accountId) as {data:string}|undefined;
  const emails=existing?[...JSON.parse(existing.data).emails,email]:[email];
  if(existing)storage.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(JSON.stringify({emails,updated:NOW}),accountId);
  else storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)')
    .run(accountId,'user-a',JSON.stringify({emails,updated:NOW}),NOW);
}

void test('a sender rule covers one exact address in one account and nothing else',async()=>{
  seedAccount('acct-1');seedAccount('acct-2');
  seedMessage('acct-1','m1','News@Berkeley.EDU');
  seedMessage('acct-1','m2','other@berkeley.edu');
  seedMessage('acct-2','m3','news@berkeley.edu');
  const saved=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,
    expectedSenderRevision:0,action:{type:'set-sender-junk-preference',value:'junk'}}));
  assert.equal(saved.status,200);

  const first=await loadSenderRules('user-a','acct-1',env);
  assert.equal(first.get('news@berkeley.edu')?.junkPreference,'junk','the exact canonical address is covered');
  const mailbox=await readMailbox('user-a','acct-1',env);
  const mixed=mailbox.emails.find(email=>email.id==='m1');
  assert.equal(mixed?.category,'noise','the mixed-case stored address finds the canonical rule');
  assert.equal(mixed?.senderRuleRevision,1,'the mailbox reports the database revision for Undo');
  // Another sender at the same domain is untouched: domains are never matched.
  assert.equal(first.get('other@berkeley.edu'),undefined,'a sibling address at the same domain is not');
  // The same address in another connected mailbox is a separate rule that was never made.
  assert.equal((await loadSenderRules('user-a','acct-2',env)).size,0,'and the other account is unaffected');
});

void test('two writes against one revision produce exactly one winner',async()=>{
  seedAccount('acct-1');
  const results=await Promise.allSettled([
    saveSenderRule('user-a','acct-1','news@berkeley.edu',0,'junk',env),
    saveSenderRule('user-a','acct-1','news@berkeley.edu',0,'not-junk',env),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'one write succeeds');
  assert.equal(results.filter(r=>r.status==='rejected').length,1,'and one is refused as a conflict');
  const rule=(await loadSenderRules('user-a','acct-1',env)).get('news@berkeley.edu');
  assert.equal(rule?.revision,1,'the revision advanced exactly once');
  assert.ok(rule?.active);
});

void test('marking and clearing a sender never rewrites the automatic baseline',async()=>{
  seedAccount('acct-1');
  seedMessage('acct-1','m1','news@berkeley.edu');
  const baselineBefore=JSON.parse((storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?')
    .get('acct-1') as {data:string}).data).emails[0].automaticClassification;
  for(const action of [{type:'set-sender-junk-preference',value:'junk'},{type:'clear-sender-junk-preference'}] as const){
    const revision=(await loadSenderRules('user-a','acct-1',env)).get('news@berkeley.edu')?.revision??0;
    const response=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:0,
      expectedSenderRevision:revision,action}));
    assert.equal(response.status,200);
  }
  const baselineAfter=JSON.parse((storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?')
    .get('acct-1') as {data:string}).data).emails[0].automaticClassification;
  // A sender rule is composed on top of the classifier's record; it never edits it, which
  // is what makes removing the rule a complete restoration rather than a guess.
  assert.deepEqual(baselineAfter,baselineBefore,'the classifier record is untouched');
});

void test('disconnecting an account removes its sender rules and tombstones only',async()=>{
  seedAccount('acct-1');seedAccount('acct-2');
  await saveSenderRule('user-a','acct-1','news@berkeley.edu',0,'junk',env);
  await saveSenderRule('user-a','acct-1','cleared@berkeley.edu',0,'junk',env);
  await saveSenderRule('user-a','acct-1','cleared@berkeley.edu',1,undefined,env); // leaves a tombstone
  await saveSenderRule('user-a','acct-2','news@berkeley.edu',0,'junk',env);
  assert.equal((await loadSenderRules('user-a','acct-1',env)).size,2,'one active rule and one tombstone');

  storage.sql.prepare('DELETE FROM sender_rules WHERE account_id=? AND user_id=?').run('acct-1','user-a');
  assert.equal((await loadSenderRules('user-a','acct-1',env)).size,0,'both are removed with the account');
  assert.equal((await loadSenderRules('user-a','acct-2',env)).get('news@berkeley.edu')?.junkPreference,'junk',
    'while the other account keeps its own rule');
});

void test('a rule applies to every stored message from that sender, and stops when cleared',async()=>{
  seedAccount('acct-1');
  seedMessage('acct-1','m1','News@Berkeley.EDU');
  seedMessage('acct-1','m2','news@berkeley.edu');
  seedMessage('acct-1','m3','someone@berkeley.edu');
  await saveSenderRule('user-a','acct-1','news@berkeley.edu',0,'junk',env);

  const marked=await readMailbox('user-a','acct-1',env);
  const category=(id:string)=>marked.emails.find(email=>email.id===id)?.category;
  assert.equal(category('m1'),'noise','a mixed-case form of the sender moves');
  assert.equal(category('m2'),'noise','every existing message, not just the one acted on');
  assert.notEqual(category('m3'),'noise','and nobody else moves');
  // The saved preference and its revision reach the browser on an ordinary mailbox read,
  // which is what makes the Undo control available on a later visit.
  const first=marked.emails.find(email=>email.id==='m1');
  assert.equal(first?.senderJunkPreference,'junk');
  assert.equal(first?.senderRuleRevision,1,'the stored revision is visible through the canonical lookup');

  await saveSenderRule('user-a','acct-1','news@berkeley.edu',1,undefined,env);
  const cleared=await readMailbox('user-a','acct-1',env);
  const after=cleared.emails.find(email=>email.id==='m1');
  assert.notEqual(after?.category,'noise','clearing returns them to automatic sorting');
  assert.equal(after?.senderJunkPreference,undefined,'with no preference left');
  assert.equal(after?.senderRuleRevision,2,'but the cleared revision still reported');
});

void test('completing and reopening a request updates reply state in correction responses and mailbox reads',async()=>{
  seedAccount('acct-1');
  const baseline=automatic();
  const email={id:'m1',accountId:'acct-1',sender:'Sender',address:'sender@example.com',initials:'S',subject:'Review',summary:'Review',body:'Please approve invoice 42.',time:'Now',category:'work',priority:'normal',needsReply:true,unread:false,color:'blue',classification:baseline,automaticClassification:baseline};
  storage.sql.prepare('INSERT INTO snapshots (account_id,user_id,data,updated) VALUES (?,?,?,?)').run('acct-1','user-a',JSON.stringify({emails:[email],ai:false,pending:0,skipped:0,analysisVersion:'test',updated:NOW,limit:60,hasMore:false}),NOW);
  for(const [revision,state,expected] of [[0,'completed',false],[1,'open',true]] as const){
    const response=await correctMessage(request({accountId:'acct-1',messageId:'m1',expectedRevision:revision,
      action:{type:'set-obligation-state',obligationKey:obligationCorrectionKey(baseline.obligations[0]),state}}));
    assert.equal(response.status,200);
    const body=await response.json() as {email:Email};assert.equal(body.email.needsReply,expected);
    if(state==='completed'){
      // A sync may cache the corrected false flag before the task is reopened. A sync stores
      // the flag together with the corrected classification it came from; a cleared flag
      // beside a classification that still owes a reply is what a send leaves behind.
      const data=JSON.parse((storage.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get('acct-1') as {data:string}).data);
      data.emails[0].needsReply=false;
      data.emails[0].classification={...data.emails[0].classification,replyRequired:false};
      storage.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(JSON.stringify(data),'acct-1');
    }
    const mailbox=await readMailbox('user-a','acct-1',env);
    assert.equal(mailbox.emails[0].needsReply,expected);
  }
});
