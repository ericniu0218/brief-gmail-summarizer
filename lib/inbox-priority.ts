import type { Email } from './mail';
import { cachedImportance, evaluateImportance, receivedAtOf } from './importance';

const SECURITY_OR_ACCESS = /\b(verification code|verify (?:your|this)|security alert|security code|one[- ]time (?:code|password)|otp|two[- ]factor|2fa|password reset|reset your password|new (?:sign[- ]in|login|device)|unrecognized (?:sign[- ]in|login)|confirm your (?:email|account|identity)|activate your account)\b/i;
const DIRECT_ACTION = /\b(action required|approval (?:needed|required)|response (?:needed|required)|complete (?:your|the) setup|finish (?:your|the) setup|setup incomplete|due (?:today|tomorrow)|deadline|urgent)\b/i;
const FOLDABLE_OPERATIONAL = /\b(verification|verify|security|one[- ]time|authentication|two[- ]factor|2fa|setup|set up|getting started|sign[- ]in|login|password|confirm|activate|device|invitation|invited|repository|deployment|workflow|dependabot)\b/i;
const COMMON_SECOND_LEVEL_DOMAINS = new Set(['co.uk','com.au','co.nz','co.jp']);

export type InboxEmailRow = {kind:'email';email:Email};
export type InboxFoldRow = {
  kind:'fold';
  id:string;
  company:string;
  emails:Email[];
  needsReplyCount:number;
  /** The message that earned the group its position, shown so it is not buried. */
  lead:Email;
};
export type InboxRow = InboxEmailRow | InboxFoldRow;

function searchable(email:Pick<Email,'subject'|'summary'|'body'>) {
  return `${email.subject} ${email.summary} ${email.body}`;
}

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

/** `newest` orders purely by arrival; `importance` applies the policy below. */
export type SortMode='importance'|'newest';

const identityOf=(email:Email)=>`${email.accountId||''}:${email.id}`;

/**
 * Deterministic ordering.
 *
 * In importance mode: current obligations first, then recent direct requests, then
 * recently overdue work, then older unresolved items, then routine mail. Inside a tier the
 * earliest supported due time wins, then the most recent arrival, then the composite
 * identity — so the order never depends on the input order or on a clock tick mid-sort.
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
    if(ordering==='importance'&&a.importance&&b.importance){
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

function organizationKey(email:Email) {
  const hostname=email.address.split('@')[1]?.toLowerCase().replace(/^www\./,'');
  if(!hostname)return email.sender.trim().toLowerCase();
  const labels=hostname.split('.').filter(Boolean);
  if(labels.length<=2)return hostname;
  const lastTwo=labels.slice(-2).join('.');
  return COMMON_SECOND_LEVEL_DOMAINS.has(lastTwo)?labels.slice(-3).join('.'):lastTwo;
}

function companyName(email:Email,key:string) {
  const sender=email.sender.trim();
  if(sender&&!/^(?:no[- ]?reply|notifications?|security|support)$/i.test(sender))return sender.replace(/\s+(?:security|notifications?|support)$/i,'');
  const name=key.split('.')[0]||'Company';
  return name.toLowerCase()==='github'?'GitHub':name.charAt(0).toUpperCase()+name.slice(1);
}

function isFoldableOperationalEmail(email:Email) {
  return FOLDABLE_OPERATIONAL.test(searchable(email));
}

/**
 * Rows for the inbox list, with operational mail from one organisation folded together.
 *
 * A group takes the position of its most important member and shows that member as its
 * heading, so an urgent message is never hidden under a routine preview or under a
 * sibling that merely happens to be older.
 */
export function buildInboxRows(emails:Email[],now:number|null,mode:SortMode='importance'):InboxRow[] {
  const sorted=sortInboxEmails(emails,now,mode);
  const buckets=new Map<string,Email[]>();
  const keyOf=new Map<Email,string>();
  for(const email of sorted){
    if(!isFoldableOperationalEmail(email))continue;
    const key=organizationKey(email);
    keyOf.set(email,key);
    const bucket=buckets.get(key);
    if(bucket)bucket.push(email);
    else buckets.set(key,[email]);
  }
  const emitted=new Set<string>();
  const rows:InboxRow[]=[];
  for(const email of sorted){
    // Membership is answered by the map built above rather than by scanning a group, and
    // a bucket of one is simply not a group.
    const key=keyOf.get(email);
    const group=key===undefined?undefined:buckets.get(key);
    if(key!==undefined&&group&&group.length>1){
      if(emitted.has(key))continue;
      emitted.add(key);
      // `group` follows the sorted order, so its first member is the one that placed it.
      rows.push({kind:'fold',id:`fold:${key}`,company:companyName(group[0],key),emails:group,
        needsReplyCount:group.filter(item=>item.needsReply).length,lead:group[0]});
      continue;
    }
    rows.push({kind:'email',email});
  }
  return rows;
}
