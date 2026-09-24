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
  globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
  assert.equal((await loadSenderRules('user-a','acct-1',env)).size,0);
  assert.equal(await loadOverride('user-a','acct-1','m1',env),undefined);
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
