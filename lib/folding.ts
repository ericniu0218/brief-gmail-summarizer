import { isPublicMailDomain } from './addresses';
import type { Email } from './mail';

/**
 * Which inbox messages fold together, and why.
 *
 * Three relations, combined:
 *
 *   - **Same conversation** — messages that share a Gmail thread in one account, whoever
 *     sent them. A thread is an explicit link, so it is grouped whatever its age.
 *   - **Same topic** — automated mail from one organisation about one subject: shipping
 *     updates with shipping updates, security codes with security codes. Unrelated topics
 *     from the same company stay apart.
 *   - **Recent** — a topic group only joins messages that arrived within a week of its
 *     newest member; older ones stay separate rather than reviving last month's updates.
 *
 * The reader's own preferences come first: a sender marked "always group" folds together
 * regardless of topic or age, and a sender marked "keep separate" never folds at all.
 * Accounts never mix, and a group of one is not a group.
 */

export type FoldPreference = 'group' | 'separate';
/** Preferences keyed by `foldSenderKey` (a sender) or `foldMessageKey` (one message, kept separate). */
export type FoldPreferences = Readonly<Record<string, FoldPreference>>;
export type FoldReason = 'conversation' | 'topic' | 'sender';

/** Messages this close to a topic group's newest member may join it. */
export const TOPIC_WINDOW_MS = 7 * 86400000;

/** One sender in one account, the scope a preference applies to. */
export function foldSenderKey(email: Pick<Email, 'accountId' | 'address'>) {
  return JSON.stringify([email.accountId || 'demo', (email.address || '').trim().toLowerCase()]);
}

/** One message, for "keep these messages separate": only those messages, not their sender. */
export function foldMessageKey(email: Pick<Email, 'accountId' | 'id'>) {
  return JSON.stringify(['message', email.accountId || 'demo', email.id]);
}

/** The preference that applies to one message: its own "separate" first, then its sender's. */
export function preferenceFor(email: Email, preferences: FoldPreferences): FoldPreference | undefined {
  return preferences[foldMessageKey(email)] === 'separate' ? 'separate' : preferences[foldSenderKey(email)];
}

const COMMON_SECOND_LEVEL_DOMAINS = new Set(['co.uk', 'com.au', 'co.nz', 'co.jp']);

/** The organisation behind an address: github.com for noreply@github.com and security@github.com. */
export function organizationKey(email: Pick<Email, 'address' | 'sender'>) {
  const hostname = email.address.split('@')[1]?.toLowerCase().replace(/^www\./, '');
  if (!hostname) return email.sender.trim().toLowerCase();
  const labels = hostname.split('.').filter(Boolean);
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  return COMMON_SECOND_LEVEL_DOMAINS.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

// Mailboxes that send automatic mail. A person's address is never topic-grouped: two
// emails from a colleague are related only if they are in one conversation.
const AUTOMATED_SENDER = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|security|accounts?|support|updates?|orders?|shipping|shipment|delivery|billing|invoices?|receipts?|payments?|statements?|info|hello|team|mailer|messages?|digest|auto[-_.]?confirm|account[-_.]?security)(?:[.+_-]|$)/;

export function isAutomatedSender(email: Pick<Email, 'address'>) {
  const [local, domain = ''] = email.address.toLowerCase().split('@');
  return !!local && !!domain && !isPublicMailDomain(domain) && AUTOMATED_SENDER.test(local);
}

/** Topics, most specific first. Each is matched against the subject and the summary. */
const TOPICS: [string, string, RegExp][] = [
  ['security', 'Security and sign-in', /\b(?:verification|verify|sign[- ]?in|log[- ]?in|login|password|two[- ]factor|2fa|security|new device|one[- ]time (?:code|password)|authentication|passcode|access code)\b/i],
  ['shipping', 'Shipping updates', /\b(?:shipped|shipping|shipment|delivery|delivered|out for delivery|tracking|package|parcel|on (?:its|the) way|arriving|in transit|dispatched)\b/i],
  ['billing', 'Billing and payments', /\b(?:payment|paid|invoice|statement|bill|billing|charge[ds]?|refund(?:ed)?|subscription|renew(?:al|s|ed)?|autopay|balance due|amount due)\b/i],
  ['orders', 'Orders and receipts', /\b(?:order|receipt|purchase|confirmation number|booking|reservation)\b/i],
  ['developer', 'Developer notifications', /\b(?:repository|pull request|merge request|deployment|deploy|workflow|build (?:failed|passed|succeeded)|dependabot|commit|issue #?\d+|release)\b/i],
  ['events', 'Events and reminders', /\b(?:invitation|invited|reminder|appointment|event|rsvp|calendar)\b/i],
  ['social', 'Mentions and comments', /\b(?:mentioned|commented|replied to|new message|new follower|tagged you|reacted)\b/i],
  ['account', 'Account updates', /\b(?:account|profile|settings|setup|set up|getting started|welcome|activate|confirm your email|terms|privacy policy)\b/i],
];

/**
 * The topic of an automated message, or of any message as a fallback: its subject with
 * reply prefixes, numbers and identifiers removed, so "Your weekly report for May 3" and
 * "…for May 10" match while unrelated subjects do not.
 */
export function topicOf(email: Pick<Email, 'subject' | 'summary'>): { key: string; label: string } {
  const text = `${email.subject || ''} ${email.summary || ''}`;
  for (const [key, label, pattern] of TOPICS) if (pattern.test(text)) return { key, label };
  const subject = (email.subject || '').toLowerCase()
    .replace(/^(?:\s*(?:re|fwd?|aw|wg)\s*:\s*)+/i, '')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/g, ' ')
    .replace(/[#$€£]?\d[\d,./:-]*/g, ' ').replace(/[^a-z]+/g, ' ').trim();
  return { key: `subject:${subject || 'untitled'}`, label: email.subject?.trim() || 'Related messages' };
}

/** Union–find over message indices; a fold is one connected set of related messages. */
class Groups {
  private parent: number[];
  constructor(size: number) { this.parent = Array.from({ length: size }, (_, index) => index); }
  find(index: number): number {
    while (this.parent[index] !== index) { this.parent[index] = this.parent[this.parent[index]]; index = this.parent[index]; }
    return index;
  }
  join(a: number, b: number) { const x = this.find(a), y = this.find(b); if (x !== y) this.parent[Math.max(x, y)] = Math.min(x, y); }
}

export type FoldGroup = { members: number[]; reason: FoldReason; label: string; topic?: string };

/**
 * Fold groups for a list of messages, as index sets into `emails` (in the caller's order).
 * Linear apart from sorting each topic by arrival time.
 *
 * `conversationsOnly` folds Gmail threads and nothing else, the way Gmail's own inbox does.
 * A sender the reader keeps separate still never folds.
 */
export function foldGroups(emails: Email[], preferences: FoldPreferences = {}, { conversationsOnly = false } = {}): FoldGroup[] {
  const groups = new Groups(emails.length);
  // The strongest relation each message took part in, for the group's label.
  const reasonOf: (FoldReason | undefined)[] = Array.from({ length: emails.length });
  const topicLabel = new Map<number, string>();
  const preference = emails.map(email => preferenceFor(email, preferences));
  const joinAll = (indices: number[], reason: FoldReason) => {
    if (indices.length < 2) return;
    for (let i = 1; i < indices.length; i++) groups.join(indices[0], indices[i]);
    for (const index of indices) reasonOf[index] = strongest(reasonOf[index], reason);
  };

  const byThread = new Map<string, number[]>();
  const bySender = new Map<string, number[]>();
  const byTopic = new Map<string, number[]>();
  emails.forEach((email, index) => {
    if (preference[index] === 'separate') return;
    if (email.threadId) push(byThread, JSON.stringify([email.accountId || 'demo', email.threadId]), index);
    if (conversationsOnly) return;
    if (preference[index] === 'group') push(bySender, foldSenderKey(email), index);
    if (isAutomatedSender(email)) {
      const topic = topicOf(email);
      topicLabel.set(index, topic.label);
      push(byTopic, JSON.stringify([email.accountId || 'demo', organizationKey(email), topic.key]), index);
    }
  });
  for (const members of byThread.values()) joinAll(members, 'conversation');
  for (const members of bySender.values()) joinAll(members, 'sender');
  const bounds=new Map<number,{oldest:number;newest:number}>();
  emails.forEach((email,index)=>{
    if(typeof email.receivedAt!=='number')return;
    const root=groups.find(index),prior=bounds.get(root);
    bounds.set(root,{oldest:Math.min(prior?.oldest??email.receivedAt,email.receivedAt),
      newest:Math.max(prior?.newest??email.receivedAt,email.receivedAt)});
  });
  const joinTopic=(cluster:number[])=>{
    if(cluster.length<2)return;
    const newest=emails[cluster[0]].receivedAt;
    if(typeof newest!=='number'){joinAll(cluster,'topic');return;}
    // A long-running thread remains a conversation, but its old messages cannot bridge
    // into an unrelated topic cluster through transitive union.
    const eligible=cluster.filter(index=>{
      const span=bounds.get(groups.find(index));
      return !span||span.oldest>=newest-TOPIC_WINDOW_MS&&span.newest<=newest;
    });
    if(eligible.length<2)return;
    const combined=eligible.map(index=>bounds.get(groups.find(index))).filter((span):span is {oldest:number;newest:number}=>!!span);
    joinAll(eligible,'topic');
    bounds.set(groups.find(eligible[0]),{oldest:Math.min(...combined.map(span=>span.oldest)),newest});
  };
  for (const members of byTopic.values()) {
    // Newest first; a message joins the current cluster while it is within the window of
    // that cluster's newest member. Undated messages cluster together.
    const dated = members.filter(index => typeof emails[index].receivedAt === 'number')
      .sort((a, b) => (emails[b].receivedAt ?? 0) - (emails[a].receivedAt ?? 0));
    const undated = members.filter(index => typeof emails[index].receivedAt !== 'number');
    let cluster: number[] = [];
    for (const index of dated) {
      if (cluster.length && (emails[cluster[0]].receivedAt ?? 0) - (emails[index].receivedAt ?? 0) > TOPIC_WINDOW_MS) {
        joinTopic(cluster); cluster = [];
      }
      cluster.push(index);
    }
    joinTopic(cluster);
    joinTopic(undated);
  }

  const sets = new Map<number, number[]>();
  emails.forEach((_, index) => { if (preference[index] !== 'separate') push(sets, groups.find(index), index); });
  const result: FoldGroup[] = [];
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    // A group formed partly by conversation reads as a conversation; one the reader asked
    // for reads as their sender group; otherwise it is a topic.
    const reasons = members.map(index => reasonOf[index]);
    const reason: FoldReason = reasons.includes('conversation') ? 'conversation' : reasons.includes('sender') ? 'sender' : 'topic';
    const labels = new Set(members.map(index => topicLabel.get(index)).filter(Boolean));
    result.push({ members, reason, label: reason === 'topic' && labels.size === 1 ? [...labels][0]! : '' });
  }
  return result;
}

const STRENGTH: FoldReason[] = ['conversation', 'sender', 'topic'];
function strongest(current: FoldReason | undefined, next: FoldReason): FoldReason {
  return current && STRENGTH.indexOf(current) <= STRENGTH.indexOf(next) ? current : next;
}

function push<K>(map: Map<K, number[]>, key: K, index: number) {
  const list = map.get(key);
  if (list) list.push(index); else map.set(key, [index]);
}
