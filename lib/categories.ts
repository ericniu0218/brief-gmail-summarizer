import type { Email } from './mail';
import { hasImportantSignal } from './inbox-priority';

export type Section = 'work' | 'personal' | 'noise';
export type Tag = 'deadlines' | 'meetings' | 'requests' | 'actions' | 'research' | 'low-priority' | 'junk';

export type SectionDefinition = {id:Section;name:string;tags:{id:Tag;name:string}[]};

// Noise has no submenu: junk is shown directly on the parent row.
export const SECTIONS:SectionDefinition[] = [
  {id:'work',name:'Work',tags:[
    {id:'deadlines',name:'Deadlines'},
    {id:'meetings',name:'Meetings'},
    {id:'requests',name:'Important requests'},
    {id:'actions',name:'Action items'},
    {id:'research',name:'Research'},
  ]},
  {id:'personal',name:'Personal',tags:[
    {id:'low-priority',name:'Low-priority messages'},
  ]},
  {id:'noise',name:'Noise',tags:[]},
];

export const WORK_TAGS:Tag[]=['deadlines','meetings','requests','actions','research'];

const TAG_NAMES=new Map<Tag,string>(SECTIONS.flatMap(s=>s.tags.map(t=>[t.id,t.name] as const)));
export function tagName(tag:Tag){return TAG_NAMES.get(tag)||tag;}
export function sectionName(section:Section){return SECTIONS.find(s=>s.id===section)?.name||section;}

const DEADLINE=/\b(deadline|due (?:date|by|on|today|tomorrow)|due\b|by (?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s*(?:am|pm))|closes? (?:on|this|friday|monday|tomorrow)|expires?|last day|submit(?:ted)? by|no later than|rsvp by|payment due|invoice due|renew(?:al)? by)\b/i;
const MEETING=/\b(meeting|invite|invitation|calendar|call (?:tomorrow|today|on|at)|reschedul\w*|cancel(?:led|ling)? (?:the )?(?:meeting|call)|stand[- ]?up|sync|catch[- ]?up|are you (?:free|available)|book a time|zoom|google meet|teams link|appointment|conference call)\b/i;
const REQUEST=/\b(approval|approve|sign(?:ature|ed)?\b|please (?:confirm|review|approve|advise|respond)|need(?:s)? your (?:input|decision|approval|signature|response)|could you (?:review|approve|confirm|sign|let me know)|can you (?:review|approve|confirm|sign|join)|waiting on your|decision needed|response (?:needed|required))\b/i;
const ACTION=/\b(action (?:required|needed)|please (?:complete|submit|update|rotate|upload|fill)|to[- ]do|task assigned|assigned to you|rotate your|update your|complete (?:your|the) (?:setup|profile|form)|submit (?:your|the)|fill out|finish setting up)\b/i;
const RESEARCH=/\b(paper|preprint|manuscript|paper submission|abstract|paper review|peer review|paper accepted|experiment|dataset|data set|grant|funding (?:call|opportunity)|principal investigator|arxiv|journal|citation|cited|lab (?:meeting|results|notebook)|study (?:results|protocol)|hypothes[ei]s|methodology|research (?:collaboration|group|proposal|update|digest)|conference (?:paper|submission|proceedings)|literature review|reproducib\w+)\b/i;
// Bulk marketing needs more than one signal: an unsubscribe link, newsletter formatting,
// or a single promotional word is explicitly not enough to call something junk.
const PROMOTION=/\b(sale|% off|\d+% off|discount|coupon|promo code|limited time|shop now|buy now|order now|deal[s]?\b|clearance|free shipping|best price|exclusive offer|last chance|don'?t miss|act now|upgrade now|subscribe now|new arrivals|your cart|almost sold out)\b/i;
const BULK_SENDER=/(^|[.@])(no[-_]?reply|newsletter|marketing|promo|offers?|deals?|mailer|campaign)([.@]|$)/i;

function corpus(email:Pick<Email,'subject'|'summary'|'body'>){return `${email.subject} ${email.summary} ${email.body}`;}

function promotionalScore(email:Email){
  const text=corpus(email);
  let score=0;
  const matches=text.match(new RegExp(PROMOTION.source,'gi'));
  score+=Math.min(matches?.length||0,3);
  if(BULK_SENDER.test(email.address))score+=1;
  return score;
}

/** Subcategory tags detected from message content. A message may match several. */
export function detectTags(email:Email):Tag[]{
  const text=corpus(email);
  const tags:Tag[]=[];
  if(RESEARCH.test(text))tags.push('research');
  if(DEADLINE.test(text))tags.push('deadlines');
  if(MEETING.test(text))tags.push('meetings');
  if(REQUEST.test(text))tags.push('requests');
  if(ACTION.test(text))tags.push('actions');
  return tags;
}

function isPersonalAddress(email:Email){
  return /(^|[.@])(family|personal|friends?|gmail|outlook|yahoo|icloud|hotmail)([.@]|$)/i.test(email.address);
}

/**
 * Deterministic classification used for demo mail and whenever AI analysis is
 * unavailable. Research and direct requests outrank promotional wording so that
 * research newsletters and urgent personal mail are never filed as junk.
 */
export function classifyEmail(email:Email):{category:Section;tags:Tag[]}{
  const detected=detectTags(email);
  const important=hasImportantSignal(email.subject,`${email.summary} ${email.body}`)||email.needsReply;
  const researchy=detected.includes('research');
  const promotional=promotionalScore(email)>=2;
  if(promotional&&!researchy&&!important&&!detected.includes('deadlines'))return {category:'noise',tags:['junk']};
  const personal=isPersonalAddress(email)&&!researchy;
  if(personal){
    const quiet=!important&&!detected.includes('deadlines')&&!detected.includes('requests');
    return {category:'personal',tags:quiet?['low-priority']:detected.filter(t=>t==='meetings')};
  }
  return {category:'work',tags:detected.filter(t=>WORK_TAGS.includes(t))};
}

export function withFallbackTags(emails:Email[]):Email[]{
  return emails.map(email=>email.tags?email:{...email,tags:classifyEmail(email).tags});
}

export function emailTags(email:Email):Tag[]{return email.tags||classifyEmail(email).tags;}

/**
 * Disclosure state is a list of expanded sections. Toggling one section never
 * touches another, and navigation never calls this, so opening a view cannot
 * expand or collapse a submenu.
 */
export function toggleExpanded(current:Section[],section:Section):Section[]{
  return current.includes(section)?current.filter(id=>id!==section):[...current,section];
}

/** View ids are `overview`, `inbox`, a section id, or `section:tag`. */
export function parseView(view:string):{section?:Section;tag?:Tag}{
  const [section,tag]=view.split(':');
  if(section!=='work'&&section!=='personal'&&section!=='noise')return {};
  return {section,tag:tag as Tag|undefined};
}

/** Combined parent views keep section mail that matches no subcategory. */
export function selectEmails(emails:Email[],view:string):Email[]{
  if(view==='inbox')return emails;
  const {section,tag}=parseView(view);
  if(!section)return emails;
  const inSection=emails.filter(email=>email.category===section);
  if(!tag)return inSection;
  return inSection.filter(email=>emailTags(email).includes(tag));
}

/** Parent counts are unique messages; subcategory counts may overlap. */
export function sectionCount(emails:Email[],section:Section){
  return emails.filter(email=>email.category===section).length;
}

export function tagCount(emails:Email[],section:Section,tag:Tag){
  return emails.filter(email=>email.category===section&&emailTags(email).includes(tag)).length;
}

/** At most two compact labels per row; full detail belongs in the conversation panel. */
export function rowLabels(email:Email):string[]{
  const tags=emailTags(email).filter(tag=>tag!=='junk');
  return tags.slice(0,2).map(tagName);
}
