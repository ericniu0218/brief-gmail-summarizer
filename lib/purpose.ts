import type { Classification, Obligation } from './classification';

/**
 * What a message is *for*, judged separately from where it is filed and whether it owes
 * anyone anything.
 *
 * A promotion is recognised from combinations of evidence, never from one broad keyword or
 * a sender's name. Each signal family counts once however often it repeats, so a campaign
 * that prints "Shop now" ten times has one reason, not ten. Distribution evidence — the
 * Promotions tab, list headers, a bulk sender, a preferences footer — only ever supports a
 * commercial reading: receipts, research newsletters and useful notices share all of it.
 *
 * Classifying never acts on a message. Routing a promotion to Noise does not archive,
 * delete, unsubscribe, block or relabel anything, and says nothing about fraud.
 */

export type PromotionLevel='clear'|'ambiguous'|'absent';
export type CommercialFamily='offer'|'call-to-action'|'purchase-reminder'|'urgency'|'sales-outreach';
export type DistributionSignal='promotions-label'|'list-headers'|'bulk-sender'|'preferences-footer';
/** Evidence that the message records something real, which keeps it out of Noise. */
export type PreserveKind='transaction'|'security'|'registration'|'obligation'|'achievement';

export type PurposeAssessment={
  promotion:PromotionLevel;
  families:CommercialFamily[];
  distribution:DistributionSignal[];
  /** Short source excerpts behind the commercial reading, at most one per family. */
  evidence:string[];
  preserve:{kind:PreserveKind;evidence:string}[];
};

/** The parts of a message this reads. Everything beyond subject and text is optional. */
export type PurposeInput={
  subject:string;
  /** Text written in this message; quoted history is deliberately not part of it. */
  text:string;
  from?:{address?:string};
  labels?:string[];
  /** Derived from headers at the normalization boundary; absent on older records. */
  distribution?:{listUnsubscribe?:boolean;bulkPrecedence?:boolean};
};

const FAMILIES:[CommercialFamily,RegExp][]=[
  ['offer',/(?:\d{1,3}\s?%\s?off\b|\b(?:discount(?:ed)?|coupons?|promo(?:tional)? codes?|use (?:the )?code\s+[A-Z0-9]{3,}|free (?:gift|shipping|delivery)|introductory (?:price|pricing|offer|rate)|special (?:price|pricing|offer)|exclusive (?:offer|deal)|(?:is|are|now) on sale|on sale now|sale (?:ends|price)|clearance|save (?:up to )?\$?\d+|bogo|buy one,? get one|bundle (?:and|&) save|\$\d+ off\b|(?:great|hot|best|big|exclusive|delicious|daily|weekly|special|member) deals?\b|member (?:perks|benefits|pricing|rewards)\b|(?:perks|rewards|points) (?:are ready|won'?t last|to (?:be )?redeem)|redeem (?:your|them|now|today)\b|buy now,? pay later|free (?:food|delivery|trial|gift)\b))/i],
  ['call-to-action',/\b(?:shop (?:now|today|the|our|all|new)|buy (?:now|today)|order (?:now|today)|add to (?:cart|bag|basket)|return to (?:your )?(?:cart|bag|basket)|check ?out now|browse (?:our|the|new|all)|new arrivals|start (?:your|a) free trial|try (?:it )?(?:free|for free)|upgrade (?:now|today|your plan|to (?:pro|premium|plus|business))|unlock (?:premium|pro|more|additional|all|exclusive)|(?:book|request|schedule|get) (?:a |your )?(?:free )?demo|claim (?:your|the|this) (?:offer|discount|coupon|gift|reward|deal)|register (?:now|today|for (?:our|the|this|a) (?:free |live )?(?:product )?(?:webinar|demo|event|workshop|masterclass))|(?:reserve|save|confirm) your (?:seat|spot|place)|product (?:webinar|demo|tour)|see the new (?:platform|product|features?)|(?:explore|discover|browse|see|view) (?:the |our |all )?(?:new )?(?:collection|sets|deals|offers|products|menu|styles)|order (?:again|online today)|get yours|grab yours|treat yourself)\b/i],
  ['purchase-reminder',/\b(?:left (?:something |items? )?in your (?:cart|bag|basket)|your (?:cart|bag|basket) is waiting|items? (?:are |is )?(?:still )?in your (?:cart|bag|basket)|complete your (?:order|purchase|checkout)|finish (?:your )?checkout|still thinking (?:about|it over)|recommended for you|based on your (?:browsing|recent views|interests)|back in stock|selling (?:out )?fast|almost (?:gone|sold out))\b/i],
  ['urgency',/\b(?:last (?:chance|call)|final (?:call|hours|days)|ends (?:today|tonight|tomorrow|soon|at midnight)|(?:sale|offer|deal|discount|promotion) (?:ends|expires)|expires (?:today|tonight|soon|at midnight)|limited[- ](?:time|stock|offer|availability)|while (?:supplies|stocks) last|only \d+ (?:left|remaining|hours? left|days? left)|hurry|don'?t miss (?:out|this)|(?:seats|spots|places) are limited|won'?t last|(?:only |just )?(?:a few )?(?:hours|days) (?:remain|left)\b|countdown is on|(?:sale|offer|deal) (?:has been )?extended|before (?:they'?re|it'?s) gone|don'?t wait|last day to (?:save|shop|buy|order|upgrade|enroll|register|redeem|claim))\b/i],
  ['sales-outreach',/\b(?:(?:discuss|talk about|explore|consider) (?:buying|purchasing|investing in|adopting) (?:our|a|the)|lead[- ]generation|(?:15|20|30)[- ]min(?:ute)? (?:call|chat|demo)|open to a (?:quick |short )?(?:call|chat)|worth a (?:quick |short )?(?:call|chat)|grab (?:some )?time on my calendar|should i close your file|teams like yours|(?:our|this) (?:solution|platform|service|product|tool) (?:can|will|helps?) (?:you|your team))\b/i],
];
/** Outreach that states its commercial purpose outright, clear without a second family. */
const EXPLICIT_SOLICITATION=/\b(?:discuss|talk about|consider) (?:buying|purchasing|investing in) our\b|\bour (?:lead[- ]generation|marketing|seo|outsourcing|staffing) (?:service|agency|platform|solution)s?\b/i;

const PREFERENCES_FOOTER=/\b(?:unsubscribe|manage (?:your )?(?:email |notification )?preferences|update (?:your )?(?:email )?preferences|opt[- ]out|you(?:'re| are) receiving this (?:email|message) because)\b/i;
const BULK_SENDER=/(^|[.@])(no[-_]?reply|newsletter|marketing|promo|offers?|deals?|mailer|campaign|news)([.@]|$)/i;

// Something that happened, or an existing transaction that needs attention. "Your order"
// and "complete your order" are not here: an abandoned-cart advertisement says both.
const TRANSACTION=/\b(?:receipt|order (?:confirmation|confirmed|has (?:shipped|been (?:shipped|delivered|placed))|#\s?[A-Z0-9-]*\d|number\s?:?\s?[A-Z0-9-]*\d)|(?:has|have) (?:shipped|been delivered)|out for delivery|tracking (?:number|#)|payment (?:received|confirmation|confirmed|failed|declined|was declined|could not be processed|is (?:past )?due|overdue)|(?:we )?(?:charged|refunded) (?:your|\$)|refund (?:has been |was )?(?:processed|issued)|invoice\s?(?:#|number|no\.?)\s?[A-Z0-9-]*\d|amount due|balance due|minimum payment|booking (?:confirmation|confirmed|reference)|reservation (?:confirmed|confirmation)|itinerary|(?:will|to) automatically renew|auto[- ]?renew(?:s|al)? on|renews? (?:on|automatically)|will be charged|statement (?:is )?(?:now )?(?:available|ready))/i;

// A concrete account event. Advice about passwords, a security product pitch or a
// hypothetical breach does not qualify; "password reset best practices" is advice.
const SECURITY_EVENT=/\b(?:verification code|2fa code|two[- ]factor (?:authentication )?code|one[- ]time (?:code|password|passcode)|security code is|(?:login|sign[- ]in) code|new sign[- ]?in|signed in (?:to|from)|sign[- ]in (?:attempt|from)|unrecognized (?:login|sign[- ]in|device)|password (?:was|has been) (?:changed|reset|updated)|(?:received|got) a request to reset|requested (?:a )?password reset|reset request|new device (?:was )?added|verification method (?:was )?added|two[- ]factor (?:authentication )?(?:was |has been )?(?:enabled|disabled|turned (?:on|off))|(?:account|access) (?:has been |was |is )?(?:locked|suspended|disabled)|suspicious (?:activity|sign[- ]in) (?:on|detected))\b/i;

// An existing booking or registration: the event is real because the recipient signed up.
const REGISTRATION=/\b(?:you(?:'re| are) (?:registered|confirmed|booked)|registration (?:is )?confirmed|thanks for registering|your (?:registration|booking|reservation|appointment|interview) (?:is|has been) (?:confirmed|scheduled|booked)|your (?:seat|spot|place) is (?:reserved|confirmed)|appointment (?:reminder|confirmation)|interview (?:schedule|confirmation|invitation)|(?:invite|invitation) to (?:an? )?interview)\b/i;

// Something the recipient earned or finished: a certification, a qualification, a passed
// exam. Sales copy that surrounds it ("25% off a new certification card") does not undo the
// fact, and it is the one line of such a message the person may actually want. An object is
// required, so "congratulations on completing your order" is not an achievement.
const ACHIEVEMENT=/\b(?:congratulations on (?:achieving|earning|completing|passing|receiving|becoming)|you(?:'ve| have) (?:successfully )?(?:earned|achieved|completed|passed|been awarded|received))\b[^.!?\n]{0,80}?\b(?:certifications?|certificates?|qualifications?|diplomas?|degrees?|licen[cs]es?|badges?|credentials?|courses?|exams?)\b|\byour (?:new )?(?:certification|certificate|qualification|diploma|licen[cs]e|credential) (?:is|has been) (?:issued|ready|awarded|approved)\b/i;

// Harmless padding some campaigns use to control the inbox preview line.
// The combining grapheme joiner sits outside the class so it cannot combine with a neighbour.
const INVISIBLE=/[\u00ad\u180e\u200b-\u200f\u2060-\u2064\ufeff]|\u034f/g;
const URL=/\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// A commercial phrase inside quotation marks is being mentioned, not offered: "can you
// review the 'Last chance: 30% off' banner" is a task about a campaign.
const QUOTED_SPAN=/“[^”\n]{1,160}”|"[^"\n]{1,160}"|‘[^’\n]{1,160}’|(?:^|(?<=\s))'[^'\n]{1,160}'(?=[\s.,;:!?]|$)/g;

/** Text as it should be matched: padding and links gone, whitespace collapsed. */
export function matchableText(value:string){
  return value.replace(INVISIBLE,'').replace(URL,' ').replace(/[ \t\f\v]+/g,' ');
}

function sentencesOf(value:string){
  return matchableText(value).split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);
}

const clip=(value:string)=>value.slice(0,160);

/** Commercial families present in one sentence, with mentions in quotation marks removed. */
export function commercialFamiliesIn(sentence:string):CommercialFamily[]{
  const offered=matchableText(sentence).replace(QUOTED_SPAN,' ')
    .replace(/\b(?:no hurry|security clearance|discount rate|coupon rate|purchase order|final call for papers|confirm your spot on the roster)\b/gi,' ');
  return FAMILIES.filter(([,pattern])=>pattern.test(offered)).map(([family])=>family);
}

/**
 * Campaign footer wording ("update your preferences", "unsubscribe"). It describes how to
 * manage the mailing, never a duty the message assigns.
 */
export function isCampaignFooter(sentence:string){
  return PREFERENCES_FOOTER.test(matchableText(sentence));
}

const CONCRETE_TASK=/\b(?:could you|can you|please|must|need you to)\s+(?:review|qa|approve|submit|fix|test|complete)(?!\s+(?:your\s+)?(?:order|purchase|checkout)\b)\b/i;
// What is being reviewed or submitted decides whether it is work. "Please review the
// contract" is; "please review our exclusive offers" and "please submit your email to unlock
// discounts" are the campaign itself.
// "Our pricing" is the sender's; "the sales report" is somebody's work, so the broad nouns
// only count after "our" or "these".
const SALES_ADJECTIVES='(?:(?:exclusive|latest|new|special|limited|best|top|seasonal|holiday)\\s+)*';
const SALES_OBJECT=new RegExp(`^\\s*(?:(?:our|these) ${SALES_ADJECTIVES}(?:offers?|deals?|products?|collections?|catalog(?:ue)?|sales?|savings|discounts?|plans?|pricing|arrivals|picks|styles)`
  +`|(?:the|this) ${SALES_ADJECTIVES}(?:offers?|deals?|collections?|catalog(?:ue)?|savings|discounts?|new arrivals))\\b`,'i');
// "…your email to unlock exclusive discounts": the purpose clause names the reward.
const SALES_PURPOSE=/^\s*to (?:unlock|claim|redeem)\b/i;

/** A task verb whose object is real work rather than the thing being sold. */
function concreteTask(value:string){
  const text=matchableText(value).replace(QUOTED_SPAN,' ');
  const match=CONCRETE_TASK.exec(text);
  if(!match)return false;
  // Only the task's direct object, up to a comma, a conjunction or a purpose clause: sales
  // copy after "and" or in the next sentence says nothing about what is being reviewed.
  const rest=text.slice(match.index+match[0].length).split(/[.!?;]/)[0];
  const cut=rest.search(/,|\s(?:and|but|or|then)\s|\sto\s/i);
  const object=cut<0?rest:rest.slice(0,cut);
  const after=cut<0?'':rest.slice(cut);
  return !SALES_OBJECT.test(object)&&commercialFamiliesIn(object).length===0&&!SALES_PURPOSE.test(after);
}

/** A sentence whose purpose is to sell: completing it is optional by default. */
export function isCommercialSentence(sentence:string){
  const text=matchableText(sentence).replace(QUOTED_SPAN,' ');
  const families=commercialFamiliesIn(sentence);
  if(concreteTask(text))return false;
  return families.includes('purchase-reminder')||families.length>=2||/\b(?:offer|sale|discount|special pricing) (?:ends|expires)\b/i.test(text)||EXPLICIT_SOLICITATION.test(text)||
    /\b(?:shop (?:now|today|our|the)|buy (?:now|today)|unlock (?:premium|pro|more|exclusive)|(?:register for (?:our|the) (?:product )?(?:webinar|demo)|see the new (?:platform|product))|upgrade (?:now|your plan|to)|complete your (?:order|checkout|purchase(?! order))|finish (?:your )?checkout|claim (?:your|the) (?:offer|reward|discount))\b/i.test(text);
}

function firstMatch(sentences:string[],pattern:RegExp,skip?:(sentence:string)=>boolean){
  return sentences.find(sentence=>pattern.test(sentence)&&!skip?.(sentence));
}

/** Transaction evidence from a sentence that is not itself selling something. */
export function transactionEvidence(value:string){
  return firstMatch(sentencesOf(value),TRANSACTION,sentence=>commercialFamiliesIn(sentence).includes('purchase-reminder'));
}
export function securityEvidence(value:string){return firstMatch(sentencesOf(value),SECURITY_EVENT);}
export function registrationEvidence(value:string){return firstMatch(sentencesOf(value),REGISTRATION,isCommercialSentence);}
export function achievementEvidence(value:string){return firstMatch(sentencesOf(value),ACHIEVEMENT,isCommercialSentence);}

const normalizeQuote=(value:string)=>value.toLowerCase().replace(/\s+/g,' ').trim();

/** An obligation backed by something real rather than by wording in a sales message. */
export function independentlySupported(obligation:Obligation){
  const evidence=obligation.evidence||'';
  if(obligation.id?.endsWith(':calendar'))return true;
  return TRANSACTION.test(evidence)||SECURITY_EVENT.test(evidence)||REGISTRATION.test(evidence);
}

/**
 * Assess promotional intent. `obligations`, when given, lets the assessment report which
 * extracted tasks are credible enough to keep the message out of Noise.
 */
export function assessPurpose(input:PurposeInput,obligations:Obligation[]=[]):PurposeAssessment{
  const subject=matchableText(input.subject||'').trim();
  const body=sentencesOf(input.text||'');
  const sentences=[subject,...body].filter(Boolean);
  const found=new Map<CommercialFamily,string>();
  let commercial=0;
  for(const sentence of sentences){
    const families=commercialFamiliesIn(sentence);
    if(families.length)commercial++;
    for(const family of families)if(!found.has(family))found.set(family,clip(sentence));
  }
  const families=[...found.keys()];

  const distribution:DistributionSignal[]=[];
  const labels=Array.isArray(input.labels)?input.labels:[];
  if(labels.includes('CATEGORY_PROMOTIONS'))distribution.push('promotions-label');
  if(input.distribution?.listUnsubscribe||input.distribution?.bulkPrecedence)distribution.push('list-headers');
  const address=typeof input.from?.address==='string'?input.from.address.toLowerCase():'';
  if(BULK_SENDER.test(address))distribution.push('bulk-sender');
  if(PREFERENCES_FOOTER.test(matchableText(input.text||'')))distribution.push('preferences-footer');

  // Primary purpose: selling appears in the subject or opening, or makes up a real share of
  // what the message says. A sponsor block in the middle of a newsletter is neither.
  const opening=[subject,body[0]||''].some(isCommercialSentence);
  const share=sentences.length?commercial/sentences.length:0;
  const current=`${subject}\n${body.join('\n')}`;
  let promotion:PromotionLevel='absent';
  if(families.length){
    // A single line of sales copy beside real content ("our bookstore sale ends tonight"
    // under a registration deadline) is not what the message is for.
    // Campaigns are long: product copy, addresses and legal text dilute any share. The
    // subject and first sentence carry the purpose, so selling there is the main test.
    const clear=(families.length>=2&&opening)
      ||(families.length>=2&&share>=0.34)
      ||(families.length>=3&&share>=0.2)
      ||(distribution.length>0&&opening)
      ||(EXPLICIT_SOLICITATION.test(current.replace(QUOTED_SPAN,' ')));
    promotion=clear?'clear':'ambiguous';
  }

  const preserve:PurposeAssessment['preserve']=[];
  const transaction=transactionEvidence(`${input.subject}\n${input.text||''}`);
  if(transaction)preserve.push({kind:'transaction',evidence:clip(transaction)});
  const security=securityEvidence(`${input.subject}\n${input.text||''}`);
  if(security)preserve.push({kind:'security',evidence:clip(security)});
  const registration=registrationEvidence(`${input.subject}\n${input.text||''}`);
  if(registration)preserve.push({kind:'registration',evidence:clip(registration)});
  const achievement=achievementEvidence(`${input.subject}\n${input.text||''}`);
  if(achievement)preserve.push({kind:'achievement',evidence:clip(achievement)});
  for(const obligation of obligations){
    if(obligation.required&&obligation.ownerIsUser!==false&&obligation.evidence?.trim())
      preserve.push({kind:'obligation',evidence:clip(obligation.evidence)});
  }

  return {promotion,families,distribution,evidence:[...found.values()].slice(0,4),preserve:preserve.slice(0,4)};
}

/**
 * The checks every classification passes through, whichever classifier produced it. A
 * model that quotes "Complete your order today" has proved the words exist, not that the
 * recipient owes anyone a purchase.
 *
 * - An obligation whose own sentence is selling something becomes optional.
 * - Independent tasks and existing calendar invitations survive surrounding sales copy.
 * - A security flag needs a concrete account event once the message is clearly selling.
 * - Research vocabulary does not make a sales pitch research.
 * - A reply is not owed when every request turned out to be a sales call to action.
 *
 * Idempotent, and it never adds an obligation, a topic or a flag.
 */
export function applyPurposeChecks(input:Classification,assessment:PurposeAssessment):Classification{
  // A record of something the recipient earned is never buried in Junk automatically,
  // whichever classifier proposed it and however much sales copy surrounds it.
  const record=assessment.preserve.find(p=>p.kind==='achievement');
  const classification=record&&!input.preservedEvidence?{...input,preservedEvidence:record.evidence}:input;
  if(assessment.promotion==='absent')return classification;
  const clear=assessment.promotion==='clear';
  const obligations=(Array.isArray(classification.obligations)?classification.obligations:[]).map(obligation=>{
    if(!obligation.required)return obligation;
    const evidence=obligation.evidence||'';
    const campaignCall=assessment.evidence.some(text=>/\bregister for (?:our|the) (?:product )?(?:webinar|demo)\b/i.test(text));
    const selling=!concreteTask(evidence)&&(isCommercialSentence(evidence)||((clear||campaignCall)&&commercialFamiliesIn(evidence).some(f=>f==='call-to-action'||f==='sales-outreach')));
    if(independentlySupported(obligation)||!selling)return obligation;
    return {...obligation,required:false,commercial:true,
      uncertainty:obligation.uncertainty||'Optional commercial call to action.'};
  });
  const requests=obligations.filter(o=>o.kind==='request'&&o.required&&o.ownerIsUser!==false&&o.state==='open');
  const concreteSecurity=assessment.preserve.some(p=>p.kind==='security');
  // The reply decision rests on one sentence. When that sentence is sales copy in a clear
  // promotion — or is the very call to action just demoted above — answering is optional.
  const reply=classification.reply;
  const sellingReply=!!reply&&reply.status==='required'&&!!reply.evidence&&(
    (clear&&isCommercialSentence(reply.evidence))||
    obligations.some(o=>o.commercial&&o.evidence&&normalizeQuote(o.evidence)===normalizeQuote(reply.evidence)));
  const checkedReply=sellingReply?{...reply!,status:'not_required' as const,reasonCode:'optional_engagement' as const,channel:'none' as const,
    explanation:'This is a sales call to action; answering is optional.'}:reply;
  return {
    ...classification,
    obligations,
    // Classifications from before the reply assessment keep the earlier rule.
    ...checkedReply?{reply:checkedReply,replyRequired:checkedReply.status==='required'}:{
      replyRequired:classification.replyRequired&&(requests.length>0||
        (!classification.obligations.some(o=>o.kind==='request')&&!obligations.some(o=>o.commercial)&&!clear))},
    securityEvent:classification.securityEvent&&(!clear||concreteSecurity),
    topics:clear?(classification.topics||[]).filter(topic=>topic!=='research'):classification.topics,
  };
}

/** Whether a clear promotion has nothing that must keep it out of Noise. */
export function promotionalWithoutPurpose(classification:Classification,assessment:PurposeAssessment){
  if(assessment.promotion!=='clear')return false;
  if(assessment.preserve.some(p=>p.kind==='transaction'||p.kind==='security'||p.kind==='registration'||p.kind==='achievement'))return false;
  if(classification.securityEvent)return false;
  return !(Array.isArray(classification.obligations)?classification.obligations:[])
    .some(o=>o.required&&o.ownerIsUser!==false&&o.state==='open');
}
