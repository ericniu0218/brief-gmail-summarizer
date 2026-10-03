import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSenderFamiliarity, checkSenderFamiliarity } from '../server/sender-familiarity';
import { withPurpose, CLASSIFY_INSTRUCTIONS } from '../server/classify';
import { normalizeMessage } from '../server/message';
import { syncInbox } from '../server/sync';
import { deterministicClassify } from '../lib/deterministic';
import { applyPolicy } from '../lib/classification';
import { applyOverride } from '../server/overrides';
import { rig, connect, gmailMessage } from './helpers/google';

const NOW=Date.UTC(2026,9,3,17),RECEIVED=NOW-3600000;
const finn=()=>normalizeMessage(gmailMessage({id:'joke',from:'Finn <finn@gmail.com>',to:'me@gmail.com',receivedAt:RECEIVED,
  subject:'A crude joke',body:'Word on the street is you are the guy to do it. Just how I like it.'}));
const familiar={status:'previously-emailed' as const,checkedAt:NOW,priorTo:RECEIVED};

function sentHistory(r:ReturnType<typeof rig>,over:{to?:string;time?:number;labels?:string[]}={}){
  const provider=globalThis.fetch;
  globalThis.fetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:input.toString());
    if(url.searchParams.get('labelIds')==='SENT'){
      r.calls.push({url:url.href,body:undefined as never});
      assert.match(url.searchParams.get('q')||'',/in:sent to:"finn@gmail.com" before:\d+/);
      return Response.json({messages:[{id:'sent-before'}]});
    }
    if(url.searchParams.get('format')==='metadata')return Response.json({labelIds:over.labels||['SENT'],internalDate:String(over.time??RECEIVED-3600000),
      payload:{headers:[{name:'To',value:over.to||'Finn <finn@gmail.com>'}]}});
    return provider(input,init);
  };
}

void test('familiarity requires an exact recipient, SENT label, and a message sent before arrival',async()=>{
  for(const over of [{},{to:'other@gmail.com'},{time:RECEIVED+1},{labels:['DRAFT']}]){
    const r=rig();try{
      sentHistory(r,over);
      const signal=await checkSenderFamiliarity('finn@gmail.com',RECEIVED,'token',NOW);
      assert.equal(signal?.status,Object.keys(over).length?'unknown':'previously-emailed');
    }finally{r.restore();}
  }
});

void test('sent evidence is reused only inside its mailbox and for messages after its cutoff',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');await connect(r,'user-a','b');
    r.storage.sql.prepare('INSERT INTO mailbox_messages(user_id,account_id,message_id,data,received_at,scan_generation) VALUES(?,?,?,?,?,?)')
      .run('user-a','a','cached',JSON.stringify({address:'finn@gmail.com',senderFamiliarity:familiar}),RECEIVED,'test');
    sentHistory(r);
    const existing=finn();await attachSenderFamiliarity([existing],'user-a','a','token',r.env,NOW);
    assert.equal(existing.senderFamiliarity?.status,'previously-emailed');assert.equal(r.calls.length,0);
    const other=finn();await attachSenderFamiliarity([other],'user-a','b','token',r.env,NOW);
    assert.equal(r.calls.length,1,'another mailbox must check its own history');
    const older={...finn(),receivedAt:RECEIVED-86400000};
    await attachSenderFamiliarity([older],'user-a','a','token',r.env,NOW);
    assert.equal(r.calls.length,2,'later correspondence cannot establish prior familiarity');
    assert.equal(older.senderFamiliarity?.status,'unknown');
  }finally{r.restore();}
});

void test('ambiguous direct mail from an existing correspondent stays visible; promotions and manual Junk still win',()=>{
  const message={...finn(),senderFamiliarity:familiar};
  const junk={...deterministicClassify(message,'me@gmail.com'),disposition:'junk' as const,reason:'Unsolicited inappropriate message.'};
  const checked=withPurpose(junk,message);
  assert.equal(applyPolicy(checked,NOW).category,'personal');
  assert.equal(checked.processingStatus,'needs_review');assert.match(checked.reason,/previously emailed/);
  assert.equal(applyPolicy(applyOverride(checked,{messageId:'joke',active:true,junkPreference:'junk',addTags:[],removeTags:[],source:'message',createdAt:NOW}),NOW).category,'noise');
  assert.equal(withPurpose(junk,{...message,labels:['SPAM']}).disposition,'junk');
  assert.equal(withPurpose(junk,{...message,subject:'Sale',text:'Buy now and save 50% with coupon code SAVE.'}).disposition,'junk');
  assert.equal(withPurpose(junk,{...message,senderFamiliarity:undefined}).disposition,'junk');
  assert.match(CLASSIFY_INSTRUCTIONS,/Crude language.*not evidence of junk/);
});

void test('sync stores verified familiarity and applies it to an older model classification without another model call',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a','me@gmail.com');
    r.messages.joke=gmailMessage({id:'joke',from:'Finn <finn@gmail.com>',receivedAt:RECEIVED,body:finn().text,subject:finn().subject});
    const { contentFingerprint }=await import('../server/overrides');
    const old={...deterministicClassify(finn(),'me@gmail.com'),disposition:'junk',reason:'Unsolicited inappropriate message.',version:'old-policy'};
    r.storage.sql.prepare('INSERT INTO mailbox_messages(user_id,account_id,message_id,data,received_at,scan_generation) VALUES(?,?,?,?,?,?)')
      .run('user-a','a','joke',JSON.stringify({id:'joke',address:'finn@gmail.com',automaticClassification:old,classificationSource:'ai',analysisVersion:'gemini:old',fingerprint:contentFingerprint(finn())}),RECEIVED,'old');
    sentHistory(r);
    const snapshot=await syncInbox('user-a','a',r.env);
    const email=snapshot.emails.find(email=>email.id==='joke')!;
    assert.equal(email.senderFamiliarity?.status,'previously-emailed');assert.equal(email.category,'personal');
    assert.equal(r.calls.filter(call=>call.url.includes('generativelanguage')).length,0);
  }finally{r.restore();}
});
