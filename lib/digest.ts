import { emailKey, type Email } from './mail';
import { buildInboxRows } from './inbox-priority';
import { isAutomatedSender, preferenceFor, type FoldPreferences } from './folding';
import { cachedImportance, evaluateImportance, TIER_RANK, type Importance } from './importance';
import { digestScore, fromPerson, MIN_DIGEST_SCORE } from './digest-rank';

/**
 * The daily digest: the few things in the inbox most worth the user's attention.
 *
 * Only mail the app's one importance policy calls important (`evaluateImportance`) can
 * appear, so the digest never contradicts Overview or the counts. Among that mail it keeps
 * the few that matter most, by `digestScore` (lib/digest-rank): people the reader writes to,
 * work, and what is due soon, above system notices and routine codes. A quiet day shows
 * fewer than five. The AI only writes the words (see server/digest.ts); it never ranks, adds
 * or removes anything, so an email's text cannot steer what is shown.
 */
export type DigestAction='reply'|'decide'|'deadline'|'meeting'|'security'|'review'|'fyi';
export const DIGEST_ACTIONS:DigestAction[]=['reply','decide','deadline','meeting','security','review','fyi'];
export const ACTION_LABEL:Record<DigestAction,string>={reply:'Needs your reply',decide:'Needs a decision',deadline:'Has a deadline',meeting:'Meeting',security:'Security',review:'Worth a look',fyi:'FYI'};
/** Wording for one item, and the saved set for an inbox. `fp` identifies what it was written from. */
export type DigestText={id:string;fp:string;headline:string;why:string;action:DigestAction;members?:number;grouping?:'conversation'|'notifications'|'single';membership?:string};
export type Digest={generated:number;items:DigestText[]};
export const DIGEST_SHOWN=5;
/** A few more than are shown, so ticking something off brings the next one up. */
export const DIGEST_CANDIDATES=8;

export type DigestItem={
  /** `emailKey` of the representative message: the key for "done" and for AI-written wording. */
  key:string;
  email:Email;
  /** Every message in the item: a conversation, or a run of related notifications. */
  keys:string[];
  /** Company name when several notifications were folded into one item. */
  group?:string;
  /** A thread between people, whose members are messages rather than notifications. */
  conversation?:boolean;
  importance:Importance;
  action:DigestAction;
  dueAt?:number;
  /** How strongly it earned its place; see lib/digest-rank. */
  score:number;
};

/** Compact identity of the exact messages behind one item, independent of display order. */
export function digestMembership(keys:string[]){
  let hash=0x811c9dc5;
  for(const key of [...keys].sort())for(const char of `${key}\u0000`){hash^=char.charCodeAt(0);hash=Math.imul(hash,0x01000193)>>>0;}
  return `${keys.length}:${hash.toString(36)}`;
}

function actionFor(email:Email,importance:Importance):DigestAction {
  if(email.classification?.securityEvent)return 'security';
  if(email.needsReply)return 'reply';
  if(importance.reasonCode.startsWith('meeting'))return 'meeting';
  if(importance.dueAt!==undefined)return 'deadline';
  return email.priority==='high'?'review':'fyi';
}
const threadKey=(email:Email)=>`${email.accountId||''}:${email.threadId||email.id}`;

/** The digest's items in rank order, already merged by conversation and by company. */
export function digestItems(emails:Email[],now:number,preferences:FoldPreferences={}):DigestItem[] {
  const items:DigestItem[]=[];
  const byThread=new Map<string,DigestItem>();
  const people=new Map<DigestItem,boolean>();
  for(const row of buildInboxRows(emails.filter(email=>email.category!=='noise'),now,'importance',preferences)){
    const lead=row.kind==='email'?row.email:row.lead;
    const importance=evaluateImportance(lead,now);
    if(!importance.important)continue;
    const members=row.kind==='email'?[row.email]:row.emails;
    const mergeable=members.filter(member=>preferenceFor(member,preferences)!=='separate');
    const existing=mergeable.map(member=>byThread.get(threadKey(member))).find(Boolean);
    if(existing){
      // The same conversation is one thing to act on, however many messages it has.
      for(const member of members)if(!existing.keys.includes(emailKey(member)))existing.keys.push(emailKey(member));
      if(members.some(fromPerson))people.set(existing,true);
      continue;
    }
    const item:DigestItem={key:emailKey(lead),email:lead,keys:members.map(emailKey),importance,action:actionFor(lead,importance),dueAt:importance.dueAt,score:0,
      ...(row.kind==='fold'&&row.reason==='conversation'?{conversation:true}:
        row.kind==='fold'&&members.every(isAutomatedSender)?{group:row.company}:{})};
    for(const member of mergeable)byThread.set(threadKey(member),item);
    people.set(item,members.some(fromPerson));
    items.push(item);
  }
  // A conversation with a person counts as theirs even when a notification leads it.
  for(const item of items)item.score=digestScore(item.email,item.importance,now,people.get(item));
  return items.filter(item=>item.score>=MIN_DIGEST_SCORE)
    .sort((a,b)=>b.score-a.score||a.importance.rank-b.importance.rank
      ||(a.dueAt??Infinity)-(b.dueAt??Infinity)||(b.email.receivedAt??0)-(a.email.receivedAt??0))
    .slice(0,DIGEST_CANDIDATES);
}

/**
 * Items for the server render and the first browser paint, before the browser's clock is known.
 *
 * Nothing time-based can be judged yet, so this reads the flags already stored on each message
 * (exactly as the rest of the dashboard does at this moment) and scores the clock-free sender, category and flag evidence. The
 * live policy replaces it the instant the clock arrives; it never produces a due date.
 */
export function provisionalItems(emails:Email[]):DigestItem[] {
  const waiting:Importance={tier:'routine',rank:TIER_RANK.routine,important:true,overdue:false,reasonCode:'clock-unknown',reason:'Waiting for the clock.'};
  const items:DigestItem[]=[];
  const seen=new Set<string>();
  for(const email of emails){
    if(email.category==='noise'||!cachedImportance(email)||seen.has(threadKey(email)))continue;
    seen.add(threadKey(email));
    items.push({key:emailKey(email),email,keys:[emailKey(email)],importance:waiting,action:actionFor(email,waiting),score:digestScore(email,waiting,null)});
  }
  return items.filter(item=>item.score>=MIN_DIGEST_SCORE).sort((a,b)=>b.score-a.score||(b.email.receivedAt||0)-(a.email.receivedAt||0)).slice(0,DIGEST_CANDIDATES);
}

const GREETING=/^(?:hi|hello|hey|dear)\b[^,.:\n]{0,40}[,:]\s*/i;
const shorten=(text:string,limit:number)=>{const flat=text.replace(/\s+/g,' ').trim();return flat.length>limit?flat.slice(0,limit-1).trimEnd()+'…':flat;};
/** Wording used when the AI has not written any: the email's own subject and one-line summary. */
export function fallbackText(item:Pick<DigestItem,'email'|'keys'|'group'|'conversation'>) {
  return {
    headline:shorten(item.conversation?`${item.email.subject} (${item.keys.length} messages)`:item.group?`${item.group}: ${item.keys.length} notifications`:item.email.subject,90),
    why:shorten(item.email.summary.replace(GREETING,'').replace(/^./,letter=>letter.toUpperCase()),170),
  };
}

const startOfDay=(time:number)=>{const date=new Date(time);return new Date(date.getFullYear(),date.getMonth(),date.getDate()).getTime();};
const dayGap=(time:number,now:number)=>Math.round((startOfDay(time)-startOfDay(now))/86400000);
/** "Due today", "Today, 3:00 PM" and so on, in the viewer's own timezone. */
export function dueLabel(item:Pick<DigestItem,'dueAt'|'importance'>,now:number):string|undefined {
  const {dueAt,importance}=item;
  if(dueAt===undefined)return undefined;
  if(importance.overdue||dueAt<now&&dayGap(dueAt,now)<0)return 'Overdue';
  const meeting=importance.reasonCode.startsWith('meeting');
  const time=new Date(dueAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  const days=dayGap(dueAt,now);
  if(days===0)return meeting?`Today, ${time}`:'Due today';
  if(days===1)return meeting?`Tomorrow, ${time}`:'Due tomorrow';
  const day=new Date(dueAt).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
  return meeting?`${day}, ${time}`:`Due ${day}`;
}
/** Whether the label should be drawn as urgent: today, tomorrow or already past. */
export function dueIsSoon(item:Pick<DigestItem,'dueAt'|'importance'>,now:number) {
  return item.dueAt!==undefined&&(item.importance.overdue||dayGap(item.dueAt,now)<=1);
}

/** A plain one-line tally of what is shown, for example "2 need a reply · 1 due today". */
export function digestSummary(items:Pick<DigestItem,'action'|'dueAt'|'importance'>[],now:number) {
  const count=(test:(item:Pick<DigestItem,'action'|'dueAt'|'importance'>)=>boolean)=>items.filter(test).length;
  const today=(item:Pick<DigestItem,'dueAt'|'importance'>)=>item.dueAt!==undefined&&!item.importance.overdue&&dayGap(item.dueAt,now)===0;
  const parts:[number,(n:number)=>string][]=[
    [count(item=>item.action==='reply'),n=>`${n} ${n===1?'needs':'need'} a reply`],
    [count(item=>item.importance.overdue),n=>`${n} overdue`],
    [count(item=>today(item)&&item.action!=='meeting'),n=>`${n} due today`],
    [count(item=>item.action==='meeting'&&today(item)),n=>`${n} ${n===1?'meeting':'meetings'} today`],
    [count(item=>item.action==='security'),n=>`${n} security ${n===1?'alert':'alerts'}`],
    [count(item=>item.action==='decide'),n=>`${n} ${n===1?'needs':'need'} a decision`],
  ];
  return parts.filter(([n])=>n>0).map(([n,label])=>label(n)).join(' · ');
}
