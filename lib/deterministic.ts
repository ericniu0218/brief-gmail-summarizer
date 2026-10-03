import { sameOrganization } from './addresses';
import { POLICY_VERSION, type Classification, type MeetingState, type Obligation, type ObligationState } from './classification';
import { resolveDate } from './dates';
import { assessReply, replyRequiredFrom, type RecipientContext } from './reply';
import { applyPurposeChecks, assessPurpose, isCampaignFooter, isCommercialSentence, promotionalWithoutPurpose, securityEvidence, transactionEvidence, type PurposeAssessment } from './purpose';

/**
 * Explainable, offline email classifier. It supplies demo behavior and a safe fallback
 * when the AI provider is unavailable, using fixed patterns rather than learned guesses.
 */

/** The subset of a normalized message this classifier reads. */
export type ClassifiableMessage={
  id:string;subject:string;text:string;quoted:string;
  from:{name:string;address:string};to:{name?:string;address:string}[];cc:{name?:string;address:string}[];
  receivedAt:number;labels:string[];attachments:{filename:string}[];
  contentComplete:boolean;
  /** Parsed iCalendar invitation, when the message carried one. */
  calendar?:{method?:string;summary?:string;start?:string;end?:string;status?:string;uid?:string};
  /** Campaign headers derived at normalization. Absent on older records and fixtures. */
  distribution?:{listUnsubscribe?:boolean;bulkPrecedence?:boolean};
  /** Lower-cased message headers, read only for automatic-reply markers. Optional for fixtures. */
  headers?:Record<string,string>;
};

// Signal patterns are intentionally narrow because false positives can hide or
// over-prioritize mail.
// Concrete account events come from the shared purpose module. These two phrases name an
// event only when nothing in the message is selling: "Security alert: 3 ways to stay safe,
// 40% off" is a campaign.
const SECURITY_CLAIM=/\b(security alert|confirm your identity)\b/i;
// "Due to maintenance" gives a cause, not a due date.
const DEADLINE=/\b(due(?! to\b)|deadline|closes?|expires?|no later than|submit by|rsvp by|last day)\b/i;
// A meeting needs a meeting: "call", "sync", "appointment" and "cancel" alone also mean a
// sale's last call, a product that syncs, marketing copy and a returns policy.
const MEETING=/\b(meet (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|(?:a|schedule a|we) call|dentist appointment|office hours|join (?:the )?zoom|interview scheduled|attend (?:the )?training session|meeting|meet (?:with|on|at|up|tomorrow|today|this|next)|(?:video|phone|conference|zoom|client|team|intro|weekly|daily|quick|follow[- ]up) call|join (?:the |a |our |us for a |me for a )?(?:call|meeting)|hop on a call|call (?:at|on|tomorrow|today|this|next)|stand[- ]?up|(?:our|the|weekly|daily|team) sync|\w+'s sync|sync (?:up|on|at|tomorrow|today|this|next)|catch[- ]?up (?:call|meeting|chat|on|at|tomorrow|today|this|next)|(?:quick|weekly|let'?s) catch[- ]?up|(?:your|an|the) appointment|appointment (?:is|at|on|with|reminder|confirmed|scheduled)|(?:your|an|the|job|phone|video|on-?site|final) interview (?:is|on|at|for|scheduled|confirmed|tomorrow|today)|your interview with|interview (?:invitation|schedule|slot|confirmation)|invite you (?:to|for) an interview|zoom (?:meeting|call|link|session)|google meet|coffee chat|^(?:updated )?invitation: .+ @ |appointment booked|you(?:'re| are) registered for|(?:webinar|workshop|session|class|event) (?:starts|begins)|(?:meeting|call|appointment|interview|session|sync) (?:has been |is |was )?(?:moved|rescheduled|cancell?ed|pushed)|reschedul\w*|(?:is|has been|was) cancell?ed)\b/i;
// Wording that contains a meeting word without describing a meeting.
const NOT_A_MEETING=/\b(?:last|final) call\b|\b(?:call|contact) (?:us|our (?:team|support|customer)|customer (?:service|support))\b|\bgive us a call\b|\bcall (?:\+?\d|1-8)[\d\s().-]{6,}/gi;
const REQUEST=/\b(please (?:confirm|review|approve|advise|respond|sign)|could you|can you|need your (?:input|decision|approval|signature|response)|approval needed|signature needed|let me know)\b/i;
const ACTION=/\b(action required|please (?:complete|submit|update|rotate|upload|fill)|rotate your|update your|complete (?:your|the)|submit (?:your|the)|fill out|must (?:complete|submit|respond|attend|finish|renew|provide)|(?:are|is) required to)\b/i;
const RESEARCH=/\b(paper|preprint|manuscript|abstract|peer review|experiment|dataset|grant|funding call|arxiv|journal|principal investigator|lab (?:meeting|results)|research (?:collaboration|group|proposal)|reproducib\w+|camera[- ]ready|rebuttal)\b/i;
const MARKETING_STUDY=/\b(a (?:recent|new) study (?:shows|found)|studies show|science[- ]backed)\b/i;
const COUNTDOWN=/\b(ends (?:today|tonight|tomorrow|soon)|only \d+ (?:hours?|days?) left|hurry|while supplies last|(?:sale|offer|deal|discount|code|coupon|voucher|promo(?:tion)?(?: code)?) (?:ends|expires))\b/i;
// An expiry counted from an event the message cannot date ("30 days from sign-up") has its
// own timing. Lending it another sentence's date would invent a deadline.
const RELATIVE_DURATION=/\b\d+\s+(?:days?|weeks?|months?|hours?)\s+(?:from|after|of)\b/i;
// A call to action carrying "today" is urging, not dating: "Join PADI Club Today".
const CTA_TODAY=/\b(?:join|shop|buy|order|sign up|subscribe|start|try|get|register|upgrade|enroll|save|claim|unlock|discover|explore)\b[^.!?\n]{0,40}\b(?:today|tomorrow|now)\b/i;
// Closing courtesy, not an ask: "let me know if you have any questions".
const COURTESY=/\blet me know if you (?:have|need) (?:any )?(?:questions|anything(?: else)?)\b|\bif you have any questions\b/i;
// Words that tie a task to taking part in an optional offer or application, so wording
// elsewhere in the message ("applications are open", "enter to win") only makes *those*
// tasks optional, never an unrelated one beside them.
const PARTICIPATION=/\b(respon\w*|take part|participat\w*|survey|questionnaire|enter|entry|feedback|tell us)\b/i;
const APPLYING=/\b(apply|applications?|applicants?|nominat\w*|sign(?:ing)? up)\b/i;
// Event nouns. A sentence naming a *different* event says nothing about this meeting's
// state: "the optional webinar has been cancelled" does not cancel a dentist appointment.
const EVENT_NOUN=/\b(meeting|call|appointment|interview|webinar|workshop|session|class|event|sync|stand-?up|catch-?up|training|lecture|seminar|demo|conference)s?\b/gi;
/** Most candidates kept per kind, so a long message cannot produce a wall of tasks. */
const MAX_PER_KIND=3;
// Phrases that make one sentence's own task optional.
const OPTIONAL=/\boptional\b|\bif you'?d like\b|\bno pressure\b|\bfeel free to\b|\bif (?:you(?:'re| are) )?interested\b/i;
// Being invited says nothing by itself: a job interview and a prize draw are both
// invitations. What marks one as optional is the incentive attached to it, or wording
// that states outright that taking part is up to the reader.
//
// These are read across the message rather than within one sentence, because the offer
// and the closing date are usually paragraphs apart: "we invite you to take part" near
// the top and "the last day to respond is Friday" much further down.
const INVITATION=/\b(we invite you|you(?:'re| are) invited|invitation to (?:take part|participate))\b/i;
const INCENTIVE=/\b(chance to win|enter(?:ed)? to win|prize draw(?:ing)?|sweepstakes|raffle|gift card|win a \$)\b/i;
const SURVEY=/\b(survey|questionnaire|tell us about|share your (?:experience|feedback|thoughts))\b/i;
const VOLUNTARY=/\b(participation is voluntary|entirely voluntary|voluntary survey|completely optional|applications? (?:are|is) (?:open|optional)|you (?:may|can) apply|if (?:you(?:'re| are) )?interested[, ]+(?:apply|submit)|opportunity to apply)\b/i;
// An invitation can still carry a requirement. Explicit wording wins over the framing, so
// "you are invited to complete the mandatory training" stays required work.
const MANDATORY=/\b(required|mandatory|you must\b|must (?:complete|submit|respond|attend))\b/i;
const VAGUE_ONLY=/\b(soon|asap|when you can|at your convenience|no rush)\b/i;
// Weekdays are named: "\w+day" also matches "birthday", "holiday" and "someday". The clock
// is not part of this pattern; `dateIn` reads the whole clock expression after the date, so
// a time and its timezone are taken together or not at all.
const WEEKDAY='(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const DATE_PHRASE=new RegExp(`\\b(?:by |before |on |due )?(?:today|tomorrow|(?:this|next) ${WEEKDAY}|(?<!\\b(?:last|past) )${WEEKDAY}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|20\\d{2}-\\d{2}-\\d{2})\\b`,'i');
// A time after a date: "at 9am", "9:30 pm", "at 09:00", each optionally followed by a zone.
// A bare number is not a time, so either a meridiem or minutes is required.
const CLOCK_AFTER=/^\s*(?:(?:at|by|,)\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}:\d{2}\b)(?:\s+(?:UTC|GMT|[A-Z]{2,4}T)\b)?/i;
const FULL_DATE=/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?\b|\b20\d{2}-\d{2}-\d{2}\b/i;
const CANCELLED=/\b(cancel(?:led|ing|s)?|called off|no longer (?:happening|needed)|won'?t be going ahead)\b/i;
// "Reply CANCEL to release this slot" and "Reply STOP to stop receiving these" tell the
// reader how to cancel. They are instructions, not cancellations, and reading them as
// cancellations silently deleted a real appointment from Important. Rating a labelled set
// of mail found this on an appointment reminder due the next morning.
const CANCEL_INSTRUCTION=/\b(?:reply|text|respond|click|press|call)\s+(?:with\s+)?["'“]?(?:cancel|stop|unsubscribe)\b[^.!?\n]*|\b(?:to|if you (?:need|want|wish) to|in order to)\s+(?:cancel|stop|reschedule)\b[^.!?\n]*/gi;
/** The text with cancellation *instructions* removed, so only real cancellations remain. */
const withoutCancelInstructions=(text:string)=>text.replace(CANCEL_INSTRUCTION,' ');
const RESCHEDULED=/\b(moved to|reschedul\w*|pushed (?:to|back)|new time|now at|changed to)\b/i;
const CONFIRMED=/\b(confirmed|see you (?:then|at)|it'?s booked|accepted|locked in)\b/i;
const COMPLETED=/\b(received (?:it|the|your)|got (?:it|the|your)|thanks[, ]+(?:received|got it)|all set|this is (?:now )?done|completed)\b/i;
const PROMISE=/\b(i'?ll send|i will send|i'?ll get|will follow up|coming (?:shortly|soon))\b/i;
const PERSONAL_DOMAIN=/(^|[.@])(family|personal|friends?|gmail|outlook|yahoo|icloud|hotmail)([.@]|$)/i;
// Only domains that are institutional by definition. A commercial TLD is not evidence
// of a working relationship, since most bulk mail also comes from .com senders.
const INSTITUTIONAL=/\.(edu|gov)$/i;
const BULK_SENDER=/(^|[.@])(no[-_]?reply|newsletter|marketing|promo|offers?|deals?|mailer|campaign|news)([.@]|$)/i;

// An obligation is only as good as the sentence behind it. Spam that pads its body with
// base64 filler produced a "meeting" out of a 76-character random token, which then ranked
// above real mail. Links are stripped first, because a long URL in an otherwise ordinary
// sentence — a Zoom link beside a meeting time — is normal and must still count.
const URL_LIKE=/\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const OPAQUE_TOKEN=/[A-Za-z0-9+/=_-]{24,}/g;
function looksLikeLanguage(sentence:string){
  const prose=sentence.replace(URL_LIKE,' ');
  const letters=prose.replace(/\s+/g,'').length;
  if(!letters)return false;
  let opaque=0;
  for(const token of prose.match(OPAQUE_TOKEN)||[]){
    // A long run with no lower-case vowel is not a word in any language this handles.
    if(!/[aeiou]/.test(token))opaque+=token.length;
  }
  // Rejected only when the filler dominates, so one stray identifier cannot hide a real task.
  return opaque/letters<0.4;
}

function meetingStateOf(raw:string):MeetingState{
  const text=withoutCancelInstructions(raw);
  if(CANCELLED.test(text))return 'cancelled';
  if(RESCHEDULED.test(text))return 'rescheduled';
  if(CONFIRMED.test(text))return 'confirmed';
  return 'proposed';
}

function obligationStateOf(sentence:string,whole:string):ObligationState{
  if(CANCELLED.test(withoutCancelInstructions(sentence)))return 'cancelled';
  // Completion has to be stated about *this* obligation. Searching the whole message let an
  // unrelated "everyone received the point" three paragraphs down mark a live deadline as
  // done, which removed a problem set due in two days from Important entirely. A promise to
  // send something later still blocks completion wherever it appears.
  if(COMPLETED.test(sentence)&&!PROMISE.test(whole))return 'completed';
  return 'open';
}

/**
 * When an invitation starts. An instant with a zone is exact. An all-day event names only
 * its day. A floating wall-clock time keeps its day but not an invented instant, exactly as
 * a written time with no timezone is treated. Anything unreadable is no due date at all.
 */
function inviteDueOf(start:string|undefined):Obligation['due']|undefined{
  if(typeof start!=='string'||!start)return undefined;
  const day=/^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2})?)?$/.exec(start);
  if(day)return start.length===10?{phrase:start,date:day[1],ambiguous:false}
    :{phrase:start,date:day[1],ambiguous:true,reason:'timezone-unknown'};
  const instant=Date.parse(start);
  return Number.isFinite(instant)?{phrase:start,time:new Date(instant).toISOString(),ambiguous:false}:undefined;
}

/**
 * Deterministic classification over the separated current message text. Quoted history
 * is deliberately excluded from obligation detection so an old request is not revived
 * as a new task. Used as the AI-outage fallback and as the measurable baseline.
 */
export function deterministicClassify(message:ClassifiableMessage,userAddress='',recipient?:RecipientContext):Classification{
  // Obligations are read only from what this message itself says.
  const current=`${message.subject}\n${message.text}`;
  const whole=`${current}\n${message.quoted}`;
  const address=typeof message.from?.address==='string'?message.from.address.toLowerCase():'';
  const user=userAddress.toLowerCase();
  const to=Array.isArray(message.to)?message.to:[];
  const cc=Array.isArray(message.cc)?message.cc:[];
  const addressedDirectly=!user||to.some(party=>typeof party?.address==='string'&&party.address.toLowerCase()===user);
  const onlyCopied=!!user&&!addressedDirectly&&cc.some(party=>typeof party?.address==='string'&&party.address.toLowerCase()===user);

  const labels=Array.isArray(message.labels)?message.labels:[];
  const spamLabel=labels.includes('SPAM');
  // Mail from the user's own organisation is work context even when nothing else says so.
  const sameOrganisation=sameOrganization(address,user);
  const assessed=assessPurpose({subject:message.subject,text:message.text,from:message.from,labels,distribution:message.distribution});
  // A colleague discussing a campaign is not the campaign. Colleagues can still be
  // ambiguous, which keeps their commercial calls to action optional.
  const purpose:PurposeAssessment=sameOrganisation&&assessed.promotion==='clear'?{...assessed,promotion:'ambiguous'}:assessed;
  const concreteSecurity=!!securityEvidence(current);
  const claimedSecurity=concreteSecurity||(purpose.promotion==='absent'&&SECURITY_CLAIM.test(current));
  const rawResearch=RESEARCH.test(current)&&!MARKETING_STUDY.test(current);
  const transactional=!!transactionEvidence(current);

  const sentences=current.split(/(?<=[.!?])\s+|\n+/);
  // Wording that looks like a meeting but is not one is removed before meetings are read.
  const meetingSentences=sentences.map(sentence=>withoutCancelInstructions(sentence).replace(NOT_A_MEETING,' '));
  const eventsIn=(sentence:string)=>new Set(Array.from(sentence.matchAll(EVENT_NOUN),match=>match[1].toLowerCase().replace(/-/g,'')));
  /**
   * The text that speaks about the meeting found in sentence `index`: that sentence, plus
   * any other that names no event or only the same kind of event. A cancellation of some
   * other event in the same message no longer decides this one's state.
   */
  const aboutThisMeeting=(index:number)=>{
    const own=eventsIn(meetingSentences[index]);
    return meetingSentences.filter((sentence,other)=>{
      if(other===index)return true;
      const named=eventsIn(sentence);
      return !named.size||[...named].every(noun=>own.has(noun));
    }).join(' ');
  };
  // Every matching sentence is a candidate, not only the first: an optional "confirm your
  // place by September 30" must not hide the real "could you review the contract by
  // September 30?" below it.
  const candidates=(pattern:RegExp,source:string[]=sentences,skip?:(sentence:string)=>boolean)=>{
    const found:{evidence:string;index:number}[]=[];
    for(const [index,sentence] of source.entries()){
      if(found.length>=MAX_PER_KIND)break;
      if(!pattern.test(sentence)||skip?.(sentence))continue;
      const evidence=sentences[index].trim().slice(0,300);
      if(evidence&&!found.some(item=>item.evidence===evidence))found.push({evidence,index});
    }
    return found;
  };

  // A date belongs to the sentence that states it. A deadline or a meeting often states its
  // date in a neighbouring sentence ("The report is due. Please send it by Friday.", "Zoom
  // link: …"), so those two may take the message's date — only when the message names
  // exactly one outside any sales copy or countdown: an offer's expiry is the offer's,
  // never the invoice's. A request or an action is never given a date it did not state.
  const dateIn=(sentence:string)=>{
    // A full calendar date outranks a bare weekday beside it: "due Wednesday, January 20,
    // 2027" means January, not this Wednesday.
    const date=FULL_DATE.exec(sentence)||DATE_PHRASE.exec(sentence);
    const clock=date?CLOCK_AFTER.exec(sentence.slice(date.index+date[0].length))?.[0]||'':'';
    const phrase=date?date[0]+clock:'';
    return phrase&&!VAGUE_ONLY.test(phrase)&&!(COUNTDOWN.test(sentence)&&isCommercialSentence(sentence))?phrase:'';
  };
  const standalone=sentences.filter(sentence=>!isCommercialSentence(sentence)&&!CTA_TODAY.test(sentence)).map(dateIn).filter(Boolean);
  const fallbackDate=new Set(standalone.map(phrase=>phrase.toLowerCase())).size===1?standalone[0]:'';
  const dueFor=(evidence:string,fallback=''):Partial<Obligation>=>{
    const phrase=dateIn(evidence)||fallback;
    return phrase?{due:resolveDate(phrase,message.receivedAt)}:{};
  };

  /**
   * Candidates for a dated kind (deadlines, meetings), one per day. Several sentences usually
   * describe one event, so a later sentence is a separate event only when it states a day of
   * its own that no earlier one had. When it states the same day an earlier, undated
   * sentence ("Upcoming meeting") only borrowed, the specific sentence replaces the generic
   * one as the evidence. Only the first candidate may borrow the message's single date.
   */
  const distinctByDay=(found:{evidence:string;index:number}[])=>{
    const kept:{evidence:string;index:number;due:Partial<Obligation>;own:boolean;day:string}[]=[];
    for(const [position,{evidence,index}] of found.entries()){
      const own=!!dateIn(evidence);
      if(position&&!own)continue;
      const due=dueFor(evidence,position?'':fallbackDate);
      const day=due.due?.date||due.due?.phrase||'';
      const same=kept.findIndex(item=>item.day===day);
      if(same<0)kept.push({evidence,index,due,own,day});
      else if(!kept[same].own)kept[same]={evidence,index,due,own,day};
    }
    return kept;
  };

  // Build structured obligations from matching sentences so the interface can explain
  // what triggered a deadline, meeting, request, or action label.
  const obligations:Obligation[]=[];
  const counts=new Map<Obligation['kind'],number>();
  const push=(kind:Obligation['kind'],evidence:string,extra:Partial<Obligation>={})=>{
    if(!evidence||!looksLikeLanguage(evidence))return;
    // The first of a kind keeps the id older records used; later ones are numbered.
    const n=counts.get(kind)||0;
    counts.set(kind,n+1);
    // Somebody else's work is not the user's task.
    const other=/\b([A-Z][a-z]+)\s+(?:will|is going to|has agreed to|is handling)\b/.exec(evidence);
    const ownerIsUser=other?false:onlyCopied?null:addressedDirectly?true:null;
    obligations.push({
      id:n?`${message.id}:${kind}:${n+1}`:`${message.id}:${kind}`,kind,
      description:evidence.slice(0,200),
      owner:other?other[1]:'recipient',
      ownerIsUser,
      required:!optionalTask(evidence),
      evidence,
      state:obligationStateOf(evidence,whole),
      ...extra,
    });
  };

  // An invitation with a prize attached is an offer, not an assignment. Its date is still
  // read and still shown; it simply is not work the reader owes anyone. An invitation with
  // no incentive — "you are invited to a job interview on Friday" — stays real work.
  // A survey with a prize is the same offer without the word "invite": "tell us about your
  // first week and enter to win a gift card" asks for nothing the reader owes.
  //
  // The offer is read across the message, but it only makes optional the tasks that are
  // about taking part in it. "Please review the incident report by September 30" stays
  // required beside "applications are open for the volunteer board".
  const offer=((INVITATION.test(current)||SURVEY.test(current))&&INCENTIVE.test(current))&&!MANDATORY.test(current);
  const openApplications=VOLUNTARY.test(current)&&!MANDATORY.test(current);
  const ownApplication=/\b(?:your application|application you started|complete your application)\b/i.test(current);
  const optionalTask=(evidence:string)=>{
    if(OPTIONAL.test(evidence))return true;
    if(MANDATORY.test(evidence)||ownApplication)return false;
    if(VOLUNTARY.test(evidence))return true;
    return (offer&&PARTICIPATION.test(evidence))||(openApplications&&(APPLYING.test(evidence)||PARTICIPATION.test(evidence)));
  };
  // A deadline needs its own date; a promotional countdown is not a user deadline, and an
  // expiry counted from an undated event borrows nobody's date.
  const deadlines=candidates(DEADLINE,sentences,sentence=>(COUNTDOWN.test(sentence)&&isCommercialSentence(sentence))
    ||(!dateIn(sentence)&&(!fallbackDate||RELATIVE_DURATION.test(sentence))));
  for(const item of distinctByDay(deadlines))push('deadline',item.evidence,item.due);
  // An attached invitation is stronger evidence than any wording, and it carries the only
  // exact start time the message has. Taking it here means an ICS-only meeting still
  // becomes an obligation while the model is unavailable, instead of vanishing until the
  // next successful classification.
  const invite=message.calendar;
  const inviteDue=invite?inviteDueOf(invite.start):undefined;
  if(invite&&inviteDue){
    const status=String(invite.status||'').toUpperCase();
    const method=String(invite.method||'').toUpperCase();
    const cancelled=status==='CANCELLED'||method==='CANCEL';
    obligations.push({
      id:`${message.id}:calendar`,kind:'meeting',
      description:(invite.summary||message.subject||'Calendar invitation').slice(0,200),
      owner:'recipient',
      // The invitation reached this mailbox, so it is the user's unless they were only copied.
      ownerIsUser:onlyCopied?null:true,
      required:!cancelled,
      evidence:`Calendar invitation: ${invite.summary||message.subject||'(no title)'}`,
      state:cancelled?'cancelled':'open',
      meetingState:cancelled?'cancelled':status==='CONFIRMED'||method==='REQUEST'?'confirmed':'proposed',
      due:inviteDue,
    });
  }
  // Wording only adds a meeting when no invitation already described one.
  if(!obligations.some(o=>o.kind==='meeting'))
    for(const item of distinctByDay(candidates(MEETING,meetingSentences)))
      push('meeting',item.evidence,{meetingState:meetingStateOf(aboutThisMeeting(item.index)),...item.due});
  // Footer wording about managing the mailing is never the recipient's task, and a closing
  // courtesy is not a request.
  for(const {evidence} of candidates(REQUEST,sentences,sentence=>isCampaignFooter(sentence)||COURTESY.test(sentence)))
    push('request',evidence,dueFor(evidence));
  for(const {evidence} of candidates(ACTION,sentences,isCampaignFooter))push('action',evidence,dueFor(evidence));

  // The same checks the model's results pass through: a sales call to action is optional,
  // however it is worded, and research vocabulary does not make a pitch research.
  // Whether an email answer is owed is decided by the shared reply policy, request by
  // request, not by the presence of a request-shaped obligation.
  const assessedReply=assessReply(message,{userAddress,context:recipient});
  const checked=applyPurposeChecks({context:'unknown',topics:rawResearch?['research']:[],obligations,disposition:'useful',
    replyRequired:replyRequiredFrom(assessedReply),reply:assessedReply,securityEvent:claimedSecurity,processingStatus:'classified',reason:'',version:''},purpose);
  const reply=checked.reply!;
  const research=checked.topics.includes('research');
  const securityEvent=checked.securityEvent;
  const credible=checked.obligations;

  // No false task can protect a promotion any more: the obligations here have already
  // been through the checks, so only a real one keeps a sales message out of Noise.
  // Gmail's Promotions and Social tabs hold bulk mail by design. When nothing real is in the
  // message (no order, account event, registration, earned record or task of the user's),
  // Gmail's verdict settles what the wording alone left open. Mail from the user's own
  // organisation or a personal address is never buried on a tab's say-so, and neither is a
  // message whose content could not be read in full: nothing found is not nothing there.
  const bulkTab=labels.includes('CATEGORY_PROMOTIONS')&&message.contentComplete!==false&&!sameOrganisation&&!PERSONAL_DOMAIN.test(address)&&!purpose.preserve.length
    &&!transactional&&!concreteSecurity&&!credible.some(o=>o.required&&o.ownerIsUser!==false);
  const junk=spamLabel||promotionalWithoutPurpose(checked,purpose)||bulkTab;
  // Commercial content with nothing real behind it becomes uncertain rather than useful.
  const uncertain=!junk&&purpose.promotion!=='absent'&&!transactional&&!concreteSecurity&&
    !purpose.preserve.some(p=>p.kind==='registration')&&!credible.some(o=>o.required&&o.ownerIsUser!==false);
  const personalSender=PERSONAL_DOMAIN.test(address);
  const bulkSender=BULK_SENDER.test(address);
  // Work needs actual evidence of a working relationship: the user's own organisation,
  // research content, an account event, or a required task this message assigns to the
  // user. Bulk senders never qualify, so a newsletter is not filed as colleague mail, and
  // a sales call to action is not a task. Anything else stays unknown and is routed
  // conservatively by whether it carries obligations.
  const worksWithUser=sameOrganisation||research||securityEvent||
    (!bulkSender&&!personalSender&&(INSTITUTIONAL.test(address)||credible.some(o=>o.ownerIsUser===true&&o.required)));
  const context=worksWithUser?'work':personalSender?'personal':'unknown';

  const replyReview=reply.reasonCode==='suspicious_request'?'suspicious-request':reply.status==='uncertain'?'reply-uncertain':undefined;
  const reasons:string[]=[];
  if(securityEvent)reasons.push('Contains an account-security event.');
  if(research)reasons.push('Substantive research content.');
  const required=credible.filter(o=>o.required).length;
  if(required)reasons.push(`${required} obligation${required===1?'':'s'} detected.`);
  if(purpose.promotion==='clear')reasons.push(`Promotional content (${purpose.families.join(', ')}).`);
  if(junk)reasons.push(bulkTab&&purpose.promotion==='absent'
    ?'Gmail filed this under Promotions, and nothing in it needs the user.'
    :'Bulk promotional content with no personal or transactional purpose.');

  return {
    context,
    topics:research?['research']:[],
    obligations:credible,
    disposition:junk?'junk':uncertain?'uncertain':'useful',
    replyRequired:replyRequiredFrom(reply),
    reply,
    securityEvent,
    // An unsettled reply decision or an impersonation pattern is held for review.
    processingStatus:replyReview?'needs_review':'classified',
    reason:reasons.join(' ')||'No obligations or promotional signals found.',
    uncertainty:!message.contentComplete?'Message content was incomplete.':onlyCopied?'Recipient was only copied.':replyReview,
    version:`${POLICY_VERSION}:deterministic`,
  };
}
