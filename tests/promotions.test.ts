import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deterministicClassify, type ClassifiableMessage } from '../lib/deterministic';
import { applyPolicy, isResolved, obligationCorrectionKey, type Classification } from '../lib/classification';
import { evaluateImportance } from '../lib/importance';
import { applyPurposeChecks, assessPurpose } from '../lib/purpose';
import { validateItem } from '../server/classify';
import { applyOverride, contentFingerprint } from '../server/overrides';
import type { NormalizedMessage } from '../server/message';
import type { Email } from '../lib/mail';

/**
 * Promotional mail must not reach Work or Important, and the checks that keep it out must
 * not cost a receipt, a security event or a real request. Every case is synthetic, with a
 * fixed clock, and is checked on the full derived result rather than one field.
 */

const NOW=Date.UTC(2026,8,28,17,0,0); // Monday 2026-09-28 17:00Z
const RECEIVED=NOW-3600000;
const USER='alex@studio.example';

type Mail=Partial<Omit<ClassifiableMessage,'from'>>&{subject:string;text:string;from:string};
function message(id:string,over:Mail):ClassifiableMessage{
  return {id,subject:over.subject,text:over.text,quoted:over.quoted||'',
    from:{name:over.from.split('@')[0],address:over.from},
    to:over.to||[{address:USER}],cc:over.cc||[],receivedAt:over.receivedAt??RECEIVED,
    labels:over.labels||['INBOX'],attachments:over.attachments||[],
    contentComplete:over.contentComplete??true,calendar:over.calendar,distribution:over.distribution};
}

/** The full derived result the interface would show. */
function derive(classification:Classification,receivedAt=RECEIVED){
  const policy=applyPolicy(classification,NOW);
  const importance=evaluateImportance({id:'x',subject:'',classification,receivedAt} as unknown as Email,NOW);
  return {
    section:policy.category,disposition:policy.classification.disposition,tags:policy.tags,
    needsReply:classification.replyRequired,
    required:classification.obligations.filter(o=>o.required&&!isResolved(o)&&o.ownerIsUser!==false).map(o=>o.kind).sort(),
    securityEvent:classification.securityEvent,important:importance.important,
  };
}
const classify=(id:string,over:Mail)=>deterministicClassify(message(id,over),USER);

/** The promotion policy: Noise, normal priority, no reply, no required task, not important. */
function assertPromotion(result:ReturnType<typeof derive>,name:string){
  assert.equal(result.section,'noise',`${name}: section`);
  assert.equal(result.disposition,'junk',`${name}: disposition`);
  assert.deepEqual(result.tags,['junk'],`${name}: tags`);
  assert.equal(result.needsReply,false,`${name}: needsReply`);
  assert.deepEqual(result.required,[],`${name}: required obligations`);
  assert.equal(result.securityEvent,false,`${name}: securityEvent`);
  assert.equal(result.important,false,`${name}: important`);
}

// ── The seven reproductions ────────────────────────────────────────────────

void test('A: a sale\'s "last call" is Noise, not a meeting',()=>{
  const result=classify('A',{from:'deals@shop.example',subject:'Last call: 25% off everything',text:'Shop now. Use coupon SAVE25. Sale ends tonight.'});
  assertPromotion(derive(result),'A');
  assert.ok(!result.obligations.some(o=>o.kind==='meeting'),'no meeting is extracted at all');
});

void test('B: an abandoned cart is Noise, not a transaction, despite "your order"',()=>{
  const result=classify('B',{from:'hello@shop.example',subject:'Your cart is waiting',text:'Complete your order today. Return to your cart. Shop now for 15% off.'});
  assertPromotion(derive(result),'B');
  assert.ok(!assessPurpose({subject:'Your cart is waiting',text:'Complete your order today. Return to your cart. Shop now for 15% off.'}).preserve.some(p=>p.kind==='transaction'));
});

void test('C: an upsell is optional, not an account task',()=>{
  const derived=derive(classify('C',{from:'team@saasapp.example',subject:'Upgrade your plan',text:'Please update your account to unlock premium features.'}));
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.important,false);
  assert.equal(derived.needsReply,false);
  assert.notEqual(derived.section,'work','an upsell is not work correspondence');
  assert.ok(!derived.tags.includes('actions'),'a sales call to action adds no task tag');
});

void test('D: an invitation to register is neither a reply nor a meeting',()=>{
  const result=classify('D',{from:'events@saasapp.example',subject:'Register for our product webinar',text:'Please confirm your place by September 30. Join our Zoom session to see the new platform.'});
  const derived=derive(result);
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.needsReply,false);
  assert.equal(derived.important,false);
  assert.notEqual(derived.section,'work');
  assert.ok(!derived.tags.includes('meetings')&&!derived.tags.includes('requests'));
});

void test('E: password advice in a sale is Noise, not a security event',()=>{
  assertPromotion(derive(classify('E',{from:'offers@securevault.example',subject:'Protect your account',text:'Learn about password reset best practices. Limited time discount. Buy now.'})),'E');
});

void test('F: research vocabulary does not exempt a sales pitch',()=>{
  const result=classify('F',{from:'sales@datatools.example',subject:'New dataset tool',text:'Our dataset platform is on sale. Shop now for a discount.'});
  assertPromotion(derive(result),'F');
  assert.deepEqual(result.topics,[]);
});

void test('G: a cold sales call is a solicitation, not a meeting or a reply',()=>{
  assertPromotion(derive(classify('G',{from:'jordan@leadgenco.example',subject:'Quick question',text:'Could you join a call tomorrow to discuss buying our lead-generation service?'})),'G');
});

// ── Legitimate mail that must stay protected ───────────────────────────────

void test('a real client asking for a review by a date stays work and important',()=>{
  const derived=derive(classify('client',{from:'greta@halvorsen-logistics.example',subject:'Q3 access report',
    text:'Could you review the Q3 access report and send comments by September 30? Our auditors need it that week.'}));
  assert.equal(derived.section,'work');
  assert.ok(derived.required.includes('request'));
  assert.equal(derived.needsReply,true);
  assert.equal(derived.important,true);
});

void test('a paid receipt from a sender that also advertises keeps the receipt',()=>{
  const result=classify('receipt',{from:'orders@shopsupply.example',subject:'Your order #4471 receipt',
    text:'Thanks for your order. Receipt below. Total $42.00 charged to your card. Get 10% off your next order with code THANKS10. Shop now.'});
  const derived=derive(result);
  assert.notEqual(derived.section,'noise','a promotional footer does not bury a receipt');
  assert.equal(derived.important,false);
  assert.deepEqual(derived.required,[]);
});

void test('a payment failure requiring action is kept and important',()=>{
  const derived=derive(classify('failed',{from:'billing@brightline.example',subject:'Your payment failed',
    text:'We could not process your payment of $64.99. Please update your card by September 30 to avoid an interruption in service.'}));
  assert.notEqual(derived.section,'noise');
  assert.ok(derived.required.includes('action'));
  assert.equal(derived.important,true);
});

void test('an actual upcoming renewal charge is kept out of Noise',()=>{
  const derived=derive(classify('renewal',{from:'billing@queryhub.example',subject:'Your subscription renews October 1',
    text:'Your Team plan will automatically renew on October 1 for $4,800. To change seats or cancel, update your plan before then.'}));
  assert.notEqual(derived.section,'noise');
  assert.notEqual(derived.disposition,'junk');
});

void test('an optional offer to begin a trial is Noise',()=>{
  assertPromotion(derive(classify('trial',{from:'hello@notesapp.example',subject:'Start your free trial of Pro',
    text:'Try Pro free for 14 days. Start your free trial today, no credit card needed.',labels:['INBOX','CATEGORY_PROMOTIONS']})),'trial');
});

void test('a password-reset event is a security event and important',()=>{
  const derived=derive(classify('reset',{from:'noreply@codehost.example',subject:'Password reset request',
    text:'We received a request to reset your password at 8:55am. If you did not request this, you can ignore this email.'}));
  assert.equal(derived.securityEvent,true);
  assert.notEqual(derived.section,'noise');
  assert.equal(derived.important,true);
});

void test('a reported new sign-in is a security event',()=>{
  const derived=derive(classify('signin',{from:'it-security@studio.example',subject:'New sign-in to your account',
    text:'A new sign-in to your account was detected from Chrome on Windows. If this was not you, reset your password now.'}));
  assert.equal(derived.securityEvent,true);
  assert.equal(derived.important,true);
});

void test('a security product advertisement is Noise',()=>{
  assertPromotion(derive(classify('vault',{from:'offers@vaultly.example',subject:'Security alert: is your password safe?',
    text:'Hackers steal millions of passwords. Protect yourself with Vaultly. Get 40% off for a limited time. Buy now.'})),'vault');
});

void test('a confirmed webinar registration keeps its meeting; an invitation to register does not',()=>{
  const registered=derive(classify('registered',{from:'events@datalake.example',subject:'You\'re registered: Forecasting Churn webinar',
    text:'You\'re registered for Forecasting Churn with Survival Models, tomorrow at 9:00am PT. Join the webinar from the link in your calendar invitation. Unsubscribe from event emails.',
    distribution:{listUnsubscribe:true}}));
  assert.notEqual(registered.section,'noise');
  assert.ok(registered.required.includes('meeting'),'the registered session is a real event');

  const invited=derive(classify('invite',{from:'events@datalake.example',subject:'Register for our free webinar on October 14',
    text:'Register now for our free webinar on October 14. Seats are limited, so reserve your seat today.',distribution:{listUnsubscribe:true}}));
  assertPromotion(invited,'invite');
});

void test('an interview invitation from a new recruiter is real work',()=>{
  const derived=derive(classify('interview',{from:'kelsey@talentloop.example',subject:'Interview invitation: Senior Analyst',
    text:'Hi Alex, thanks for applying. We would like to invite you to an interview on Thursday, October 1 at 2pm. Could you confirm that time works?'}));
  assert.equal(derived.section,'work');
  assert.ok(derived.required.includes('meeting')&&derived.required.includes('request'));
  assert.equal(derived.needsReply,true);
  assert.equal(derived.important,true);
});

void test('a research newsletter with an unsubscribe link stays useful research, not important',()=>{
  const derived=derive(classify('research',{from:'briefing@nature-news.example',subject:'This week in genomics: three preprints',
    text:'A dataset release on variant calling, a preprint on reproducible sequencing pipelines, and commentary on peer review. Unsubscribe or manage your preferences.',
    distribution:{listUnsubscribe:true},labels:['INBOX','CATEGORY_UPDATES']}));
  assert.equal(derived.section,'work');
  assert.ok(derived.tags.includes('research'));
  assert.equal(derived.important,false);
});

void test('a vendor\'s required migration is kept; an optional paid upgrade is not a task',()=>{
  const migration=derive(classify('migrate',{from:'notices@vendorapi.example',subject:'Action required: migrate to API v2 by October 15',
    text:'API v1 will be shut down on October 15. You must update your integration to v2 before then to avoid disruption.'}));
  assert.notEqual(migration.section,'noise');
  assert.ok(migration.required.includes('action'));

  const upgrade=derive(classify('upgrade',{from:'notices@vendorapi.example',subject:'Upgrade to Pro',
    text:'Upgrade to Pro to unlock advanced analytics. Upgrade now and get your first month at a special price.'}));
  assert.deepEqual(upgrade.required,[]);
  assert.equal(upgrade.important,false);
});

void test('a real invoice keeps its own due date despite a coupon in the footer',()=>{
  const result=classify('invoice',{from:'billing@printco.example',subject:'Invoice INV-2291',
    text:'Invoice INV-2291 for $420.00 is due September 30. Pay in the customer portal. Save 10% on your next order with code SAVE10, offer expires October 20.'});
  const derived=derive(result);
  assert.notEqual(derived.section,'noise');
  const deadline=result.obligations.find(o=>o.kind==='deadline');
  assert.ok(deadline?.required,'the invoice is a real deadline');
  assert.equal(deadline?.due?.date,'2026-09-30','the date is the invoice\'s, not the offer\'s');
  assert.equal(derived.important,true);
});

void test('a promotional countdown elsewhere does not suppress a genuine deadline',()=>{
  const result=classify('countdown-mixed',{from:'registrar@college.example.edu',subject:'Housing registration',
    text:'Housing registration closes October 1. Our bookstore sale ends tonight.'});
  const deadline=result.obligations.find(o=>o.kind==='deadline');
  assert.ok(deadline?.required);
  assert.equal(deadline?.due?.date,'2026-10-01');
});

void test('a colleague\'s task about a customer\'s campaign is still work',()=>{
  const derived=derive(classify('campaign',{from:'priya@studio.example',subject:'Campaign copy review',
    text:'Can you review the \'Last chance: 30% off\' banner copy for Acme by Wednesday? The client signs off Thursday.'}));
  assert.equal(derived.section,'work');
  assert.ok(derived.required.includes('request'));
  assert.equal(derived.needsReply,true);
  assert.equal(derived.important,true);
});

void test('an incomplete message is not treated as a promotion or as safe',()=>{
  const result=classify('incomplete',{from:'updates@retailer.example',subject:'Your weekly update',text:'',
    contentComplete:false,labels:['INBOX','CATEGORY_PROMOTIONS'],distribution:{listUnsubscribe:true}});
  const derived=derive(result);
  assert.notEqual(derived.disposition,'junk','distribution evidence alone is never enough');
  assert.deepEqual(derived.required,[]);
  assert.equal(result.uncertainty,'Message content was incomplete.');
});

void test('a message whose only request is in quoted history creates no task',()=>{
  const derived=derive(classify('quoted',{from:'sarah@studio.example',subject:'Re: budget',text:'Thanks, that all looks good.',
    quoted:'On Mon, Sarah wrote:\n> Could you approve the budget by Friday?'}));
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.needsReply,false);
  assert.equal(derived.important,false);
});

void test('a customer-service number and a syncing feature are not meetings',()=>{
  const result=classify('support',{from:'orders@homegoods.example',subject:'Your order #5521 has shipped',
    text:'Your order #5521 has shipped. Questions? Call us at 1-800-555-0100. Your wishlist now syncs across devices.'});
  assert.ok(!result.obligations.some(o=>o.kind==='meeting'));
  assert.notEqual(derive(result).section,'noise');
});

// ── Manual decisions keep their precedence ─────────────────────────────────

void test('Keep on a promotion files it out of Noise without inventing a task or importance',()=>{
  const automatic=classify('keep',{from:'deals@shop.example',subject:'Last call: 25% off everything',text:'Shop now. Use coupon SAVE25. Sale ends tonight.'});
  const kept=applyOverride(automatic,{messageId:'keep',addTags:[],removeTags:[],junkPreference:'not-junk',source:'message',createdAt:NOW,revision:1,active:true});
  const derived=derive(kept);
  assert.notEqual(derived.section,'noise');
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.important,false);
});

void test('Junk on a legitimate request is honoured',()=>{
  const automatic=classify('junked',{from:'greta@halvorsen-logistics.example',subject:'Q3 access report',text:'Could you review the Q3 access report by October 2?'});
  const junked=applyOverride(automatic,{messageId:'junked',addTags:[],removeTags:[],junkPreference:'junk',source:'message',createdAt:NOW,revision:1,active:true});
  const derived=derive(junked);
  assert.equal(derived.section,'noise');
  assert.equal(derived.important,false);
});

// ── The model path passes through the same checks ──────────────────────────

function normalized(id:string,over:Mail&{distribution?:{listUnsubscribe:boolean;bulkPrecedence:boolean}}):NormalizedMessage{
  const m=message(id,over);
  return {id,threadId:id,messageId:'',receivedAt:m.receivedAt,from:m.from,to:m.to.map(p=>({name:'',address:p.address})),cc:[],
    subject:m.subject,text:m.text,quoted:m.quoted,signature:'',labels:m.labels,headers:{},attachments:[],htmlOnly:false,
    contentComplete:true,incompleteReasons:[],distribution:over.distribution};
}
const modelItem=(id:string,over:Record<string,unknown>)=>({id,context:'work',topics:[],disposition:'useful',replyRequired:true,
  securityEvent:false,reason:'Model reason.',summary:'Model summary.',obligations:[],...over});

void test('a model that turns a shopping instruction into a required task is overruled',()=>{
  const source=normalized('mB',{from:'hello@shop.example',subject:'Your cart is waiting',text:'Complete your order today. Return to your cart. Shop now for 15% off.'});
  const validated=validateItem(modelItem('mB',{obligations:[{kind:'action',description:'Complete the order',owner:'recipient',
    ownerIsUser:'yes',required:true,evidence:'Complete your order today.',state:'open',datePhrase:'today'}]}),source);
  assert.ok(validated.ok);
  const result=validated.classification;
  assert.equal(result.obligations[0].required,false,'the quote is supported but the task is optional');
  assertPromotion(derive(result),'model B');
});

void test('a model\'s security flag and research topic do not survive a clear promotion',()=>{
  const source=normalized('mE',{from:'offers@securevault.example',subject:'Protect your account',text:'Learn about password reset best practices. Limited time discount. Buy now.'});
  const validated=validateItem(modelItem('mE',{securityEvent:true,topics:['research'],replyRequired:false}),source);
  assert.ok(validated.ok);
  assertPromotion(derive(validated.classification),'model E');
});

void test('a model\'s promotional meeting is not a meeting',()=>{
  const source=normalized('mA',{from:'deals@shop.example',subject:'Last call: 25% off everything',text:'Shop now. Use coupon SAVE25. Sale ends tonight.'});
  const validated=validateItem(modelItem('mA',{obligations:[{kind:'meeting',description:'Last call',owner:'recipient',ownerIsUser:'yes',
    required:true,evidence:'Last call: 25% off everything',state:'open',meetingState:'proposed'}]}),source);
  assert.ok(validated.ok);
  assertPromotion(derive(validated.classification),'model A');
});

void test('an ambiguous upsell keeps the model\'s judgement but loses the required task',()=>{
  const source=normalized('mC',{from:'team@saasapp.example',subject:'Upgrade your plan',text:'Please update your account to unlock premium features.'});
  const validated=validateItem(modelItem('mC',{obligations:[{kind:'action',description:'Update account',owner:'recipient',ownerIsUser:'yes',
    required:true,evidence:'Please update your account to unlock premium features.',state:'open'}]}),source);
  assert.ok(validated.ok);
  const derived=derive(validated.classification);
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.needsReply,false);
  assert.equal(derived.important,false);
});

void test('a model\'s real client request passes through untouched',()=>{
  const source=normalized('mClient',{from:'greta@halvorsen-logistics.example',subject:'Q3 access report',text:'Could you review the Q3 access report and send comments by September 30?'});
  const item=modelItem('mClient',{obligations:[{kind:'request',description:'Review the report',owner:'recipient',ownerIsUser:'yes',
    required:true,evidence:'Could you review the Q3 access report and send comments by September 30?',state:'open',datePhrase:'September 30'}]});
  const validated=validateItem(item,source);
  assert.ok(validated.ok);
  const derived=derive(validated.classification);
  assert.equal(derived.section,'work');
  assert.deepEqual(derived.required,['request']);
  assert.equal(derived.needsReply,true);
  assert.equal(derived.important,true);
});

// ── The assessment itself ──────────────────────────────────────────────────

void test('repeated copies of one call to action count as one signal family',()=>{
  const purpose=assessPurpose({subject:'New arrivals',text:Array(10).fill('Shop now.').join(' ')});
  assert.deepEqual(purpose.families,['call-to-action']);
  assert.equal(purpose.evidence.length,1);
});

void test('distribution evidence alone never makes a promotion',()=>{
  const purpose=assessPurpose({subject:'Your monthly statement',text:'Your statement is available. Manage your email preferences.',
    labels:['CATEGORY_PROMOTIONS'],from:{address:'news@bank.example'},distribution:{listUnsubscribe:true}});
  assert.equal(purpose.promotion,'absent');
  assert.ok(purpose.distribution.length>=3,'the signals are still reported');
});

void test('preview padding and links do not hide or create signals',()=>{
  const padded=assessPurpose({subject:'La​st ch​ance: 25% off',text:'͏​ Shop now before the sale ends.'});
  assert.equal(padded.promotion,'clear');
  const linkOnly=classify('link',{from:'friend@example.com',subject:'link',text:'https://shop.example/cart?promo=SAVE25&checkout=now'});
  assert.equal(linkOnly.obligations.length,0,'a URL is not task evidence');
});

void test('the purpose checks are idempotent and never add anything',()=>{
  const automatic=classify('idem',{from:'hello@shop.example',subject:'Your cart is waiting',text:'Complete your order today. Shop now for 15% off.'});
  const purpose=assessPurpose({subject:'Your cart is waiting',text:'Complete your order today. Shop now for 15% off.'});
  const once=applyPurposeChecks(automatic,purpose);
  assert.deepEqual(applyPurposeChecks(once,purpose),once);
  assert.ok(once.obligations.length<=automatic.obligations.length);
});

// ── Patterns found by re-sorting a real mailbox (reproduced synthetically) ──

void test('footer wording about preferences is not the recipient\'s task',()=>{
  const result=classify('footer',{from:'news@campus.example.edu',subject:'Campus life this week',
    text:'Here is what is happening on campus this week. You can update your preferences or unsubscribe at any time.'});
  assert.ok(!result.obligations.some(o=>o.kind==='action'||o.kind==='request'));
});

void test('"due to" gives a cause, not a due date',()=>{
  const result=classify('dueto',{from:'service@bank.example',subject:'We received your payment',
    text:'We received your payment on September 20. The site may be unavailable due to maintenance on September 8.'});
  assert.ok(!result.obligations.some(o=>o.kind==='deadline'));
});

void test('a full date outranks the weekday printed beside it',()=>{
  const result=classify('fulldate',{from:'office@society.example.org',subject:'Officer applications',
    text:'Completed applications are due online Wednesday, January 20, 2027 by 11:59pm.'});
  assert.equal(result.obligations.find(o=>o.kind==='deadline')?.due?.date,'2027-01-20');
});

void test('news copy mentioning an interview or catching up is not a meeting',()=>{
  for(const text of ['There is more news below, including an interview with the author of the year\'s best novel.',
    'Given the right supports, she was able to catch up quickly.']){
    assert.ok(!classify('news',{from:'newsletter@dailypaper.example',subject:'The Morning',text}).obligations.some(o=>o.kind==='meeting'),text);
  }
});

void test('a survey with a prize is optional, and it is not filed as Noise',()=>{
  const result=classify('survey',{from:'vcsa@campus.example.edu',subject:'Tell us about your first week + enter to win a $100 gift card',
    text:'Tell us about your first week. Complete the survey by October 3 and enter to win a $100 gift card.'});
  const derived=derive(result);
  assert.deepEqual(derived.required,[]);
  assert.equal(derived.important,false);
  assert.notEqual(derived.section,'noise','an institutional survey is not a sales promotion');
});

void test('a request never borrows a date from another sentence',()=>{
  const result=classify('borrow',{from:'mentor@club.example',subject:'Appointment booked: coffee chat',
    text:'Looking forward to meeting on Friday, September 4. I usually meet at the cafe but let me know if another place works.'});
  const request=result.obligations.find(o=>o.kind==='request');
  assert.ok(request,'the request is still found');
  assert.equal(request?.due,undefined);
});

void test('a task correction still applies after the purpose checks reclassify its message',()=>{
  // The correction is keyed by the task's own evidence, which the checks never rewrite.
  const automatic=classify('corrected',{from:'team@saasapp.example',subject:'Upgrade your plan',text:'Please update your account to unlock premium features.'});
  const task=automatic.obligations.find(o=>o.kind==='action');
  assert.ok(task,'the optional task is still extracted and visible');
  const key=obligationCorrectionKey(task!);
  const corrected=applyOverride(automatic,{messageId:'corrected',addTags:[],removeTags:[],source:'message',createdAt:NOW,revision:1,active:true,
    obligationStates:{[key]:'completed'}});
  assert.equal(corrected.obligations.find(o=>o.kind==='action')?.state,'completed');
  assert.notEqual(corrected.processingStatus,'needs_review','the correction matched exactly one task');
  // And the automatic baseline itself is untouched by the correction.
  assert.equal(automatic.obligations.find(o=>o.kind==='action')?.state,'open');
});

void test('campaign evidence is part of the classification fingerprint; reading a message is not',()=>{
  const base={subject:'Weekly picks',text:'New arrivals are here.',quoted:'',labels:['INBOX','UNREAD']};
  assert.equal(contentFingerprint(base),contentFingerprint({...base,labels:['INBOX']}),'marking read does not reclassify');
  assert.notEqual(contentFingerprint(base),contentFingerprint({...base,labels:['INBOX','CATEGORY_PROMOTIONS']}));
  assert.notEqual(contentFingerprint(base),contentFingerprint({...base,distribution:{listUnsubscribe:true,bulkPrecedence:false}}));
});

void test('reported ambiguous sales wording preserves genuine requests',()=>{
  for(const text of [
    'No hurry, but could you review the launch doc by September 30?',
    'Only 2 days left to submit your timesheet by September 30.',
    'Please complete your security clearance renewal form by September 30.',
    'Can you schedule a demo for Acme?',
    'Please complete your purchase order by September 30.',
    'Final call for papers: please submit the abstract by September 30.',
    "Don't miss this: the all-hands meeting is tomorrow.",
    'Please review the discount rate and coupon rate by September 30.',
    'Please confirm your spot on the roster.',
    'Can you join us, open to a quick call?',
  ]){
    const result=classify('real',{from:'person@client.example',subject:'Following up',text});
    assert.ok(result.obligations.some(o=>o.required),text);
    assert.notEqual(result.disposition,'junk',text);
  }
});

void test('2FA and two-factor authentication codes remain security notices',()=>{
  for(const subject of ['Your 2FA code','Your two-factor authentication code'])
    assert.equal(classify('code',{from:'security@service.example',subject,text:'123456'}).securityEvent,true);
});

void test('reported appointment and meeting phrases retain meeting obligations',()=>{
  for(const text of ['Are you free for a call Friday at 3pm?','Can we call tomorrow?',
    "Let's schedule a call for Friday.",'Reminder: dentist appointment Tuesday at 9am.',
    'Office hours moved to Zoom today at 4pm.','Can you join the Zoom at 3pm?',
    "Let's meet Thursday at 2pm.",'Interview scheduled for Thursday at 11am.',
    'Please attend the training session on Friday.']){
    const result=classify('meeting',{from:'person@client.example',subject:'Following up',text});
    assert.ok(result.obligations.some(o=>o.kind==='meeting'&&o.required),text);
  }
});

void test('product demo calendar invitations and mixed promotional appointments survive',()=>{
  const calendar=classify('demo',{from:'person@client.example',subject:'Q4 product demo',text:'Product demo for Tidewater',
    calendar:{summary:'Product demo for Tidewater',start:'2026-09-29T09:00:00Z',method:'REQUEST'}});
  assert.ok(calendar.obligations.some(o=>o.kind==='meeting'&&o.required));
  const appointment=classify('booking',{from:'bookings@service.example',subject:'Book now and save 20% on your next visit',
    text:'Your appointment is confirmed for September 29 at 9:00am.'});
  assert.ok(appointment.obligations.some(o=>o.kind==='meeting'&&o.required));
  assert.notEqual(appointment.disposition,'junk');
});

void test('mixed campaigns retain independent required deadlines in both classifiers',()=>{
  const source=normalized('mixed',{from:'person@client.example',subject:'Update',text:'Shop now for 50% off. Your membership renewal form is due September 30.'});
  const fallback=deterministicClassify(source,USER);
  assert.ok(fallback.obligations.some(o=>o.kind==='deadline'&&o.required));
  const result=validateItem(modelItem('mixed',{obligations:[{kind:'deadline',description:'Renew',owner:'recipient',ownerIsUser:'yes',
    required:true,evidence:'Your membership renewal form is due September 30.',state:'open',datePhrase:'September 30'}]}),source);
  assert.ok(result.ok);
  assert.ok(result.classification.obligations.some(o=>o.required));
  assert.notEqual(result.classification.disposition,'junk');
});

void test('AI coworker campaign requests and personal questions retain reply state',()=>{
  const source=normalized('qa',{from:'coworker@studio.example',subject:'Campaign review',text:'Our flash sale: 30% off sitewide, shop now. Can you QA the landing page before 3pm today?'});
  const result=validateItem(modelItem('qa',{obligations:[{kind:'request',description:'QA page',owner:'recipient',ownerIsUser:'yes',required:true,
    evidence:'Can you QA the landing page before 3pm today?',state:'open'}]}),source,USER);
  assert.ok(result.ok);assert.equal(result.classification.replyRequired,true);assert.notEqual(result.classification.disposition,'junk');
  const mom=normalized('mom',{from:'mom@gmail.com',subject:'Dinner',text:'No hurry. Are you coming home for dinner on Sunday?'});
  const personal=validateItem(modelItem('mom',{context:'personal',obligations:[],replyRequired:true}),mom);
  assert.ok(personal.ok);assert.equal(personal.classification.replyRequired,true);
});

void test('public provider domains confer neither Work context nor a promotion exemption',()=>{
  const source=message('public',{from:'stranger@gmail.com',subject:'Hello',text:'Thinking of you.',to:[{address:'alex@gmail.com'}]});
  assert.equal(deterministicClassify(source,'alex@gmail.com').context,'personal');
  assert.equal(deterministicClassify({...source,subject:'Shop now for 50% off',text:'Sale ends tonight.'},'alex@gmail.com').disposition,'junk');
});

void test('full calendar dates retain clock times and timezone uncertainty',()=>{
  for(const [suffix,expected] of [[' UTC','2026-09-29T15:00:00Z'],['',undefined]] as const){
    const result=classify('date',{from:'person@client.example',subject:'Review',text:`Please review the report by September 29 at 3pm${suffix}.`});
    const due=result.obligations.find(o=>o.kind==='request')?.due;
    assert.ok(due);assert.ok(due.phrase.includes('3pm'));assert.equal(due.time,expected);
    assert.equal(due.ambiguous,!suffix);
  }
});

void test('explicitly optional applications do not become Important because they have a closing date',()=>{
  const optional=classify('application',{from:'board@city.example',subject:'Board applications are open',
    text:'Applications are open. Please submit by September 30 if interested.'});
  assert.equal(derive(optional).important,false);
  const owned=classify('owned-application',{from:'board@city.example',subject:'Your application',
    text:'Your application is due September 30. Please submit it by September 30.'});
  assert.ok(owned.obligations.some(o=>o.required));
});

void test('a direct QA request survives campaign text in its own evidence',()=>{
  const source=normalized('qa-mixed',{from:'colleague@studio.example',subject:'Review the campaign',
    text:'Can you QA the landing page before 3pm today? Our flash sale is 30% off, shop now.'});
  const item=modelItem('qa-mixed',{obligations:[{kind:'request',description:'QA page',owner:'recipient',ownerIsUser:'yes',required:true,
    evidence:'Can you QA the landing page before 3pm today? Our flash sale is 30% off, shop now.',state:'open'}]});
  const validated=validateItem(item,source,USER);
  assert.ok(validated.ok);assert.ok(validated.classification.obligations.some(o=>o.required));
});
