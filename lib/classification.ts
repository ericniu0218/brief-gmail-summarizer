import type { Section, Tag } from './categories';

export const POLICY_VERSION='policy-2026-09-22-1';

export type Context='work'|'personal'|'unknown';
export type Topic='research';
export type ObligationKind='deadline'|'meeting'|'request'|'action';
export type ObligationState='open'|'completed'|'cancelled'|'superseded'|'unknown';
export type MeetingState='proposed'|'confirmed'|'rescheduled'|'cancelled'|'unknown';
export type Disposition='useful'|'junk'|'uncertain';
export type ProcessingStatus='pending'|'classified'|'needs_review'|'failed';

/** A date exactly as the message stated it, plus whatever could be resolved from it. */
export type ExtractedDate={
  phrase:string;
  date?:string;
  time?:string;
  timezone?:string;
  ambiguous:boolean;
  reason?:string;
};

export type Obligation={
  id:string;
  kind:ObligationKind;
  description:string;
  owner:string;
  /** null when responsibility is genuinely ambiguous. */
  ownerIsUser:boolean|null;
  required:boolean;
  due?:ExtractedDate;
  evidence:string;
  state:ObligationState;
  meetingState?:MeetingState;
  uncertainty?:string;
};

/**
 * Topic, urgency and required action are separate dimensions. Nothing here is a
 * sidebar category: `effectiveCategories` is the single place that maps them.
 */
export type Classification={
  context:Context;
  topics:Topic[];
  obligations:Obligation[];
  disposition:Disposition;
  replyRequired:boolean;
  securityEvent:boolean;
  processingStatus:ProcessingStatus;
  reason:string;
  /** One-line summary of what the message says, distinct from the classification reason. */
  summary?:string;
  uncertainty?:string;
  version:string;
  /**
   * The classifier's own disposition, kept when the effective one was overruled by a
   * conflict. Its presence means `disposition` is the application's decision, not the
   * classifier's, and the original prediction is still available for inspection.
   */
  proposedDisposition?:Disposition;
  /** Stable identifier for the conflict that forced review. */
  reviewReason?:string;
  /**
   * Set when a manual correction or user rule produced the effective result.
   * `category` records a deliberate user choice of section, which is the only thing
   * allowed to bypass automatic conflict protection.
   */
  override?:{source:'message'|'rule';category?:Section;addTags?:Tag[];removeTags?:Tag[]};
};

/**
 * Stable identity for a task correction. It uses grounded source evidence instead of an
 * array index, so a model may reorder obligations without moving a completion to another
 * task. Duplicate identical keys are treated as ambiguous by the composer and are never
 * updated automatically.
 */
export function obligationCorrectionKey(obligation:Obligation){
  // Keep the normalized source itself instead of a short non-cryptographic hash. Exact
  // canonical strings cannot collide, and the server still verifies that exactly one
  // current obligation matches before accepting a correction.
  return JSON.stringify([obligation.kind,obligation.evidence,obligation.due?.phrase||'',obligation.owner]
    .map(value=>value.toLowerCase().replace(/\s+/g,' ').trim()));
}

export const EMPTY_CLASSIFICATION:Classification={
  context:'unknown',topics:[],obligations:[],disposition:'uncertain',replyRequired:false,
  securityEvent:false,processingStatus:'pending',reason:'Awaiting classification.',version:POLICY_VERSION,
};

const OBLIGATION_TAG:Record<ObligationKind,Tag>={deadline:'deadlines',meeting:'meetings',request:'requests',action:'actions'};
const RESOLVED:ObligationState[]=['completed','cancelled','superseded'];
const ALLOWED_TAGS:Record<Section,ReadonlySet<Tag>>={
  work:new Set(['deadlines','meetings','requests','actions','research']),
  personal:new Set(['meetings','low-priority']),
  noise:new Set(['junk']),
};

/** Runtime-safe access for classifications restored from JSON snapshots. */
function obligationsOf(classification:Classification):Obligation[]{
  return Array.isArray(classification.obligations)?classification.obligations:[];
}

/**
 * Both state fields are consulted: a meeting cancelled through `meetingState` is
 * resolved even when `state` was left open, so inconsistent fields cannot revive it.
 */
export function isResolved(obligation:Obligation){
  if(obligation.kind==='meeting'&&obligation.meetingState==='cancelled')return true;
  return RESOLVED.includes(obligation.state);
}

/** An obligation counts for the user unless it is demonstrably somebody else's. */
export function appliesToUser(obligation:Obligation){return obligation.ownerIsUser!==false;}

/** Obligations that still stand for this user. Cancelled and superseded work never qualifies. */
export function openObligations(classification:Classification){
  return obligationsOf(classification).filter(o=>!isResolved(o)&&appliesToUser(o));
}

const DAY=86400000;

/** Days until the obligation is due, or undefined when no supported date exists. */
export function daysUntilDue(obligation:Obligation,now:number){
  const iso=obligation.due?.time||obligation.due?.date;
  if(!iso||!obligation.due||obligation.due.ambiguous)return undefined;
  const due=Date.parse(obligation.due.time?iso:`${iso}T23:59:59Z`);
  return Number.isFinite(due)?Math.floor((due-now)/DAY):undefined;
}

/** An unresolved dated obligation whose due date has already passed. */
export function isOverdue(obligation:Obligation,now:number){
  const days=daysUntilDue(obligation,now);
  return days!==undefined&&days<0&&!isResolved(obligation);
}

/**
 * Priority comes from evidence, never from a sender writing "urgent". It stays
 * independent of Work versus Personal so important personal mail reaches Overview.
 */
export function derivePriority(input:Classification,now:number):'high'|'normal'{
  const classification=effectiveClassification(input);
  if(classification.disposition==='junk')return 'normal';
  if(classification.securityEvent)return 'high';
  for(const obligation of openObligations(classification)){
    if(!obligation.required)continue;
    const days=daysUntilDue(obligation,now);
    if(days!==undefined&&days>=0&&days<=3)return 'high';
    if(obligation.kind==='meeting'&&obligation.meetingState==='confirmed'&&days!==undefined&&days>=0&&days<=1)return 'high';
    if(obligation.kind==='request'&&obligation.ownerIsUser===true)return 'high';
  }
  return 'normal';
}

/** Overview shows unresolved obligations and security events, never cancelled work. */
export function isOverviewMessage(input:Classification,now:number){
  const classification=effectiveClassification(input);
  if(classification.disposition==='junk')return false;
  return classification.securityEvent||derivePriority(classification,now)==='high'||openObligations(classification).some(o=>o.required);
}

/** Upcoming-event lists exclude cancelled and superseded meetings but keep them as history. */
export function upcomingMeetings(classification:Classification){
  return obligationsOf(classification).filter(o=>o.kind==='meeting'&&!isResolved(o)&&o.meetingState!=='cancelled');
}

/**
 * The single mapping from classification dimensions onto the sidebar. Parent sections
 * keep legitimate mail that matches no subcategory, so Work is never forced into a
 * task-shaped tag.
 */
export function effectiveCategories(input:Classification):{category:Section;tags:Tag[]}{
  // Run the conflict policy here too, so no caller can route around it.
  const classification=effectiveClassification(input);
  const finish=(category:Section,tags:Tag[]):{category:Section;tags:Tag[]}=>{
    const applied=new Set(tags);
    const additions=Array.isArray(classification.override?.addTags)?classification.override.addTags:[];
    const removals=Array.isArray(classification.override?.removeTags)?classification.override.removeTags:[];
    for(const tag of additions)applied.add(tag);
    for(const tag of removals)applied.delete(tag);
    // A Noise result always carries its explanatory Junk tag. applyOverride turns a
    // deliberate Junk removal into a useful disposition before this mapping runs.
    if(category==='noise')applied.add('junk');
    return {category,tags:[...applied].filter(tag=>ALLOWED_TAGS[category].has(tag))};
  };
  if(classification.disposition==='junk')return finish('noise',['junk']);

  const tags=new Set<Tag>();
  // Cancelled meetings stay under Meetings as history; Overview filtering excludes them.
  for(const obligation of obligationsOf(classification)){
    if(!appliesToUser(obligation))continue;
    if(obligation.kind!=='meeting'&&isResolved(obligation))continue;
    tags.add(OBLIGATION_TAG[obligation.kind]);
  }
  if(Array.isArray(classification.topics)&&classification.topics.includes('research'))tags.add('research');

  // An uncertain or unknown context still needs a home. Obligation-shaped mail reads as
  // work; everything else stays personal. Inbox shows both regardless.
  const context=classification.context==='unknown'
    ?(tags.size>0?'work':'personal')
    :classification.context;

  if(context==='personal'){
    // Research is a Work-only tag, and personal mail is only low-priority when nothing is open.
    tags.delete('research');
    if(openObligations(classification).length===0)tags.add('low-priority');
    else tags.delete('low-priority');
    return finish('personal',[...tags].filter(tag=>tag==='low-priority'||tag==='meetings'));
  }
  tags.delete('low-priority');
  return finish('work',[...tags]);
}

/** The classifier's own proposal, which survives being overruled by a conflict. */
export function proposedDisposition(classification:Classification):Disposition{
  return classification.proposedDisposition??classification.disposition;
}

/**
 * Obligations credible enough to keep a message out of Noise.
 *
 * Requires a real commitment (`required`), responsibility that is the user's or
 * genuinely unclear, an unresolved state, and wording grounded in the message.
 * Optional marketing invitations, promotional countdowns, somebody else's work and
 * completed, cancelled or superseded items all fail at least one of these.
 */
export function protectiveObligations(classification:Classification):Obligation[]{
  return obligationsOf(classification).filter(obligation=>
    obligation.required&&
    obligation.ownerIsUser!==false&&
    !isResolved(obligation)&&
    !!obligation.evidence?.trim(),
  );
}

/**
 * Why an automatic Junk prediction must not be acted on. A deliberate user choice to
 * file the message under Noise is always honoured and is never treated as a conflict.
 */
export function junkConflict(classification:Classification):string|undefined{
  if(classification.override?.category==='noise')return undefined;
  if(proposedDisposition(classification)!=='junk')return undefined;
  if(protectiveObligations(classification).length)return 'junk-with-open-obligation';
  // A claimed security event is worth a look, but being kept out of Junk is not a
  // statement that the message is genuine: it may still be phishing.
  if(classification.securityEvent)return 'junk-with-security-event';
  return undefined;
}

const REVIEW_EXPLANATIONS:Record<string,string>={
  'junk-with-open-obligation':'This message may contain a request for you, so it was kept out of Junk for review.',
  'junk-with-security-event':'This message claims to be an account or security notice, so it was kept out of Junk for review. It has not been checked for authenticity.',
  'unclear-task-owner':'It is unclear whether this task is yours, so it is waiting for your review.',
  'ambiguous-date':'A date in this message could not be resolved, so it is waiting for your review.',
  'conflicting-dates':'This message gives more than one due date, so it is waiting for your review.',
  'classification-failed':'Automatic classification did not complete for this message.',
  'manual-obligation-unmatched':'A corrected task changed during automatic reclassification and needs review.',
};

export function reviewExplanation(classification:Classification):string|undefined{
  const reason=classification.reviewReason??(classification.processingStatus==='needs_review'?classification.uncertainty:undefined);
  return reason?REVIEW_EXPLANATIONS[reason]:undefined;
}

/**
 * The single decision point for conflicting classifications. A Junk prediction that
 * contradicts credible evidence of an unresolved obligation becomes `uncertain` and is
 * held for review instead of being filed away, while the original prediction, the
 * conflict reason and every extracted obligation are preserved.
 *
 * Idempotent: applying it repeatedly yields the same result and never accumulates state.
 * It is also reversible — once the obligation is resolved or reassigned, the classifier's
 * own proposal is restored and ordinary policy resumes.
 */
export function effectiveClassification(classification:Classification):Classification{
  const conflict=junkConflict(classification);
  if(!conflict){
    const proposed=classification.proposedDisposition;
    if(proposed&&proposed!==classification.disposition){
      return {...classification,disposition:proposed,proposedDisposition:undefined,reviewReason:undefined,
        processingStatus:classification.processingStatus==='needs_review'?'classified':classification.processingStatus};
    }
    return classification;
  }
  if(classification.proposedDisposition==='junk'&&classification.disposition==='uncertain'
    &&classification.reviewReason===conflict&&classification.processingStatus==='needs_review')return classification;
  return {...classification,proposedDisposition:'junk',disposition:'uncertain',
    processingStatus:'needs_review',reviewReason:conflict};
}

/**
 * Everything the interface derives from a classification, computed from the effective
 * result so category, tags, priority, counts and visibility can never disagree.
 */
export function applyPolicy(classification:Classification,now:number){
  const effective=effectiveClassification(classification);
  const {category,tags}=effectiveCategories(effective);
  const priority=derivePriority(effective,now);
  return {classification:effective,category,tags,priority,
    label:priority==='high'?'Important':category==='noise'?'Junk':category==='work'?'Work':'Personal'};
}

/** Cases worth a bounded second pass rather than shipping a shaky label. */
export function needsReview(classification:Classification):string|undefined{
  if(classification.processingStatus==='failed')return 'classification-failed';
  const conflict=junkConflict(classification);
  if(conflict)return conflict;
  const obligations=obligationsOf(classification);
  if(obligations.some(o=>o.ownerIsUser===null&&o.required))return 'unclear-task-owner';
  if(obligations.some(o=>o.due?.ambiguous&&o.required))return 'ambiguous-date';
  const dated=obligations.filter(o=>o.kind==='deadline'&&o.due?.date&&!o.due.ambiguous).map(o=>o.due!.date!);
  if(new Set(dated).size>1)return 'conflicting-dates';
  return undefined;
}
