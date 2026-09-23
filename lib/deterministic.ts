import { POLICY_VERSION, type Classification, type MeetingState, type Obligation, type ObligationState } from './classification';
import { resolveDate } from './dates';

/** The subset of a normalized message this classifier reads. */
export type ClassifiableMessage={
  id:string;subject:string;text:string;quoted:string;
  from:{name:string;address:string};to:{address:string}[];cc:{address:string}[];
  receivedAt:number;labels:string[];attachments:{filename:string}[];
  contentComplete:boolean;
};

const SECURITY=/\b(verification code|security alert|one[- ]time (?:code|password)|two[- ]factor|2fa|password reset|reset your password|new sign[- ]?in|unrecognized login|confirm your identity)\b/i;
const DEADLINE=/\b(due|deadline|closes?|expires?|no later than|submit by|rsvp by|last day)\b/i;
const MEETING=/\b(meeting|invite|invitation|call|stand[- ]?up|sync|catch[- ]?up|appointment|zoom|google meet|reschedul\w*|cancel\w*)\b/i;
const REQUEST=/\b(please (?:confirm|review|approve|advise|respond|sign)|could you|can you|need your (?:input|decision|approval|signature|response)|approval needed|signature needed|let me know)\b/i;
const ACTION=/\b(action required|please (?:complete|submit|update|rotate|upload|fill)|rotate your|update your|complete (?:your|the)|submit (?:your|the)|fill out)\b/i;
const RESEARCH=/\b(paper|preprint|manuscript|abstract|peer review|experiment|dataset|grant|funding call|arxiv|journal|principal investigator|lab (?:meeting|results)|research (?:collaboration|group|proposal)|reproducib\w+|camera[- ]ready|rebuttal)\b/i;
const MARKETING_STUDY=/\b(a (?:recent|new) study (?:shows|found)|studies show|science[- ]backed)\b/i;
const PROMOTION=/\b(% off|\d+% off|discount|coupon|promo code|limited time|shop now|buy now|order now|clearance|free shipping|exclusive offer|last chance|your cart|almost sold out|sale ends)\b/i;
const TRANSACTIONAL=/\b(receipt|invoice|order (?:confirmation|number)|your order|payment (?:received|confirmation)|booking confirmation|itinerary|statement)\b/i;
const COUNTDOWN=/\b(ends (?:today|tonight|tomorrow|soon)|only \d+ (?:hours?|days?) left|hurry|while supplies last)\b/i;
const VAGUE_ONLY=/\b(soon|asap|when you can|at your convenience|no rush)\b/i;
const DATE_PHRASE=/\b(?:by |before |on |due )?(?:today|tomorrow|(?:this|next) \w+day|\w+day|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?|20\d{2}-\d{2}-\d{2})(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))?\b/i;
const CANCELLED=/\b(cancel(?:led|ing|s)?|called off|no longer (?:happening|needed)|won'?t be going ahead)\b/i;
const RESCHEDULED=/\b(moved to|reschedul\w*|pushed (?:to|back)|new time|now at|changed to)\b/i;
const CONFIRMED=/\b(confirmed|see you (?:then|at)|it'?s booked|accepted|locked in)\b/i;
const COMPLETED=/\b(received (?:it|the|your)|got (?:it|the|your)|thanks[, ]+(?:received|got it)|all set|this is (?:now )?done|completed)\b/i;
const PROMISE=/\b(i'?ll send|i will send|i'?ll get|will follow up|coming (?:shortly|soon))\b/i;
const PERSONAL_DOMAIN=/(^|[.@])(family|personal|friends?|gmail|outlook|yahoo|icloud|hotmail)([.@]|$)/i;
const WORK_DOMAIN=/\.(edu|org|gov)$|@[a-z0-9-]+\.(com|io|co|net)$/i;
const BULK_SENDER=/(^|[.@])(no[-_]?reply|newsletter|marketing|promo|offers?|deals?|mailer|campaign|news)([.@]|$)/i;

function firstSentenceWith(text:string,pattern:RegExp){
  for(const sentence of text.split(/(?<=[.!?\n])\s+/)){
    if(pattern.test(sentence))return sentence.trim().slice(0,300);
  }
  return '';
}

function meetingStateOf(text:string):MeetingState{
  if(CANCELLED.test(text))return 'cancelled';
  if(RESCHEDULED.test(text))return 'rescheduled';
  if(CONFIRMED.test(text))return 'confirmed';
  return 'proposed';
}

function obligationStateOf(sentence:string,whole:string):ObligationState{
  if(CANCELLED.test(sentence))return 'cancelled';
  if(COMPLETED.test(whole)&&!PROMISE.test(whole))return 'completed';
  return 'open';
}

/**
 * Deterministic classification over the separated current message text. Quoted history
 * is deliberately excluded from obligation detection so an old request is not revived
 * as a new task. Used as the AI-outage fallback and as the measurable baseline.
 */
export function deterministicClassify(message:ClassifiableMessage,userAddress=''):Classification{
  // Obligations are read only from what this message itself says.
  const current=`${message.subject}\n${message.text}`;
  const whole=`${current}\n${message.quoted}`;
  const address=message.from.address.toLowerCase();
  const user=userAddress.toLowerCase();
  const addressedDirectly=!user||message.to.some(party=>party.address.toLowerCase()===user);
  const onlyCopied=!!user&&!addressedDirectly&&message.cc.some(party=>party.address.toLowerCase()===user);

  const securityEvent=SECURITY.test(current);
  const research=RESEARCH.test(current)&&!MARKETING_STUDY.test(current);
  const promotional=(current.match(new RegExp(PROMOTION.source,'gi'))?.length||0)+(BULK_SENDER.test(address)?1:0);
  const transactional=TRANSACTIONAL.test(current);
  const spamLabel=message.labels.includes('SPAM');

  const obligations:Obligation[]=[];
  const push=(kind:Obligation['kind'],pattern:RegExp,extra:Partial<Obligation>={})=>{
    const evidence=firstSentenceWith(current,pattern);
    if(!evidence)return;
    // Somebody else's work is not the user's task.
    const other=/\b([A-Z][a-z]+)\s+(?:will|is going to|has agreed to|is handling)\b/.exec(evidence);
    const ownerIsUser=other?false:onlyCopied?null:addressedDirectly?true:null;
    obligations.push({
      id:`${message.id}:${kind}`,kind,
      description:evidence.slice(0,200),
      owner:other?other[1]:'recipient',
      ownerIsUser,
      required:!/\boptional\b|\bif you'?d like\b|\bno pressure\b/i.test(evidence),
      evidence,
      state:obligationStateOf(evidence,whole),
      ...extra,
    });
  };

  const datePhrase=DATE_PHRASE.exec(current)?.[0]||'';
  const hasRealDate=!!datePhrase&&!VAGUE_ONLY.test(datePhrase);
  // A promotional countdown is not a user deadline.
  if(DEADLINE.test(current)&&hasRealDate&&!COUNTDOWN.test(current)&&promotional<2){
    push('deadline',DEADLINE,{due:resolveDate(datePhrase,message.receivedAt)});
  }
  if(MEETING.test(current))push('meeting',MEETING,{meetingState:meetingStateOf(current)});
  if(REQUEST.test(current)&&promotional<2)push('request',REQUEST);
  if(ACTION.test(current)&&promotional<2)push('action',ACTION);

  const junk=spamLabel||(promotional>=2&&!transactional&&!research&&!securityEvent&&obligations.length===0);
  const uncertain=!junk&&promotional>=2;
  // Mail from the user's own organisation is work context even when nothing else says so.
  const sameOrganisation=!!user&&address.split('@')[1]===user.split('@')[1];
  const context=sameOrganisation||research||(WORK_DOMAIN.test(address)&&!PERSONAL_DOMAIN.test(address))?'work'
    :PERSONAL_DOMAIN.test(address)?'personal':'unknown';

  const reasons:string[]=[];
  if(securityEvent)reasons.push('Contains an account-security event.');
  if(research)reasons.push('Substantive research content.');
  if(obligations.length)reasons.push(`${obligations.length} obligation${obligations.length===1?'':'s'} detected.`);
  if(junk)reasons.push('Bulk promotional content with no personal or transactional purpose.');

  return {
    context,
    topics:research?['research']:[],
    obligations,
    disposition:junk?'junk':uncertain?'uncertain':'useful',
    replyRequired:obligations.some(o=>o.kind==='request'&&o.ownerIsUser!==false&&o.state==='open'),
    securityEvent,
    processingStatus:'classified',
    reason:reasons.join(' ')||'No obligations or promotional signals found.',
    uncertainty:!message.contentComplete?'Message content was incomplete.':onlyCopied?'Recipient was only copied.':undefined,
    version:`${POLICY_VERSION}:deterministic`,
  };
}
