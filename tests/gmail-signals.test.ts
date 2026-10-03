import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicClassify, type ClassifiableMessage } from '../lib/deterministic';
import { applyPolicy, type Classification } from '../lib/classification';
import { evaluateImportance, IMPORTANCE } from '../lib/importance';
import { buildInboxRows, sortInboxEmails } from '../lib/inbox-priority';
import { inGmailInbox, selectEmails } from '../lib/categories';
import { foldSenderKey } from '../lib/folding';
import { gmailSignals } from '../lib/gmail-signals';
import { encode } from '../server/runtime';
import { parseMessage } from '../server/gmail';
import { completeStoredEmail } from '../server/messages';
import type { Email } from '../lib/mail';

/**
 * Gmail's own sorting (its tabs, Important marker and star) as evidence. It is kept on
 * every message, settles what the wording alone leaves open, and never outranks real
 * content or a correction the user made here. Every case is synthetic, with a fixed clock.
 */

const NOW=Date.UTC(2026,9,3,17,0,0);
const HOUR=3600000;
const DAY=24*HOUR;
const RECEIVED=NOW-HOUR;
const USER='alex@studio.example';

type Mail=Partial<Omit<ClassifiableMessage,'from'>>&{subject:string;text:string;from:string};
function message(id:string,over:Mail):ClassifiableMessage{
  return {id,subject:over.subject,text:over.text,quoted:over.quoted||'',
    from:{name:over.from.split('@')[0],address:over.from},
    to:over.to||[{address:USER}],cc:over.cc||[],receivedAt:over.receivedAt??RECEIVED,
    labels:over.labels||['INBOX'],attachments:over.attachments||[],
    contentComplete:over.contentComplete??true,calendar:over.calendar,distribution:over.distribution};
}
const classify=(id:string,over:Mail)=>deterministicClassify(message(id,over),USER);

function classification(over:Partial<Classification>={}):Classification{
  return {context:'personal',topics:[],obligations:[],disposition:'useful',replyRequired:false,
    securityEvent:false,processingStatus:'classified',reason:'test',version:'test',...over};
}
function email(id:string,over:Partial<Email>={}):Email{
  return {id,sender:'Sender',address:'sender@example.com',initials:'S',subject:id,summary:'',body:'',time:'',
    category:'personal',priority:'normal',needsReply:false,unread:false,color:'gray',
    receivedAt:RECEIVED,classification:classification(),...over};
}

// A newsletter with no selling in it: only Gmail's tab can say it is bulk mail.
const STUDIO_NEWS={from:'news@brand.example',subject:'This week at the studio',
  text:'Here is what happened this week at the studio. We hosted a reading night and repainted the lobby.'};

void test('Gmail signals are kept on every message, and other labels are not',()=>{
  const parsed=parseMessage({id:'signals',threadId:'thread',snippet:'Hello',internalDate:String(RECEIVED),
    labelIds:['INBOX','UNREAD','IMPORTANT','CATEGORY_UPDATES','Label_123','STARRED','SPAM'],
    payload:{mimeType:'text/plain',headers:[{name:'From',value:'Shop <orders@shop.example>'},{name:'Subject',value:'Order shipped'}],body:{data:encode('Your order has shipped.')}}});
  assert.deepEqual([...parsed.gmailLabels!].sort(),['CATEGORY_UPDATES','IMPORTANT','STARRED']);
  assert.equal(parsed.unread,true,'Unread keeps its own field');
});

void test('a stored record before signals were kept reads as unknown, not as none',()=>{
  assert.equal(completeStoredEmail({id:'old',subject:'Hi'})!.gmailLabels,undefined);
  assert.deepEqual(completeStoredEmail({id:'new',gmailLabels:['STARRED',7,'Label_9','STARRED']})!.gmailLabels,['STARRED']);
  assert.equal(gmailSignals('IMPORTANT'),undefined);
});

void test('a Promotions message with nothing real behind it is Noise',()=>{
  const plain=classify('plain',STUDIO_NEWS);
  assert.notEqual(plain.disposition,'junk','without Gmail\'s verdict the wording alone is not enough');
  for(const tab of ['CATEGORY_PROMOTIONS']){
    const tabbed=classify(tab,{...STUDIO_NEWS,labels:['INBOX',tab]});
    assert.equal(tabbed.disposition,'junk',tab);
    assert.equal(applyPolicy(tabbed,NOW).category,'noise',tab);
    assert.match(tabbed.reason,/Gmail filed this under Promotions/);
  }
});

void test('Gmail\'s tab never buries a receipt, a task, a colleague or a friend',()=>{
  const labels=['INBOX','CATEGORY_PROMOTIONS'];
  const receipt=classify('receipt',{from:'orders@shop.example',subject:'Your order #4471 has shipped',
    text:'Your order #4471 has shipped and arrives Thursday.',labels});
  assert.notEqual(receipt.disposition,'junk','a transaction');
  const task=classify('task',{from:'registrar@college.example',subject:'Form needed',
    text:'Please submit your housing form by October 9.',labels});
  assert.notEqual(task.disposition,'junk','a required task of the user\'s');
  const colleague=classify('colleague',{...STUDIO_NEWS,from:'sam@studio.example',labels});
  assert.notEqual(colleague.disposition,'junk','the user\'s own organisation');
  const friend=classify('friend',{...STUDIO_NEWS,from:'jordan.lee@gmail.com',labels});
  assert.notEqual(friend.disposition,'junk','a personal address');
  const unread=classify('incomplete',{...STUDIO_NEWS,text:'',contentComplete:false,labels});
  assert.notEqual(unread.disposition,'junk','content that could not be read');
});

void test('a question in a Forums post is the group\'s unless it names the user',()=>{
  const post={from:'list@groups.example',subject:'Lab notes',text:'Could you share the lab notes from Tuesday?'};
  assert.equal(classify('direct',post).replyRequired,true,'the same question sent directly is owed an answer');
  assert.equal(classify('group',{...post,labels:['INBOX','CATEGORY_FORUMS']}).replyRequired,false);
  const named=classify('named',{...post,text:'Alex, could you share the lab notes from Tuesday?',labels:['INBOX','CATEGORY_FORUMS']});
  assert.equal(named.replyRequired,true,'a question that names the user is theirs');
});

void test('Gmail\'s Important marker ranks recent mail above routine, never into Important',()=>{
  const flagged=evaluateImportance(email('flagged',{gmailLabels:['IMPORTANT']}),NOW);
  assert.equal(flagged.tier,'flagged');
  assert.equal(flagged.important,false);
  assert.equal(flagged.reasonCode,'gmail-important');
  const stale=evaluateImportance(email('stale',{gmailLabels:['IMPORTANT'],receivedAt:NOW-IMPORTANCE.recentRequest-DAY}),NOW);
  assert.equal(stale.tier,'routine','a week-old prediction is history');
  const mail=[email('routine',{receivedAt:NOW-60000}),email('flagged',{gmailLabels:['IMPORTANT']})];
  assert.deepEqual(sortInboxEmails(mail,NOW,'reply').map(item=>item.id),['flagged','routine'],'the reply tab ranks it above routine');
  assert.deepEqual(sortInboxEmails(mail,NOW).map(item=>item.id),['routine','flagged'],'sections pin only urgent mail, so newer mail comes first');
});

void test('a star is the user\'s own mark: Important, but below anything actually due',()=>{
  const starred=evaluateImportance(email('starred',{gmailLabels:['STARRED']}),NOW);
  assert.equal(starred.important,true);
  assert.equal(starred.tier,'aging');
  const due=email('due',{classification:classification({obligations:[{id:'d',kind:'deadline',description:'Submit',owner:'you',
    ownerIsUser:true,required:true,evidence:'Submit the form by tomorrow.',state:'open',due:{phrase:'tomorrow',date:new Date(NOW+DAY).toISOString().slice(0,10),ambiguous:false}}]})});
  assert.equal(evaluateImportance({...due,gmailLabels:['STARRED']},NOW).tier,'due-now','a real deadline keeps its own tier');
  const order=sortInboxEmails([email('starred',{gmailLabels:['STARRED']}),due],NOW).map(item=>item.id);
  assert.deepEqual(order,['due','starred']);
  const old=evaluateImportance(email('old',{gmailLabels:['STARRED'],receivedAt:NOW-IMPORTANCE.agingRequest-DAY}),NOW);
  assert.equal(old.important,false,'an old star does not keep mail in Important forever');
});

void test('a correction, a reply or Noise outranks every Gmail signal',()=>{
  const signals:Email['gmailLabels']=['STARRED','IMPORTANT'];
  assert.equal(evaluateImportance(email('corrected',{gmailLabels:signals,manuallyCorrected:true}),NOW).tier,'routine');
  assert.equal(evaluateImportance(email('replied',{gmailLabels:signals,replied:true}),NOW).tier,'routine');
  const junk=evaluateImportance(email('junk',{gmailLabels:signals,classification:classification({disposition:'junk'})}),NOW);
  assert.equal(junk.reasonCode,'noise');
  assert.equal(evaluateImportance(email('unknown'),NOW).tier,'routine','a record without signals is unchanged');
});

void test('the Inbox view is Gmail\'s homepage: in the inbox and on the Primary tab',()=>{
  const mail=[
    email('primary',{gmailLabels:['CATEGORY_PERSONAL'],inInbox:true}),
    email('untabbed',{gmailLabels:[],inInbox:true}),
    email('archived',{gmailLabels:['CATEGORY_PERSONAL'],inInbox:false}),
    email('promotion',{gmailLabels:['CATEGORY_PROMOTIONS'],inInbox:true}),
    email('update',{gmailLabels:['CATEGORY_UPDATES','IMPORTANT'],inInbox:true}),
    email('older-record'),
  ];
  assert.deepEqual(selectEmails(mail,'inbox').map(item=>item.id),['primary','untabbed','older-record'],
    'a record from before labels were kept is shown, not hidden');
  assert.equal(selectEmails(mail,'personal').length,mail.length,'sections still hold archived and tabbed mail');
  assert.equal(inGmailInbox({inInbox:false}),false);
});

void test('Inbox rows are newest first, one per conversation, and nothing else folds',()=>{
  const thread=(id:string,minutes:number)=>email(id,{threadId:'t1',address:'sam@studio.example',receivedAt:NOW-minutes*60000});
  const update=(id:string,minutes:number)=>email(id,{address:'notify@shop.example',subject:'Your order shipped',receivedAt:NOW-minutes*60000});
  const urgent=email('urgent',{receivedAt:NOW-90*60000,classification:classification({obligations:[{id:'u',kind:'deadline',
    description:'Pay',owner:'you',ownerIsUser:true,required:true,evidence:'Pay today.',state:'open',
    due:{phrase:'today',date:new Date(NOW).toISOString().slice(0,10),ambiguous:false}}]})});
  const mail=[thread('first',60),update('ship-1',5),urgent,thread('reply',10),update('ship-2',20)];
  const rows=buildInboxRows(mail,NOW,'newest',{},{conversationsOnly:true});
  assert.deepEqual(rows.map(row=>row.kind==='fold'?`fold:${row.emails.map(item=>item.id).join('+')}`:row.email.id),
    ['ship-1','fold:reply+first','ship-2','urgent'],'a thread sits at its newest message; urgency and topics change nothing');
  const separate=buildInboxRows(mail,NOW,'newest',{[foldSenderKey(mail[0])]:'separate'},{conversationsOnly:true});
  assert.equal(separate.filter(row=>row.kind==='fold').length,0,'a sender kept separate never folds');
  const sorted=buildInboxRows(mail,NOW,'importance',{});
  assert.equal(sorted[0].kind==='email'&&sorted[0].email.id,'urgent','the sections still rank and fold by topic');
});
