import type { Email } from './mail';
import type { Importance } from './importance';
import { isAutomatedSender } from './folding';
import { sameOrganization } from './addresses';

/**
 * Which important mail is worth one of the brief's five places.
 *
 * Everything here has already passed the importance policy, and the reader goes through all
 * of it in the inbox anyway. The brief is the short list on top: mail from people, above
 * all people the reader writes to, about work, that needs them soon, and any decision or
 * result about the reader, even from a list (tryouts, grades, offers). Notices that confirm
 * something the reader just did (a code, a reset, an email check) rarely deserve a place.
 *
 * The score is a plain sum so every reason is visible in `DIGEST_WEIGHTS`, and an item has
 * to reach `MIN_DIGEST_SCORE` to be shown at all: a quiet day shows fewer than five.
 */
export const DIGEST_WEIGHTS = {
  /** The reader has emailed this sender before. */
  knownSender: 40,
  /** A person writing directly, not a system, a list or a no-reply address. */
  person: 25,
  /** An address from the reader's own school or employer that is not a person. */
  ownOrganization: 5,
  /** A notification system, a role address or a list. */
  automated: -10,
  work: 10,
  urgency: { 'due-now': 25, 'recent-request': 15, overdue: 12, aging: 0, flagged: 0, routine: 0 } as Record<Importance['tier'], number>,
  /** A decision or result about the reader: tryouts, admissions, grades, offers. Whoever sends it. */
  outcome: 40,
  /** An answer owed to a person outranks one a system asks for. */
  replyToPerson: 20,
  replyToSystem: 0,
  /** Unexpected account activity: someone else may be in the account. */
  securityAlarm: 10,
  /** A code, a reset or a confirmation of something the reader just did. */
  securityRoutine: -25,
  starred: 15,
  gmailImportant: 5,
  gmailPrimary: 5,
  gmailForums: -10,
  /** Arrived in the last day, or the last three days; older than two weeks is stale. */
  freshDay: 10,
  freshDays: 5,
  stale: -15,
} as const;

/** The lowest score that earns a place in the brief. */
export const MIN_DIGEST_SCORE = 30;

const HOUR = 3600000;

/** Local parts that name a function or a system rather than a person. Matched as whole dot, dash, plus or underscore-delimited parts. */
const ROLE = /(?:^|[._+-])(?:no[._-]?reply|do[._-]?not[._-]?reply|notifications?|notify|alerts?|verify|verification|support|help|updates?|orders?|billing|invoices?|receipts?|payments?|statements?|info|hello|team|mailer|messages?|digest|news|marketing|promos?|offers?|services?|security|accounts?|admin|system|bot|feedback|surveys?|contact|members?|events?|careers?|recruitment|registrar|admissions?|office|staff|workout|bank|calnet|participation|confirmation|welcome|reminders?|calendar|courses?|students?|portal|app|store|shop|communications?|billpay|announcements?|newsroom|outreach)(?:$|[._+-])/;
/** Sending subdomains that bulk mail goes out from: notification.example.com, ealerts.bank.com. */
const BULK_SUBDOMAIN = /(?:^|[.-])(?:e?mail|e?alerts?|notifications?|news|info|em|mg|updates?|marketing|promo|bounce|send)(?:[.-]|$)/;

/**
 * A blast: the reader is not a visible recipient, and the message is addressed to its own
 * sender (or to nobody), the usual way a mass mailing hides its list in Bcc. Mail to named
 * colleagues that reached the reader through an alias is not a blast.
 */
export function isBlast(email: Pick<Email, 'address' | 'to' | 'cc' | 'accountEmail' | 'readerWasRecipient'>): boolean {
  if(email.readerWasRecipient===true)return false;
  const reader = (email.accountEmail || '').toLowerCase();
  if (!reader || !Array.isArray(email.to)) return false;
  const recipients = [...email.to, ...(email.cc || [])].map(address => address.toLowerCase());
  if (recipients.includes(reader)) return false;
  const visible = email.to.map(address => address.toLowerCase());
  return visible.length === 0 || visible.includes((email.address || '').toLowerCase());
}

/** Mail written by a person to the reader, as far as the message can tell. */
export function fromPerson(email: Email): boolean {
  if (email.senderFamiliarity?.status === 'previously-emailed' || email.classification?.priorCorrespondence) return true;
  const labels = email.gmailLabels || [];
  if (email.listId || email.unsubscribe || labels.some(label => label === 'CATEGORY_PROMOTIONS' || label === 'CATEGORY_SOCIAL' || label === 'CATEGORY_FORUMS')) return false;
  if (isAutomatedSender(email) || isBlast(email)) return false;
  const [local = '', domain = ''] = (email.address || '').toLowerCase().split('@');
  return !!local && !ROLE.test(local) && !BULK_SUBDOMAIN.test(domain.split('.').slice(0, -2).join('.'));
}

/** Subjects announcing an outcome for the reader. Read from the subject only, where it is reliable. */
const OUTCOME = /\b(?:decisions?|(?:tryout|exam|test|application|admission|selection|assessment) results?|accepted|acceptance|admitted|admissions? decision|selected|selection|roster|offer letter|job offer|approved|denied|rejected|wait-?list(?:ed)?|(?:grades?|scores?|marks)\s+(?:are\s+)?(?:released|posted|available|out)|placement|outcome)\b/i;

const SECURITY_ALARM = /\b(?:unrecogni[sz]ed|suspicious|unusual|new (?:sign[- ]?in|login|device)|someone (?:signed|logged) in|locked|compromised|breach|fraud)\b/i;
const SECURITY_ROUTINE = /\b(?:verification code|verify (?:your|this)|get verified|verified|email verification|single-use code|one[- ]time (?:code|password|passcode)|security code|sign[- ]in code|login code|passcode|(?:password|passphrase) (?:was )?(?:reset|changed)|reset (?:your )?(?:password|passphrase)|mfa|multi-?factor|two[- ]factor|2fa|factor enrolled|confirm your (?:email|account))\b/i;

/** The brief score for an item led by `email`; `people` is true when any message in it is from a person. */
export function digestScore(email: Email, importance: Importance, now: number | null, people = fromPerson(email)): number {
  const W = DIGEST_WEIGHTS;
  const known = email.senderFamiliarity?.status === 'previously-emailed' || !!email.classification?.priorCorrespondence;
  const text = `${email.subject || ''} ${email.summary || ''}`;
  // A mass mailing counts as automated even from the reader's own school or employer.
  let score = known ? W.knownSender : people ? W.person
    : !isBlast(email) && email.accountEmail && sameOrganization(email.address || '', email.accountEmail) ? W.ownOrganization : W.automated;
  if (email.category === 'work') score += W.work;
  if (!/^(?:accepted|declined|tentative|tentatively accepted):/i.test(email.subject || '') && !/\bsearch results?\b/i.test(email.subject || '') && OUTCOME.test(email.subject || '')) score += W.outcome;
  score += W.urgency[importance.tier] ?? 0;
  if (email.needsReply) score += people ? W.replyToPerson : W.replyToSystem;
  if (email.classification?.securityEvent || SECURITY_ROUTINE.test(text))
    score += SECURITY_ALARM.test(text) ? W.securityAlarm : SECURITY_ROUTINE.test(text) ? W.securityRoutine : 0;
  const labels = email.gmailLabels || [];
  if (labels.includes('STARRED')) score += W.starred;
  if (labels.includes('IMPORTANT')) score += W.gmailImportant;
  if (labels.includes('CATEGORY_PERSONAL')) score += W.gmailPrimary;
  if (labels.includes('CATEGORY_FORUMS')) score += W.gmailForums;
  const age = now !== null && typeof email.receivedAt === 'number' ? now - email.receivedAt : undefined;
  if (age !== undefined && age >= 0) score += age <= 24 * HOUR ? W.freshDay : age <= 72 * HOUR ? W.freshDays : age > 14 * 24 * HOUR ? W.stale : 0;
  return score;
}
