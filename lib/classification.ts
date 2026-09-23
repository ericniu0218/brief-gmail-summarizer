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
  /** Set when a manual correction or user rule produced the effective result. */
  override?:{source:'message'|'rule';addTags?:Tag[];removeTags?:Tag[]};
};

export const EMPTY_CLASSIFICATION:Classification={
  context:'unknown',topics:[],obligations:[],disposition:'uncertain',replyRequired:false,
  securityEvent:false,processingStatus:'pending',reason:'Awaiting classification.',version:POLICY_VERSION,
};

const OBLIGATION_TAG:Record<ObligationKind,Tag>={deadline:'deadlines',meeting:'meetings',request:'requests',action:'actions'};
const RESOLVED:ObligationState[]=['completed','cancelled','superseded'];

export function isResolved(obligation:Obligation){return RESOLVED.includes(obligation.state);}

/** An obligation counts for the user unless it is demonstrably somebody else's. */
export function appliesToUser(obligation:Obligation){return obligation.ownerIsUser!==false;}

/** Obligations that still stand for this user. Cancelled and superseded work never qualifies. */
export function openObligations(classification:Classification){
  return classification.obligations.filter(o=>!isResolved(o)&&appliesToUser(o));
}

const DAY=86400000;

/** Days until the obligation is due, or undefined when no supported date exists. */
export function daysUntilDue(obligation:Obligation,now:number){
  const iso=obligation.due?.time||obligation.due?.date;
  if(!iso||!obligation.due||obligation.due.ambiguous)return undefined;
  const due=Date.parse(obligation.due.time?iso:`${iso}T23:59:59Z`);
  return Number.isFinite(due)?Math.floor((due-now)/DAY):undefined;
}

/**
 * Priority comes from evidence, never from a sender writing "urgent". It stays
 * independent of Work versus Personal so important personal mail reaches Overview.
 */
export function derivePriority(classification:Classification,now:number):'high'|'normal'{
  if(classification.disposition==='junk')return 'normal';
  if(classification.securityEvent)return 'high';
  for(const obligation of openObligations(classification)){
    if(!obligation.required)continue;
    const days=daysUntilDue(obligation,now);
    if(days!==undefined&&days<=3)return 'high';
    if(obligation.kind==='meeting'&&obligation.meetingState==='confirmed'&&days!==undefined&&days<=1)return 'high';
    if(obligation.kind==='request'&&obligation.ownerIsUser===true)return 'high';
  }
  return 'normal';
}

/** Overview shows unresolved obligations and security events, never cancelled work. */
export function isOverviewMessage(classification:Classification,now:number){
  if(classification.disposition==='junk')return false;
  return classification.securityEvent||derivePriority(classification,now)==='high'||openObligations(classification).some(o=>o.required);
}

/** Upcoming-event lists exclude cancelled and superseded meetings but keep them as history. */
export function upcomingMeetings(classification:Classification){
  return classification.obligations.filter(o=>o.kind==='meeting'&&!isResolved(o)&&o.meetingState!=='cancelled');
}

/**
 * The single mapping from classification dimensions onto the sidebar. Parent sections
 * keep legitimate mail that matches no subcategory, so Work is never forced into a
 * task-shaped tag.
 */
export function effectiveCategories(classification:Classification):{category:Section;tags:Tag[]}{
  const finish=(category:Section,tags:Tag[]):{category:Section;tags:Tag[]}=>{
    const applied=new Set(tags);
    for(const tag of classification.override?.addTags||[])applied.add(tag);
    for(const tag of classification.override?.removeTags||[])applied.delete(tag);
    return {category,tags:[...applied]};
  };
  if(classification.disposition==='junk')return finish('noise',['junk']);

  const tags=new Set<Tag>();
  // Cancelled meetings stay under Meetings as history; Overview filtering excludes them.
  for(const obligation of classification.obligations){
    if(!appliesToUser(obligation))continue;
    if(obligation.kind!=='meeting'&&isResolved(obligation))continue;
    tags.add(OBLIGATION_TAG[obligation.kind]);
  }
  if(classification.topics.includes('research'))tags.add('research');

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

/** Cases worth a bounded second pass rather than shipping a shaky label. */
export function needsReview(classification:Classification):string|undefined{
  if(classification.processingStatus==='failed')return 'classification-failed';
  if(classification.disposition==='junk'&&classification.obligations.some(o=>o.required&&appliesToUser(o)&&!isResolved(o)))return 'junk-with-open-obligation';
  if(classification.obligations.some(o=>o.ownerIsUser===null&&o.required))return 'unclear-task-owner';
  if(classification.obligations.some(o=>o.due?.ambiguous&&o.required))return 'ambiguous-date';
  const dated=classification.obligations.filter(o=>o.kind==='deadline'&&o.due?.date&&!o.due.ambiguous).map(o=>o.due!.date!);
  if(new Set(dated).size>1)return 'conflicting-dates';
  return undefined;
}
