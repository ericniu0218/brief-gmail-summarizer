import { emailKey, type Email } from './mail';
import { buildInboxRows } from './inbox-priority';
import { cachedImportance, evaluateImportance, type Importance } from './importance';

/**
 * The daily digest: the few things in the inbox most worth the user's attention.
 *
 * Which items appear, and in what order, is decided by the app's one importance policy
 * (`evaluateImportance`, via `buildInboxRows`) so the digest can never disagree with Overview,
 * the counts or the list order. The AI only writes the words (see server/digest.ts); it never
 * ranks, adds or removes anything, so an email's text cannot steer what is shown.
 */
export type DigestAction='reply'|'decide'|'deadline'|'meeting'|'security'|'review'|'fyi';
export const DIGEST_ACTIONS:DigestAction[]=['reply','decide','deadline','meeting','security','review','fyi'];
export const ACTION_LABEL:Record<DigestAction,string>={reply:'Needs your reply',decide:'Needs a decision',deadline:'Has a deadline',meeting:'Meeting',security:'Security',review:'Worth a look',fyi:'FYI'};
/** Wording for one item, and the saved set for an inbox. `fp` identifies what it was written from. */
export type DigestText={id:string;fp:string;headline:string;why:string;action:DigestAction};
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
  importance:Importance;
  action:DigestAction;
  dueAt?:number;
};

function actionFor(email:Email,importance:Importance):DigestAction {
  if(email.classification?.securityEvent)return 'security';
  if(email.needsReply)return 'reply';
  if(importance.reasonCode.startsWith('meeting'))return 'meeting';
  if(importance.dueAt!==undefined)return 'deadline';
  return email.priority==='high'?'review':'fyi';
}
const threadKey=(email:Email)=>`${email.accountId||''}:${email.threadId||email.id}`;

/** The digest's items in rank order, already merged by conversation and by company. */
export function digestItems(emails:Email[],now:number):DigestItem[] {
  const items:DigestItem[]=[];
  const byThread=new Map<string,DigestItem>();
  for(const row of buildInboxRows(emails.filter(email=>email.category!=='noise'),now)){
    const lead=row.kind==='email'?row.email:row.lead;
    const importance=evaluateImportance(lead,now);
    if(!importance.important)continue;
    const members=row.kind==='email'?[row.email]:row.emails;
    const existing=members.map(member=>byThread.get(threadKey(member))).find(Boolean);
    if(existing){
      // The same conversation is one thing to act on, however many messages it has.
      for(const member of members)if(!existing.keys.includes(emailKey(member)))existing.keys.push(emailKey(member));
      continue;
    }
    const item:DigestItem={key:emailKey(lead),email:lead,keys:members.map(emailKey),importance,action:actionFor(lead,importance),dueAt:importance.dueAt,
      ...(row.kind==='fold'?{group:row.company}:{})};
    for(const member of members)byThread.set(threadKey(member),item);
    items.push(item);
    if(items.length>=DIGEST_CANDIDATES)break;
  }
  return items;
}

/**
 * Items for the server render and the first browser paint, before the browser's clock is known.
 *
 * Nothing time-based can be judged yet, so this reads the flags already stored on each message
 * (exactly as the rest of the dashboard does at this moment) and keeps the server's order. The
 * live policy replaces it the instant the clock arrives; it never produces a due date.
 */
export function provisionalItems(emails:Email[]):DigestItem[] {
  const waiting:Importance={tier:'routine',rank:4,important:true,overdue:false,reasonCode:'clock-unknown',reason:'Waiting for the clock.'};
  const items:DigestItem[]=[];
  const seen=new Set<string>();
  for(const email of emails){
    if(email.category==='noise'||!cachedImportance(email)||seen.has(threadKey(email)))continue;
    seen.add(threadKey(email));
    items.push({key:emailKey(email),email,keys:[emailKey(email)],importance:waiting,action:actionFor(email,waiting)});
    if(items.length>=DIGEST_CANDIDATES)break;
  }
  return items;
}

const GREETING=/^(?:hi|hello|hey|dear)\b[^,.:\n]{0,40}[,:]\s*/i;
const shorten=(text:string,limit:number)=>{const flat=text.replace(/\s+/g,' ').trim();return flat.length>limit?flat.slice(0,limit-1).trimEnd()+'…':flat;};
/** Wording used when the AI has not written any: the email's own subject and one-line summary. */
export function fallbackText(item:Pick<DigestItem,'email'|'keys'|'group'>) {
  return {
    headline:shorten(item.group?`${item.group}: ${item.keys.length} notifications`:item.email.subject,90),
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
