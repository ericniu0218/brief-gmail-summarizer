import type { Email } from './mail';
import { isOverviewMessage } from './classification';

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
 * Messages carrying a structured classification are judged by the shared policy, so the
 * dashboard cannot hide one just because the classifier's original guess was Junk.
 * The keyword rule remains only for messages that have no classification, such as the
 * sample workspace and snapshots predating structured results.
 */
export function isImportantEmail(email:Email,now=Date.now()) {
  if(email.classification)return isOverviewMessage(email.classification,now);
  return email.category!=='noise'&&(email.needsReply||email.priority==='high'||hasImportantSignal(email.subject,`${email.summary} ${email.body}`));
}

export function sortInboxEmails(emails:Email[]) {
  return emails.map((email,index)=>({email,index})).sort((a,b)=>
    Number(b.email.needsReply)-Number(a.email.needsReply)||
    Number(isImportantEmail(b.email))-Number(isImportantEmail(a.email))||
    Number(b.email.priority==='high')-Number(a.email.priority==='high')||
    Number(b.email.unread)-Number(a.email.unread)||
    a.index-b.index,
  ).map(({email})=>email);
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
  return isImportantEmail(email)&&FOLDABLE_OPERATIONAL.test(searchable(email));
}

export function buildInboxRows(emails:Email[]):InboxRow[] {
  const sorted=sortInboxEmails(emails);
  const buckets=new Map<string,Email[]>();
  for(const email of sorted){
    if(!isFoldableOperationalEmail(email))continue;
    const key=organizationKey(email);
    buckets.set(key,[...(buckets.get(key)||[]),email]);
  }
  const folded=new Map<string,Email[]>();
  for(const [key,items] of buckets)if(items.length>1)folded.set(key,items);
  const emitted=new Set<string>();
  const rows:InboxRow[]=[];
  for(const email of sorted){
    const key=organizationKey(email);const group=folded.get(key);
    if(group?.includes(email)){
      if(emitted.has(key))continue;
      emitted.add(key);
      rows.push({kind:'fold',id:`fold:${key}`,company:companyName(group[0],key),emails:group,needsReplyCount:group.filter(item=>item.needsReply).length});
      continue;
    }
    rows.push({kind:'email',email});
  }
  return rows;
}
