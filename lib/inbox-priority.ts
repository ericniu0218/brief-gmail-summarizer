import type { Email } from './mail';
import { foldGroups, foldSenderKey, organizationKey, type FoldPreferences, type FoldReason } from './folding';
import { cachedImportance, evaluateImportance, receivedAtOf, type Importance, type ImportanceTier } from './importance';

const SECURITY_OR_ACCESS = /\b(verification code|verify (?:your|this)|security alert|security code|one[- ]time (?:code|password)|otp|two[- ]factor|2fa|password reset|reset your password|new (?:sign[- ]in|login|device)|unrecognized (?:sign[- ]in|login)|confirm your (?:email|account|identity)|activate your account)\b/i;
const DIRECT_ACTION = /\b(action required|approval (?:needed|required)|response (?:needed|required)|complete (?:your|the) setup|finish (?:your|the) setup|setup incomplete|due (?:today|tomorrow)|deadline|urgent)\b/i;

export type InboxEmailRow = {kind:'email';email:Email};
export type InboxFoldRow = {
  kind:'fold';
  id:string;
  company:string;
  emails:Email[];
  needsReplyCount:number;
  /** The message that earned the group its position, shown so it is not buried. */
  lead:Email;
  /** Why these messages are together: one conversation, one topic, or the reader's choice. */
  reason:FoldReason;
  /** A short description of the group, such as "Shipping updates" or "Conversation". */
  label:string;
};
export type InboxRow = InboxEmailRow | InboxFoldRow;

export function hasImportantSignal(subject:string,content:string) {
  const text=`${subject} ${content}`;
  return SECURITY_OR_ACCESS.test(text)||DIRECT_ACTION.test(text);
}

/**
 * Whether a message belongs in Important now, decided by the shared time-based policy.
 *
 * Keyword matching plays no part: a sender writing "urgent" is not evidence, and neither
 * is a message being unread. Both were previously able to promote a message on their own.
 */
export function isImportantEmail(email:Email,now:number|null) {
  // `null` means the clock is not known yet; see `cachedImportance`.
  return now===null?cachedImportance(email):evaluateImportance(email,now).important;
}

/**
 * `newest` orders purely by arrival; `importance` applies the policy below; `reply` is the
 * "Needs a reply" tab: answers wanted soon first, then routine ones, each in importance order.
 */
export type SortMode='importance'|'newest'|'reply';

/** 0 for a reply wanted soon, 1 for any other pending reply, 2 for no pending reply. */
function replyRank(email:Email){
  if(!email.needsReply)return 2;
  return email.classification?.reply?.urgency==='prompt'?0:1;
}

const identityOf=(email:Email)=>`${email.accountId||''}:${email.id}`;

/** Tiers pinned above everything else in importance mode: what needs the reader now. */
const PINNED=new Set<ImportanceTier>(['due-now','recent-request','overdue']);
const pinned=(importance:Importance|undefined)=>!!importance&&importance.important&&PINNED.has(importance.tier);

/**
 * Deterministic ordering.
 *
 * In importance mode, only what needs the reader now is pinned: current obligations, then
 * recent direct requests, then recently overdue work. Everything else, older unresolved
 * items included, follows newest first, so new mail is never buried under weeks-old tasks.
 * The reply tab ranks every tier as before. Inside a tier the earliest supported due time
 * wins, then the most recent arrival, then the composite identity — so the order never
 * depends on the input order or on a clock tick mid-sort.
 *
 * Importance is evaluated once per message rather than inside the comparator, which would
 * otherwise re-derive every classification on each of O(n log n) comparisons.
 */
export function sortInboxEmails(emails:Email[],now:number|null,mode:SortMode='importance') {
  // With no clock, even arrival order cannot be validated: a forged future timestamp
  // would jump to the top for the first paint. Preserve the server's validated order until
  // the browser clock arrives, which also keeps hydration deterministic.
  if(now===null)return [...emails];
  const ordering=mode;
  const scored=emails.map((email,index)=>({
    email,index,received:receivedAtOf(email,now),
    importance:now===null?undefined:evaluateImportance(email,now),
  }));
  scored.sort((a,b)=>{
    if(ordering==='reply'){
      const rank=replyRank(a.email)-replyRank(b.email);
      if(rank)return rank;
    }
    if(ordering==='importance'){
      const aPinned=pinned(a.importance),bPinned=pinned(b.importance);
      if(aPinned!==bPinned)return aPinned?-1:1;
    }
    if((ordering==='reply'||ordering==='importance'&&pinned(a.importance))&&a.importance&&b.importance){
      if(a.importance.important!==b.importance.important)return a.importance.important?-1:1;
      if(a.importance.rank!==b.importance.rank)return a.importance.rank-b.importance.rank;
      // Unknown due times sort last within a tier without ever producing NaN, because
      // two equal infinities are compared for equality rather than subtracted.
      const aDue=a.importance.dueAt??Infinity,bDue=b.importance.dueAt??Infinity;
      if(aDue!==bDue)return aDue-bDue;
    }
    // Newest first. An unknown timestamp sorts last rather than jumping the queue.
    const aAt=a.received??-Infinity,bAt=b.received??-Infinity;
    if(aAt!==bAt)return bAt-aAt;
    return identityOf(a.email).localeCompare(identityOf(b.email))||a.index-b.index;
  });
  return scored.map(({email})=>email);
}

function companyName(email:Email,key:string) {
  const sender=email.sender.trim();
  if(sender&&!/^(?:no[- ]?reply|notifications?|security|support)$/i.test(sender))return sender.replace(/\s+(?:security|notifications?|support)$/i,'');
  const name=key.split('.')[0]||'Company';
  return name.toLowerCase()==='github'?'GitHub':name.charAt(0).toUpperCase()+name.slice(1);
}

/** Who a conversation is between, by first name, for the folded row's heading. */
function participants(group:Email[]){
  const names=[...new Set(group.map(email=>(email.sender||email.address).trim().split(/\s+/)[0]))];
  return names.length<=2?names.join(', '):`${names.slice(0,2).join(', ')} +${names.length-2}`;
}

/**
 * Rows for the inbox list, with related messages folded together (see lib/folding): one
 * conversation, one topic from one organisation within a week, or a sender the reader
 * chose to group. Senders the reader keeps separate are never folded.
 *
 * A group takes the position of its most important member and shows that member as its
 * heading, so an urgent message is never hidden under a routine preview or under a
 * sibling that merely happens to be older.
 */
export function buildInboxRows(emails:Email[],now:number|null,mode:SortMode='importance',preferences:FoldPreferences={},{conversationsOnly=false}={}):InboxRow[] {
  const sorted=sortInboxEmails(emails,now,mode);
  const groupOf=new Map<number,{members:number[];reason:FoldReason;label:string}>();
  for(const group of foldGroups(sorted,preferences,{conversationsOnly})){
    // Members in list order, so the first is the one that placed the group.
    group.members.sort((a,b)=>a-b);
    for(const index of group.members)groupOf.set(index,group);
  }
  const rows:InboxRow[]=[];
  sorted.forEach((email,index)=>{
    const group=groupOf.get(index);
    if(!group){rows.push({kind:'email',email});return;}
    if(group.members[0]!==index)return;
    const members=group.members.map(member=>sorted[member]);
    const lead=members[0];
    const reason=group.reason==='sender'&&members.some(member=>foldSenderKey(member)!==foldSenderKey(lead))?'topic':group.reason;
    rows.push({kind:'fold',id:`fold:${identityOf(members.reduce((a,b)=>identityOf(a)<identityOf(b)?a:b))}`,
      company:reason==='conversation'?participants(members):companyName(lead,organizationKey(lead)),
      emails:members,needsReplyCount:members.filter(item=>item.needsReply).length,lead,reason,
      label:reason==='conversation'?'Conversation':reason==='sender'?'Grouped sender':group.label||'Related updates'});
  });
  return rows;
}
