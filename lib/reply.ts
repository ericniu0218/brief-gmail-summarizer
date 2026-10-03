import type { ExtractedDate } from './classification';
import { resolveDate } from './dates';
import { inForumsTab } from './gmail-signals';
import { assessPurpose, commercialFamiliesIn, isCampaignFooter, isCommercialSentence, securityEvidence } from './purpose';

/**
 * Does the recipient currently owe someone an email answer, decision, confirmation,
 * information or deliverable?
 *
 * That question is answered here, once, for every path: the rule-based classifier, the
 * validation of model output, the recheck of stored results after a rule change, and manual
 * corrections. It is deliberately separate from importance, urgency and tasks. A routine
 * unanswered question belongs in "Needs a reply" without becoming Important; a critical
 * security alert stays Important without asking for an email answer; an approval that is
 * made in a portal is a task, not a reply.
 *
 * Each request in a message is judged on its own — who it is for, whether it is answered by
 * email or somewhere else, whether it is conditional, optional, or already settled — and one
 * open email obligation is enough. A "thanks", a portal link or an optional survey elsewhere
 * in the message never cancels a separate, real request.
 *
 * Message text is untrusted data. Nothing in it is followed as an instruction; it is only
 * matched against the forms below.
 */

export type ReplyStatus = 'required' | 'not_required' | 'uncertain';
export type ReplyUrgency = 'prompt' | 'routine' | 'unknown';
export type ReplyChannel = 'email' | 'other' | 'none' | 'unknown';
export type ReplyReason =
  | 'decision_requested'
  | 'information_requested'
  | 'scheduling_answer_requested'
  | 'emailed_deliverable'
  | 'assigned_communication'
  | 'action_in_other_channel'
  | 'acknowledgment_only'
  | 'waiting_for_sender'
  | 'conditional_reply_inactive'
  | 'optional_engagement'
  | 'automatic_response'
  | 'suspicious_request'
  | 'insufficient_context'
  | 'already_answered'
  | 'no_request';

export type ReplyAssessment = {
  status: ReplyStatus;
  urgency: ReplyUrgency;
  channel: ReplyChannel;
  reasonCode: ReplyReason;
  /** A short quote from the current message that the decision rests on. */
  evidence: string;
  /** One plain sentence for the reader, grounded in the message. */
  explanation: string;
  /** When the answer itself is due, only when the message ties a date to the answer. */
  due?: ExtractedDate;
  /** For an inactive conditional reply: what would have to happen first. */
  condition?: string;
  /** Who decided: the rules, the model, the two reconciled, or a person's correction. */
  source: 'rules' | 'model' | 'reconciled' | 'manual';
};

export const REPLY_STATUSES: readonly ReplyStatus[] = ['required', 'not_required', 'uncertain'];
export const REPLY_URGENCIES: readonly ReplyUrgency[] = ['prompt', 'routine', 'unknown'];
export const REPLY_CHANNELS: readonly ReplyChannel[] = ['email', 'other', 'none', 'unknown'];
export const REPLY_REASONS: readonly ReplyReason[] = ['decision_requested', 'information_requested',
  'scheduling_answer_requested', 'emailed_deliverable', 'assigned_communication', 'action_in_other_channel',
  'acknowledgment_only', 'waiting_for_sender', 'conditional_reply_inactive', 'optional_engagement',
  'automatic_response', 'suspicious_request', 'insufficient_context', 'already_answered', 'no_request'];
const SOURCES: readonly ReplyAssessment['source'][] = ['rules', 'model', 'reconciled', 'manual'];

const MAX_EVIDENCE = 240;
const MAX_EXPLANATION = 200;
const MAX_CONDITION = 120;
/** Sentences read per message, and characters per sentence: long or hostile mail stays cheap. */
const MAX_SENTENCES = 120;
const MAX_SENTENCE = 600;

const clip = (value: unknown, limit: number) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';

/**
 * A stored or received assessment, or undefined when it is not one this version
 * understands. Every reader goes through here, so a damaged or older record degrades to
 * "no assessment" instead of reaching the policy or the interface as arbitrary data.
 */
export function asReplyAssessment(value: unknown): ReplyAssessment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!REPLY_STATUSES.includes(raw.status as ReplyStatus)) return undefined;
  if (!REPLY_REASONS.includes(raw.reasonCode as ReplyReason)) return undefined;
  const due = raw.due && typeof raw.due === 'object' && typeof (raw.due as ExtractedDate).phrase === 'string'
    ? raw.due as ExtractedDate : undefined;
  return {
    status: raw.status as ReplyStatus,
    urgency: REPLY_URGENCIES.includes(raw.urgency as ReplyUrgency) ? raw.urgency as ReplyUrgency : 'unknown',
    channel: REPLY_CHANNELS.includes(raw.channel as ReplyChannel) ? raw.channel as ReplyChannel : 'unknown',
    reasonCode: raw.reasonCode as ReplyReason,
    evidence: clip(raw.evidence, MAX_EVIDENCE),
    explanation: clip(raw.explanation, MAX_EXPLANATION),
    due: due ? { ...due, phrase: clip(due.phrase, 120) } : undefined,
    condition: clip(raw.condition, MAX_CONDITION) || undefined,
    source: SOURCES.includes(raw.source as ReplyAssessment['source']) ? raw.source as ReplyAssessment['source'] : 'rules',
  };
}

/** The one place the reply badge is derived from: a certain, open email obligation. */
export function replyRequiredFrom(reply: ReplyAssessment | undefined, fallback = false) {
  return reply ? reply.status === 'required' : fallback;
}

// ── Recipient context ───────────────────────────────────────────────────────

/**
 * Trusted facts about the recipient's relationship to this message, supplied separately from
 * the message text. Production has no source for these yet (no stored preference says "I
 * asked this vendor to follow up"), so it never passes one; evaluation passes the
 * workbook's recipient context through `interpretRecipientContext`.
 *
 * Context only resolves the cases the message cannot settle alone: an offer the recipient
 * did or did not ask for, and a vendor's follow-up on an evaluation. It never creates a
 * reply out of a message that asks nothing.
 */
export type RecipientContext = { solicited?: boolean };

/** Read a trusted plain-language description of the recipient's position. */
export function interpretRecipientContext(statement: string | undefined): RecipientContext {
  const text = (statement || '').toLowerCase();
  if (!text) return {};
  if (/\b(?:no relationship|not seeking|do not need|don't need|no current|have not committed|no obligation|not interested|did not ask|unsolicited)\b/.test(text))
    return { solicited: false };
  if (/\byou (?:asked|requested|want|wanted|would like|are interested|agreed to|intend to continue|are waiting for)\b/.test(text))
    return { solicited: true };
  return {};
}

// ── Message shape ───────────────────────────────────────────────────────────

/** What the assessment reads. Only the current message: quoted history is context, not a request. */
export type ReplyInput = {
  subject: string;
  text: string;
  from: { name?: string; address: string };
  to?: { name?: string; address: string }[];
  cc?: { name?: string; address: string }[];
  receivedAt: number;
  labels?: string[];
  headers?: Record<string, string>;
  distribution?: { listUnsubscribe?: boolean; bulkPrecedence?: boolean };
};

// ── Sentences ───────────────────────────────────────────────────────────────

// Periods that do not end a sentence. "Tuesday at 10 a.m. or Wednesday at 2 p.m." is one
// scheduling question, not three fragments.
const ABBREVIATION = /\b(a\.m|p\.m|e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|st|jr|sr|inc|ltd|co|dept|no)\./gi;
const SHIELD = '․';
const GREETING = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|greetings)(?:\s+[a-z][a-z'’-]*(?:\s+[a-z][a-z'’-]*){0,2})?[,!:]?\s*$/i;
const VALEDICTION = /^(?:best|best regards|best wishes|regards|kind regards|warm regards|many thanks|thanks|thank you|thanks again|cheers|sincerely|all the best|talk soon|warmly|yours|respectfully)[,!.]?\s*$/i;

/** The body without its greeting and sign-off, split into sentences. Bounded. */
export function replySentences(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i--) if (VALEDICTION.test(lines[i].trim())) { end = i; break; }
  const body = lines.slice(0, end).filter((line, index) => !(index < 3 && GREETING.test(line.trim()))).join('\n');
  const shielded = body.slice(0, 40000).replace(ABBREVIATION, match => match.replace(/\./g, SHIELD));
  return shielded.split(/(?<=[.!?])\s+|\n+/)
    .map(sentence => sentence.replaceAll(SHIELD, '.').trim().slice(0, MAX_SENTENCE))
    .filter(sentence => /[a-z]/i.test(sentence))
    .slice(0, MAX_SENTENCES);
}

// ── What counts as asking for a response ────────────────────────────────────

/** Verbs that, addressed to the recipient, ask for something to come back to the sender. */
const RESPONSE_VERB = '(?:confirm|tell|let (?:me|us) know|send|provide|share|reply|respond|advise|email|return(?! to\\b)|suggest|propose|assign|approve|explain|clarify|answer|quote|forward|submit|sign and return|get back to (?:me|us)|contact (?:me|us)|update (?:me|us)|keep (?:me|us) (?:posted|updated|informed)|decide|indicate|specify|accept|decline|rsvp|check (?:and|then) (?:let|tell|confirm))';
// "Send …" opening a clause, "please confirm …" anywhere, and "please refund the charge and
// confirm …" — but never "we will demonstrate the plan and answer questions live", whose
// subject is the sender.
// A short lead-in ("No rush, …", "When you can, …") does not stop a clause being an instruction.
const IMPERATIVE_START = new RegExp(`^(?:[^,.;?!]{1,30},\\s*)?(?:please\\s+|kindly\\s+|also\\s+|then\\s+|just\\s+)*(${RESPONSE_VERB})\\b`, 'i');
const IMPERATIVE_PLEASE = new RegExp(`\\b(?:please|kindly)\\s+(?:also\\s+|then\\s+|just\\s+)?(${RESPONSE_VERB})\\b`, 'i');
const IMPERATIVE_CHAIN = new RegExp(`\\b(?:please|kindly)\\b[^.?!]{0,120}?\\band\\s+(?:then\\s+|also\\s+)?(${RESPONSE_VERB})\\b`, 'i');
const imperative = (clause: string) => IMPERATIVE_START.test(clause) || IMPERATIVE_PLEASE.test(clause) || IMPERATIVE_CHAIN.test(clause);
// "Choose a slot", "pick one of these times" — but never "choose a unique password".
const CHOICE = /(?:^|\bplease\s+|\band\s+)(?:choose|select|pick)\s+(?:a |an |one |the |your |between |which )?(?:preferred |best |convenient )?(?:slot|time|date|day|option|one|between|which|from|scope|release|package)\b/i;
// "Could you send …", "can you approve …" — a request whether or not it ends in "?".
const ASKED = /\b(?:could|can|would|will)\s+you\s+(?:please\s+|also\s+|kindly\s+)?(?!like\b|be (?:open|interested|keen|up)\b|care\b)([a-z]+)/i;
// "I need your comments by 2 p.m.", "Finance needs your approval by email".
const NEEDS_YOU_TO = new RegExp(`\\b(?:need|needs|would like|wants?|requires?|asked)\\s+you\\s+to\\s+(?:please\\s+)?${RESPONSE_VERB}\\b`, 'i');
const NEEDS_YOURS = /\b(?:i|we|finance|they|the team|[a-z]+)\s+(?:still\s+)?(?:need|needs|require|requires|am waiting for|are waiting for|is waiting for|await|awaits)\s+(?:your|a|the)\s+(?:written\s+|signed\s+|final\s+|emailed\s+)?(?:decision|approval|answer|response|reply|confirmation|input|comments|feedback|sign-?off|availability|go-ahead|authori[sz]ation|signature|details|acceptance|(?:signed\s+)?(?:form|document|contract)(?:\s+back)?)\b/i;
// Asking without a request verb: "I'd appreciate knowing whether Tuesday suits you", "it
// would help to have your decision", "I look forward to your answer".
const SOFT_ASK = /\b(?:i|we)(?:'d| would) (?:appreciate|be grateful for|love|like) (?:knowing|to know|to hear|your|it if you could|if you could|hearing)\b|\bit would help (?:to (?:know|have|hear)|if you could)\b|\b(?:(?:i|we) (?:look|are looking)|looking) forward to (?:your|hearing)\b|\bawaiting your\b|\bdon't forget to (?:reply|respond|send|share|confirm)\b|\bdo not hesitate to (?:reply|respond|send|share|confirm)\b/i;
// A question put to the recipient, rather than one the sender asks themself or the market.
const DIRECTED_QUESTION = /\b(?:does|would|will|could|might)\b[^?]{0,60}\b(?:work|suit)\b|\byour (?:thoughts|view|views|take|decision|answer|availability|preference|input)\b|\b(?:could|can|would|will|do|did|have|are|were|should|shall|may|might)\s+(?:you|we|i)\b|\bwould\s+[^?]{1,75}\s+be better for you\b|\b(?:is|are)\s+(?:there|anything|it|this|that|these|those)\b|^(?:also,?\s+|and\s+|so\s+)?(?:which|what|when|where|who|whom|how|any|thoughts)\b/i;
const RHETORICAL = /^(?:what are you waiting for|why wait|ready to|want to|looking for|did you know|need (?:help|a|an|more)|how about|who doesn't|what if|guess what)\b/i;
// "Would you like …", "would you be open to …": the sender offering something.
const OFFER = /\bwould you (?:like|be (?:open|interested|keen|up for)|care)\b|\b(?:interested in|want to try|care to join)\b|\bif you(?:'d| would)? (?:like|want|wish|prefer) to (?:join|try|reconnect|learn|hear|see|attend|participate|take part|sign up|get)\b/i;
// The message itself states that the recipient asked for this.
const AGREED = /\b(?:as (?:discussed|agreed|requested|promised|you asked|we discussed)|per your request|you asked (?:me|us|about|for))\b/i;
// Optional by its own wording: permission, not a request.
const PERMISSIVE = /\byou (?:can|could|may) (?:also )?(?:reply|respond|share|send|let us know|tell us|contact)\b|\bfeel free to\b|\bif you (?:have|get) (?:a (?:minute|moment|chance|second)|time|two minutes|a few minutes)\b|\boptional\b|\bno (?:obligation|pressure)\b|\bif (?:you(?:'re| are) )?interested\b/i;
const NEGATED = /\b(?:do not|don't|never|no need to|not necessary to|please don't|you don't need to|there's no need to)\s+(?!(?:forget|hesitate)\b)(?:\w+\s+){0,2}?(?:reply|respond|share|send|contact|answer|confirm)\b|\bthis (?:mailbox|address|inbox) is not monitored\b/i;
// Product, service and experience feedback someone may give, never owes.
const FEEDBACK_SOLICITATION = /\b(?:survey|questionnaire|how likely are you to recommend|rate (?:us|your experience)|we(?:'d| would) love to (?:know|hear)|help(?:s|ing)? us (?:improve|understand|make)|your feedback helps|research (?:study|session|survey)|tell us (?:what|how|about)|one thing you(?:'d| would) like us to improve)\b/i;
// A vendor asking whether you are still buying. Expected only if you asked for it.
const SALES_STATUS = /\b(?:still (?:evaluating|interested|considering|looking|exploring|in the market)|close (?:the|your|this) (?:opportunity|file|account|deal)|should (?:i|we) (?:follow up|close|stop|reach out)|is this still a priority|any (?:interest|appetite))\b/i;
const SELLING = /\b(?:we (?:now )?(?:have|offer|are offering|launched|released)|our new|a new (?:\w+ )?(?:option|package|plan|service|offering|tier)|new (?:\w+ )?(?:option|package|plan|service|offering)|pricing|discount|managed (?:\w+ )?service|reporting package|free trial)\b/i;

// ── Channel ─────────────────────────────────────────────────────────────────

const EMAIL_CUE = /\b(?:by email|via email|over email|in an email|email (?:back|me|us|your|it|them)|reply (?:with|to (?:this|me|us|the thread)|here|and tell)|respond to this|in (?:your|a) reply|send (?:me|us)|write back|this (?:email|thread))\b/i;
const MECHANISM = '(?:portal|dashboard|app|application|website|site|settings|page|form|system|tool|platform|workspace|screen|console|button|link|queue|checkout|store|account settings|billing section|event page|registration page|sign-?in (?:screen|flow)|signup (?:message|flow))';
const IN_MECHANISM = new RegExp(`\\b(?:in|on|through|via|using|from|at|within|inside)\\s+(?:the|your|our|this|that|its)\\s+(?:[\\w-]+\\s+){0,3}${MECHANISM}\\b|\\b(?:click|tap)\\b|\\buse the (?:[\\w-]+\\s+){0,2}(?:button|link|code|option|page|form)\\b|\\benter the code\\b|\\bonline\\b`, 'i');
const NAMES_MECHANISM = new RegExp(`\\b${MECHANISM}\\b`, 'i');
const POINTS_ELSEWHERE = /^(?:please\s+)?(?:use|click|tap|open|follow|visit|go to|log in|sign in)\b/i;
const VERIFY_VERB = /\b(?:confirm|verify|accept|complete|approve|activate)\b/i;

/** Where a request is to be answered: by email unless the message clearly puts it elsewhere. */
function channelOf(sentences: string[], index: number): ReplyChannel {
  const sentence = sentences[index];
  if (EMAIL_CUE.test(sentence)) return 'email';
  if (IN_MECHANISM.test(sentence)) return 'other';
  // "My timesheet is ready in the portal. Please approve it there." — resolve "there".
  if (/\bthere\b/i.test(sentence) && index > 0 && NAMES_MECHANISM.test(sentences[index - 1])) return 'other';
  // "Please confirm your address. Use the verification button in the signup message."
  if (VERIFY_VERB.test(sentence) && POINTS_ELSEWHERE.test(sentences[index + 1] || '')) return 'other';
  return 'email';
}

// ── Conditions ──────────────────────────────────────────────────────────────

// Conditions that have not happened: the reply is owed only if they do.
const INACTIVE_CONDITION = /\b(?:change|changes|changed|slip|slips|question|questions|problem|problems|issue|issues|anything else|need (?:anything|more|help|further|to)|difficult|trouble|concern|concerns|recur|recurs|reappear|reappears|again|another|incorrect|inaccurate|wrong|not (?:right|correct|accurate)|unable|can't|cannot|plans change|did not request|didn't request|don't recognize|do not recognize|delay|delayed|run into|holding (?:things|it) up|unclear|confus)/i;
// Conditions that still need an answer either way: "if none of these times work, suggest
// alternatives", "if it is disputed, tell me what needs correcting".
const ALTERNATIVE_CONDITION = /\bnone\b|\b(?:inconvenient|not convenient|easier|simpler)\b|\b(?:doesn't|does not|don't|do not|won't|will not) (?:work|suit)\b|\byou can(?:no|')t (?:make|meet|attend|do|join)\b|\bdisputed\b|\bnot (?:available|possible)\b/i;
// "Let me know if that works" means whether, not "only in case".
const WHETHER_CONDITION = /\b(?:works?|suits?|is (?:ok|okay|fine|possible|acceptable|correct|right|available)|are (?:ok|okay|fine|correct|available)|you can|you could|you(?:'re| are) able|you agree|you approve|we should|i should|you(?:'d| would) prefer)\b/i;
const DESIRE_CONDITION = /\byou(?:'d| would)? (?:like|want|wish|prefer)\b|\binterested\b|\bkeen\b/i;

type Condition = { kind: 'none' | 'inactive' | 'alternative' | 'whether' | 'desire'; text: string };

function conditionOf(sentence: string): Condition {
  const match = /\b(?:only if|if|in case|unless|should (?:the|your|that|this|anything|any))\b([^,.;?!]*)/i.exec(sentence);
  if (!match) return { kind: 'none', text: '' };
  const clause = (match[0] || '').trim();
  const text = clause.slice(0, MAX_CONDITION);
  if (DESIRE_CONDITION.test(clause)) return { kind: 'desire', text };
  if (ALTERNATIVE_CONDITION.test(clause)) return { kind: 'alternative', text };
  if (/\bonly if\b|\bin case\b|\bunless\b/i.test(clause) || INACTIVE_CONDITION.test(clause)) return { kind: 'inactive', text };
  if (WHETHER_CONDITION.test(clause)) return { kind: 'whether', text };
  // An unrecognised "if" clause at the head of the sentence still sets a precondition.
  return /^\s*if\b/i.test(sentence) ? { kind: 'inactive', text } : { kind: 'whether', text };
}

// ── Urgency and the answer's own deadline ───────────────────────────────────

const PROBLEM = /\b(?:blocked|blocking|blocks|cannot (?:sign in|access|log in|proceed|send|ship|launch|release|pay|issue)|can't (?:sign in|access|log in|proceed)|still (?:unpaid|open|missing|not|waiting|pending|have not)|is unpaid|remains? unpaid|overdue|past due|was due|is due today|not (?:yet )?(?:received|shipped|arrived|resolved)|have not received|has not (?:shipped|arrived|been)|hasn't|wrong|incorrect|duplicate|mismatch|do not match|doesn't match|do not recognize|don't recognize|withheld|error|failed|failure|at risk|(?:is|are|now|remains?|has been) paused|delayed|unanswered|follow-ups|outage|broken)\b/i;
const DEPENDENCY = /\b(?:so (?:i|we|that|finance|payroll) can|before (?:i|we) (?:can |circulate|send|proceed|finalize|book|revise|launch|ship|release|issue)|once you (?:approve|confirm|decide)|if you approve|until you|without it|as soon as|before proceeding|needs? (?:our|your)|we need to (?:choose|decide|know|confirm)|cannot \w+ until|we will have to)\b/i;
const DEADLINE_CHANGE = /\b(?:deliver|delivery|deadline|due date|submission|final version|release)\b[^.?!]{0,80}\b(?:instead of|move|moved|extend|extension|push|more days|later)\b|\b(?:move|extend|push)\b[^.?!]{0,60}\b(?:delivery|deadline|due date|submission)\b/i;
const NO_RUSH = /\bno rush\b|\bwhenever (?:you(?:'re| are)? ready|you have time|you can)\b|\bwhen you (?:have|get) (?:a )?(?:chance|time|moment)\b|\bat your convenience\b|\bno (?:immediate|urgent) (?:deadline|action)\b/i;
const NEAR_TERM = /\b(?:today|tonight|tomorrow|this (?:morning|afternoon|evening)|end of (?:the )?day|eod|asap|right away|immediately|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|before (?:monday|tuesday|wednesday|thursday|friday)|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]{0,30}\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|am|pm)|noon))/i;
const DUE_PHRASE = /\b(?:by|before|until|no later than)\s+((?:the end of |end of )?(?:today|tonight|tomorrow(?: (?:morning|afternoon|evening))?|this week|(?:this |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: (?:morning|afternoon|evening|noon))?|(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|\d{4}-\d{2}-\d{2})(?:,? at \d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|am|pm)(?: [A-Z]{2,4})?)?)/i;
const URGENT_WORDS = /\b(?:urgent|asap|immediately|important|time[- ]sensitive)\b/i;
const DAY = 86400000;

/** The answer's deadline, only when a date is attached to the request with "by" or "before". */
function responseDue(sentence: string, receivedAt: number): ExtractedDate | undefined {
  const match = DUE_PHRASE.exec(sentence);
  if (!match) return undefined;
  const phrase = match[1].replace(/\bp\.m\./gi, 'pm').replace(/\ba\.m\./gi, 'am');
  const resolved = resolveDate(phrase, receivedAt);
  return resolved.date || resolved.time ? { ...resolved, phrase: match[1] } : { phrase: match[1], ambiguous: true, reason: resolved.reason };
}

function dueWithin(due: ExtractedDate | undefined, receivedAt: number, days: number) {
  if (!due) return false;
  const at = due.time ? Date.parse(due.time) : due.date ? Date.parse(`${due.date}T23:59:59Z`) : NaN;
  return Number.isFinite(at) && at - receivedAt <= days * DAY;
}

/**
 * Prompt when the answer is wanted soon or something is waiting on it; routine otherwise.
 * "URGENT" in a subject is a sender asserting importance, not evidence of either.
 */
function urgencyOf(requests: Finding[], sentences: string[], subject: string, receivedAt: number): ReplyUrgency {
  const asked = requests.map(request => request.sentence).join(' ');
  if (NO_RUSH.test(asked)) return 'routine';
  if (requests.some(request => dueWithin(request.due, receivedAt, 14))) return 'prompt';
  const whole = `${subject.replace(URGENT_WORDS, ' ')}\n${sentences.join(' ')}`;
  if (PROBLEM.test(whole) || DEPENDENCY.test(whole) || DEADLINE_CHANGE.test(asked)) return 'prompt';
  if (NEAR_TERM.test(asked) || /\bdecision by (?:monday|tuesday|wednesday|thursday|friday|today|tomorrow)\b/i.test(subject)) return 'prompt';
  return 'routine';
}

// ── Automatic replies and impersonation ─────────────────────────────────────

const AUTO_SUBJECT = /^(?:automatic reply|auto(?:matic)?[ -]?(?:reply|response)|out of (?:the )?office|ooo\b|autoreply|away(?: from (?:the )?office)?:)/i;

function isAutomaticReply(input: ReplyInput) {
  const headers = input.headers || {};
  const submitted = (headers['auto-submitted'] || '').trim().toLowerCase();
  if (submitted && submitted !== 'no' && AUTO_SUBJECT.test(input.subject)) return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || /auto_reply/i.test(headers.precedence || '')) return true;
  return AUTO_SUBJECT.test(input.subject.trim());
}

const FINANCIAL_ASK = /\b(?:gift ?cards?|(?:process|make|send|wire|transfer|pay)\s+(?:a |the |this )?(?:vendor |urgent )?payment|payment (?:processed|handled|made) (?:on|today|now)|company card|wire transfer|bank (?:details|account|transfer)|routing number)\b/i;
const BYPASS = /\b(?:cannot use the normal|can't use the normal|outside the (?:normal|usual) (?:process|system)|(?:cannot|can't) take calls|(?:answer|reply|respond) (?:by|via) email only|email only|keep (?:this|it) (?:between us|quiet|confidential)|don't tell|do not tell|tied up|in a meeting and need)\b/i;
const PRESSURE = /\b(?:today|right now|now|asap|urgently|immediately|before my next meeting|quick favou?r|are you available\??)\b/i;
const BANK_CHANGE = /\b(?:bank|payment|remittance|wire)(?:\s+(?:account|details|instructions|information))?\s+(?:(?:has|have|is|are|was|were)\s+)?(?:changed|updated|replaced)\b|\b(?:new|updated|changed|different)\s+(?:bank|payment|remittance|wire)\s+(?:account|details|instructions|information)\b/i;
const REDIRECT_PAYMENT = /\b(?:send|make|wire|transfer|route|remit|pay|direct)\b[^.!?\n]{0,120}\b(?:payment|invoice|funds|balance)\b[^.!?\n]{0,120}\b(?:new|different|updated|changed)\s+(?:bank\s+)?(?:account|details|instructions)\b/i;
// Payroll diversion: someone asks to move *their own* pay to a new account. Worded in the
// first person on purpose, so an HR notice ("update your direct deposit in Workday") is
// not mistaken for it.
const REDIRECT_PAY=/\b(?:update|change|switch|move|redirect)\s+my\s+(?:direct deposit|payroll(?: details)?|salary|pay ?check|wages)\b/i;
const paymentRedirection=(text:string)=>BANK_CHANGE.test(text)&&(REDIRECT_PAYMENT.test(text)||REDIRECT_PAY.test(text));

/**
 * Signs of impersonation in this message alone: a pressured financial request that
 * bypasses normal checks, or an instruction to move a payment to changed bank details.
 * An external address, urgency, or a routine invoice alone proves nothing.
 */
function impersonationSigns(input: ReplyInput, userAddress: string) {
  const text = `${input.subject}\n${input.text}`;
  const signs: string[] = [];
  if (FINANCIAL_ASK.test(text)) signs.push('a payment or gift-card request');
  if (BYPASS.test(text)) signs.push('a request to skip normal verification');
  if (PRESSURE.test(text)) signs.push('time pressure');
  const userDomain = userAddress.split('@')[1]?.toLowerCase();
  const senderDomain = input.from.address.split('@')[1]?.toLowerCase();
  // A vendor's name and outside domain are ordinary mail. An email-only urgent favor
  // claiming to come from an internal team is a separate, stronger impersonation pattern.
  const claimedInternal=/\b(?:operations|finance|hr|it) team\b/i.test(text);
  const urgentBypass=claimedInternal&&!!userDomain&&!!senderDomain&&senderDomain!==userDomain
    &&BYPASS.test(text)&&PRESSURE.test(text);
  if(paymentRedirection(text))signs.push('a changed payment destination');
  return (FINANCIAL_ASK.test(text)&&BYPASS.test(text)&&PRESSURE.test(text))||urgentBypass||paymentRedirection(text)?signs:[];
}

// ── Per-request findings ────────────────────────────────────────────────────

type Kind = 'decision' | 'information' | 'scheduling' | 'deliverable';
type Finding = {
  sentence: string;
  index: number;
  kind: Kind;
  channel: ReplyChannel;
  /** required: owed; conditional: only if something happens; optional: up to the reader;
   *  offer: the sender offering something; other: addressed to somebody else; unclear. */
  standing: 'required' | 'conditional' | 'optional' | 'offer' | 'other' | 'unclear';
  /** Explicitly by email ("reply with", "email back", "send me"). */
  explicit: boolean;
  condition?: string;
  due?: ExtractedDate;
};

// Scheduling needs a meeting to schedule; a clock time alone ("by 5 p.m.") is a deadline.
const SCHEDULING = /\b(?:slot|slots|available|availability|meet|meeting|call|interview|reschedul\w*|move (?:it|our|the) (?:meeting|call|review|interview)?|join|calendar|what time|which day|time (?:that )?(?:works|suits)|suit you|(?:works?|suits?) for)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^.?!]{0,20}\b\d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|am|pm)/i;
const DECISION = /\b(?:approv\w*|decide|decision|which option|choose|choice|may i|could i|can i|which (?:\w+ )?should (?:we|i)|take this on|accept|decline|authori[sz]\w*|sign-?off|go-ahead|consider|allocate|revise|offer a|instead)\b/i;
const EMAILED_WORK = /\b(?:email back|reply with|return the signed|send (?:me |us )?(?:the |your |a |an |two |three )?(?:current |completed |final |signed |revised )?(?:draft|document|recommendation|feedback|comments|references?|contacts|screenshot|breakdown|quote|file|files|report|names|analysis|details|number|time|update))\b/i;
const DELIVERABLE = /\b(?:send|return|email back|reply with|submit|forward|feedback|comments|review|draft|references?|signed|assignment|recommendation|document|screenshot|contacts|details|breakdown|quote|names)\b/i;

function kindOf(sentence: string): Kind {
  if (/\b(?:which|what) (?:option|scope)\b|\bmay i\b|\bcould i\b|\bcan i\b/i.test(sentence)) return 'decision';
  if (EMAILED_WORK.test(sentence)) return 'deliverable';
  if (SCHEDULING.test(sentence)) return 'scheduling';
  if (DECISION.test(sentence)) return 'decision';
  if (DELIVERABLE.test(sentence)) return 'deliverable';
  return 'information';
}

const VOCATIVE = /^([A-Z][a-z]+),\s+/;
const NOT_NAMES = new Set(['hi', 'hello', 'hey', 'thanks', 'also', 'please', 'yes', 'no', 'so', 'well', 'sorry', 'unfortunately', 'however', 'otherwise',
  'meanwhile', 'finally', 'first', 'second', 'next', 'again', 'today', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'ok', 'okay', 'great', 'sure', 'instead', 'separately']);

function userNames(input: ReplyInput, userAddress: string) {
  const names = new Set<string>();
  const local = userAddress.split('@')[0]?.toLowerCase();
  if (local) for (const part of local.split(/[._+-]/)) if (part.length > 1) names.add(part);
  for (const party of [...(input.to || []), ...(input.cc || [])])
    if (party.address?.toLowerCase() === userAddress.toLowerCase())
      for (const part of (party.name || '').toLowerCase().split(/\s+/)) if (part.length > 1) names.add(part);
  return names;
}

/** A sentence's coordinated clauses: ", or reply if …" and "; let me know …" stand alone. */
function clausesOf(sentence: string): string[] {
  const parts = sentence.split(/,\s*(?=(?:or|and|but)\s+(?:reply|let|tell|contact|email|send|confirm|call|if)\b)|;\s+/i);
  return parts.map(part => part.replace(/^(?:or|and|but)\s+/i, '').trim()).filter(Boolean);
}

function analyze(input: ReplyInput, userAddress: string, sentences: string[]): Finding[] {
  const findings: Finding[] = [];
  const mine = userNames(input, userAddress);
  const others = new Set([...(input.to || []), ...(input.cc || [])]
    .filter(party => party.address?.toLowerCase() !== userAddress)
    .map(party => (party.name || party.address.split('@')[0]).split(/[\s._-]+/)[0].toLowerCase()).filter(Boolean));
  const feedbackInvite = FEEDBACK_SOLICITATION.test(`${input.subject}\n${input.text}`);
  const groupPost = inForumsTab(input.labels);
  const purpose = assessPurpose({ subject: input.subject, text: input.text, from: input.from, labels: input.labels, distribution: input.distribution });
  for (const [index, sentence] of sentences.entries()) {
    if (isCampaignFooter(sentence) || NEGATED.test(sentence)) continue;
    // "Please return the signed acceptance by October 9, or reply if you need to discuss
    // the terms": two requests, and the condition belongs only to the second.
    for (const clause of clausesOf(sentence)) {
    const question = /\?\s*$/.test(sentence);
    const condition = conditionOf(clause);
    // The request is judged on the main clause, never on the condition attached to it.
    const main = (condition.kind === 'none' ? clause : clause.replace(condition.text, ' ')).replace(/^[\s,]+/, '');
    const asked = ASKED.exec(main);
    const requested = imperative(main) || CHOICE.test(main) || NEEDS_YOURS.test(main) || NEEDS_YOU_TO.test(main) || SOFT_ASK.test(main)
      || (!!asked && !/^(?:like|be|care|believe|imagine)$/i.test(asked[1]));
    const directedQuestion = question && DIRECTED_QUESTION.test(main) && !RHETORICAL.test(sentence.trim());
    const offer = OFFER.test(clause) || (condition.kind === 'desire' && /\b(?:reply|respond|tell us|let us know|send)\b/i.test(clause));
    // "Priya, could you send Sam the list?" speaks to Priya. Only a name belonging to another
    // recipient of this message counts, so an opening adverb is never mistaken for one.
    const vocative = VOCATIVE.exec(sentence)?.[1]?.toLowerCase();
    // Gmail files mailing-list and group discussion under Forums. A question there is put
    // to the whole group, so it is the recipient's only when it names them.
    const addressedElsewhere = (!!vocative && !NOT_NAMES.has(vocative) && !mine.has(vocative) && others.has(vocative))
      || (groupPost && !(!!vocative && mine.has(vocative)));
    if (!requested && !directedQuestion && !offer) continue;
    let standing: Finding['standing'] = 'required';
    if (addressedElsewhere) standing = 'other';
    else if (offer) standing = 'offer';
    else if (PERMISSIVE.test(clause) || (feedbackInvite && (FEEDBACK_SOLICITATION.test(clause) || /\b(?:feedback|suggestions?|improve|recommend|experience|survey|opinion|thoughts)\b/i.test(clause)))) standing = 'optional';
    else if (purpose.promotion !== 'absent' && isCommercialSentence(sentence)) standing = 'optional';
    else if (purpose.promotion === 'clear' && commercialFamiliesIn(sentence).length) standing = 'optional';
    else if (condition.kind === 'inactive') standing = 'conditional';
    else if (condition.kind === 'desire') standing = 'offer';
    findings.push({
      sentence, index, kind: kindOf(main), channel: channelOf(sentences, index), standing,
      explicit: EMAIL_CUE.test(clause) || /\b(?:email back|reply with|return the signed|send (?:me|us|your|the|two|a|an))\b/i.test(clause),
      condition: standing === 'conditional' ? condition.text : undefined,
      due: responseDue(clause, input.receivedAt) ?? responseDue(sentence, input.receivedAt),
    });
    }
  }
  return findings;
}

/** An introduction that hands the recipient an agreed next step: "she needs our sandbox instructions". */
function handoff(input: ReplyInput, sentences: string[]): string | undefined {
  const text = sentences.join(' ');
  if (!/\b(?:introduc(?:e|ing) you to|connecting you (?:with|to)|meet (?:my|our) (?:colleague|contact)|looping in)\b/i.test(text)) return undefined;
  return sentences.find(sentence => /\b(?:needs|is waiting for|has asked for|would like)\s+(?:our|your)\b/i.test(sentence));
}

// ── Explanations ────────────────────────────────────────────────────────────

function senderName(input: ReplyInput) {
  const name = (input.from.name || '').trim();
  const first = name.split(/\s+/)[0] || '';
  // Team and system senders ("Beacon Analytics", "TeamChat Notifications") are named as such.
  if (!first || /\b(?:team|notifications?|billing|security|accounts?|legal|events|research|support|editorial|no-?reply)\b/i.test(name)) return 'The sender';
  return first;
}

function explain(reason: ReplyReason, input: ReplyInput, finding?: Finding, extra = ''): string {
  const who = senderName(input);
  const approval = finding && /\bapprov\w*\b/i.test(finding.sentence);
  switch (reason) {
    case 'decision_requested': return approval ? `${who} is waiting for your approval.` : `${who} needs your decision.`;
    case 'information_requested': return `${who} is waiting for an answer from you.`;
    case 'scheduling_answer_requested': return `${who} needs your availability or a time that works.`;
    case 'emailed_deliverable': return `${who} asked you to send something back by email.`;
    case 'assigned_communication': return `${who} handed you a follow-up to send.`;
    case 'action_in_other_channel': return extra.startsWith('This ') ? extra : `This is done ${extra || 'outside email'}; no email answer is requested.`;
    case 'acknowledgment_only': return `${who} is confirming something; nothing is asked of you.`;
    case 'waiting_for_sender': return `${who} will contact you next.`;
    case 'conditional_reply_inactive': return `Reply only ${(extra || 'if something changes').replace(/^If\b/, 'if')}.`;
    case 'optional_engagement': return 'This invitation is optional; a reply is not expected.';
    case 'automatic_response': return 'This is an automatic reply; no answer is expected.';
    case 'suspicious_request': return `This shows signs of impersonation (${extra}). Don't reply; check with the person through a contact you already know.`;
    case 'insufficient_context': return extra || 'It is not clear whether this follow-up was expected.';
    case 'already_answered': return 'This request has been dealt with.';
    default: return 'Nothing in this message asks you for an answer.';
  }
}

function whereElsewhere(sentence: string, previous = '') {
  const match = new RegExp(`\\b${MECHANISM}\\b`, 'i').exec(sentence) || new RegExp(`\\b${MECHANISM}\\b`, 'i').exec(previous);
  if (!match) return 'outside email';
  const noun = match[0].toLowerCase();
  const qualifier = new RegExp(`(\\b[\\w-]+(?:\\s[\\w-]+)?)\\s+${noun.replace(/[-]/g, '\\-')}\\b`, 'i').exec(`${previous} ${sentence}`)?.[1]?.toLowerCase();
  const descriptive = qualifier && !/^(?:the|your|our|this|that|its|in|on|via|through|using|from|at)$/.test(qualifier.split(' ').at(-1)!);
  return `in the ${descriptive ? `${qualifier!.split(' ').at(-1)} ` : ''}${noun}`;
}

// An instruction to do something that is not an answer: attend, bring, review, register.
const ACTION_ONLY = /^(?:please\s+|kindly\s+)?(?:arrive|bring|review|complete|register|attend|enter|use|open|update|enable|customize|follow|keep|read|save|reserve|join|check|visit|go to|sign in|log in|download|install|finish|approve|reset|change|set up|configure|invite|add|start|try)\b/i;
const ACKNOWLEDGED = /\b(?:thanks? (?:you )?for|received|have saved|saved (?:both|it|them)|confirmed|is confirmed|resolved|has been (?:approved|processed|removed|completed|received)|was successful|is complete|are complete|completed|no (?:further )?(?:action|changes|tasks|blockers|decisions) (?:is |are |were )?(?:required|needed|remain)|nothing (?:else )?(?:is )?needed|i appreciate|thank you for)\b/i;
const SENDER_NEXT = /\b(?:we|i)(?:'ll| will| shall) (?:contact|email|reach out to|get back to|be in touch|update|let) you\b|\bwill (?:contact|email|notify) you\b|\bwe will share\b|\bwill respond to (?:other )?messages\b|\bwhen (?:access opens|there is an update|places become available)\b/i;

// ── The assessment ──────────────────────────────────────────────────────────

export type ReplyOptions = { userAddress?: string; context?: RecipientContext };

const fromRules = (status: ReplyStatus, reasonCode: ReplyReason, input: ReplyInput, parts: Partial<ReplyAssessment> & { finding?: Finding; extra?: string } = {}): ReplyAssessment => {
  const { finding, extra, ...rest } = parts;
  return {
    status, reasonCode, urgency: 'unknown', channel: status === 'required' ? 'email' : 'none',
    evidence: clip(finding?.sentence ?? rest.evidence ?? '', MAX_EVIDENCE),
    explanation: clip(explain(reasonCode, input, finding, extra), MAX_EXPLANATION),
    source: 'rules', ...rest,
  };
};

const REASON_FOR: Record<Kind, ReplyReason> = {
  decision: 'decision_requested', information: 'information_requested',
  scheduling: 'scheduling_answer_requested', deliverable: 'emailed_deliverable',
};

/**
 * The reply decision for one message. `userAddress` identifies the recipient; `context`
 * carries trusted facts about the relationship when they exist (see RecipientContext).
 */
export function assessReply(input: ReplyInput, options: ReplyOptions = {}): ReplyAssessment {
  // Patterns read typographic apostrophes as plain ones; the evidence quotes the message as
  // written, so it still matches the sentence a task or a correction refers to.
  const originals = replySentences(input.text || '');
  const sentences = originals.map(sentence => sentence.replace(/[’‘]/g, "'"));
  const result = decide({ ...input, text: (input.text || '').replace(/[’‘]/g, "'") }, options, sentences);
  const at = sentences.findIndex(sentence => clip(sentence, MAX_EVIDENCE) === result.evidence);
  return at < 0 ? result : { ...result, evidence: clip(originals[at], MAX_EVIDENCE) };
}

function decide(input: ReplyInput, options: ReplyOptions, sentences: string[]): ReplyAssessment {
  const userAddress = (options.userAddress || '').toLowerCase();

  if (isAutomaticReply(input)) {
    const elsewhere = sentences.find(sentence => /\b(?:contact|reach|email)\b[^.?!]*@/.test(sentence));
    return fromRules('not_required', 'automatic_response', input, { evidence: input.subject,
      explanation: elsewhere ? 'This is an automatic reply. If your matter is urgent, use the alternate contact it names.' : undefined });
  }
  const suspicious = impersonationSigns(input, userAddress);
  if (suspicious.length) return fromRules('not_required', 'suspicious_request', input, {
    evidence: sentences.find(sentence => FINANCIAL_ASK.test(sentence) || BYPASS.test(sentence)) || input.subject,
    extra: suspicious.slice(0, 3).join(', ') });

  const findings = analyze(input, userAddress, sentences);
  const onlyCopied = !!userAddress
    && !(input.to || []).some(party => party.address?.toLowerCase() === userAddress)
    && (input.cc || []).some(party => party.address?.toLowerCase() === userAddress);
  const salesFollowUp = SELLING.test(input.text || '') || assessPurpose({ subject: input.subject, text: input.text, from: input.from, labels: input.labels, distribution: input.distribution }).families.length > 0;
  const solicited = options.context?.solicited;

  const owed: Finding[] = [];
  const unclear: Finding[] = [];
  for (const finding of findings) {
    if (finding.standing === 'offer') {
      // An offer is owed an answer only when the recipient asked for it — stated in the
      // message ("as discussed") or known from trusted context.
      if (solicited === true || (solicited !== false && AGREED.test(input.text || ''))) owed.push(finding);
      continue;
    }
    if (finding.standing !== 'required') continue;
    if (finding.channel === 'other') continue;
    if (SALES_STATUS.test(finding.sentence) && salesFollowUp) {
      if (solicited === true) owed.push(finding);
      else if (solicited !== false) unclear.push(finding);
      continue;
    }
    if (onlyCopied) { unclear.push(finding); continue; }
    owed.push(finding);
  }
  const passed = handoff(input, sentences);

  if (owed.length || passed) {
    // The strongest request names the reason: an explicit emailed deliverable, then a
    // decision, then scheduling, then information.
    const rank = (finding: Finding) => (finding.explicit ? 0 : 1) * 10 + ['deliverable', 'decision', 'scheduling', 'information'].indexOf(finding.kind);
    const lead = [...owed].sort((a, b) => rank(a) - rank(b) || a.index - b.index)[0];
    const due = owed.map(finding => finding.due).find(value => value && (value.date || value.time));
    const urgency = urgencyOf(owed.length ? owed : [{ sentence: passed!, index: 0, kind: 'information', channel: 'email', standing: 'required', explicit: false }], sentences, input.subject, input.receivedAt);
    if (!lead) return fromRules('required', 'assigned_communication', input, { evidence: passed, urgency });
    return fromRules('required', REASON_FOR[lead.kind], input, { finding: lead, urgency, due });
  }

  if (unclear.length) {
    const lead = unclear[0];
    return fromRules('uncertain', 'insufficient_context', input, { finding: lead, channel: 'unknown',
      extra: onlyCopied && !SALES_STATUS.test(lead.sentence)
        ? 'You were copied on this request; it is not clear that the answer is yours to give.'
        : 'A vendor is following up on an earlier evaluation; whether you expected this follow-up is not known.' });
  }

  // Nothing owed. Say why, from the most specific evidence available.
  const elsewhere = findings.find(finding => finding.standing === 'required' && finding.channel === 'other')
    || sentences.map((sentence, index) => ({ sentence, index })).find(({ sentence }) => IN_MECHANISM.test(sentence) && ACTION_ONLY.test(sentence));
  const conditional = findings.find(finding => finding.standing === 'conditional');
  const optional = findings.find(finding => finding.standing === 'optional' || finding.standing === 'offer')
    || (FEEDBACK_SOLICITATION.test(input.text || '') ? { sentence: sentences.find(s => FEEDBACK_SOLICITATION.test(s)) || '' } : undefined);
  if (elsewhere && 'index' in elsewhere && findings.some(finding => finding.channel === 'other' && finding.standing === 'required'))
    return fromRules('not_required', 'action_in_other_channel', input, { evidence: elsewhere.sentence, channel: 'other',
      extra: whereElsewhere(elsewhere.sentence, sentences[elsewhere.index - 1]) });
  if (conditional) return fromRules('not_required', 'conditional_reply_inactive', input, { finding: conditional,
    condition: conditional.condition, extra: conditional.condition?.replace(/^only\s+/i, '') });
  if (optional) return fromRules('not_required', 'optional_engagement', input, { evidence: optional.sentence });
  if (elsewhere) return fromRules('not_required', 'action_in_other_channel', input, { evidence: elsewhere.sentence, channel: 'other',
    extra: whereElsewhere(elsewhere.sentence, 'index' in elsewhere ? sentences[elsewhere.index - 1] : '') });
  if (securityEvidence(`${input.subject}\n${input.text}`)) return fromRules('not_required', 'action_in_other_channel', input, {
    evidence: securityEvidence(`${input.subject}\n${input.text}`) || '', channel: 'other',
    extra: 'This is an account notice. Check it in the service itself; replying to the email does not secure the account.' });
  const action = sentences.find(sentence => ACTION_ONLY.test(sentence));
  if (action) return fromRules('not_required', 'action_in_other_channel', input, { evidence: action, channel: 'other',
    extra: `This asks you to ${clip(action.replace(/^please\s+/i, '').replace(/[.!]+$/, ''), 70).replace(/^\w/, c => c.toLowerCase())}, not to answer by email.` });
  const next = sentences.find(sentence => SENDER_NEXT.test(sentence));
  if (next) return fromRules('not_required', 'waiting_for_sender', input, { evidence: next });
  const acknowledged = sentences.find(sentence => ACKNOWLEDGED.test(sentence));
  if (acknowledged) return fromRules('not_required', 'acknowledgment_only', input, { evidence: acknowledged });
  return fromRules('not_required', 'no_request', input, { evidence: '' });
}

// ── Reconciling a model's answer ────────────────────────────────────────────

/** How a single cited sentence stands on its own, when that alone rules out an email answer. */
function standingOf(sentence: string): { reason: ReplyReason; condition?: string } | undefined {
  const text = sentence.replace(/[’‘]/g, "'");
  if (EMAIL_CUE.test(text)) return undefined;
  const condition = conditionOf(text);
  if (condition.kind === 'inactive') return { reason: 'conditional_reply_inactive', condition: condition.text };
  if (condition.kind === 'desire' || OFFER.test(text) || PERMISSIVE.test(text)) return { reason: 'optional_engagement' };
  if (IN_MECHANISM.test(text)) return { reason: 'action_in_other_channel' };
  // "Please arrive at 9:30 and bring your ID": an instruction that asks for nothing back.
  const asksBack = imperative(text) || NEEDS_YOU_TO.test(text) || NEEDS_YOURS.test(text) || SOFT_ASK.test(text)
    || ASKED.test(text) || (/\?\s*$/.test(text) && DIRECTED_QUESTION.test(text));
  if (!asksBack && ACTION_ONLY.test(text)) return { reason: 'action_in_other_channel' };
  return undefined;
}

/** Local facts used to check a model's reply assessment against the message. */
export type ReplyEvidenceCheck = {
  /** The quote appears in this message's own subject or body. */
  inCurrentMessage: (quote: string) => boolean;
  /** The quote appears anywhere the model was shown (body, quoted history, signature). */
  supported: (quote: string) => boolean;
  /** The quote is a campaign footer or sales copy rather than a request. */
  promotional: (quote: string) => boolean;
  /** The quote belongs to a task the model itself assigned to somebody else. */
  ownedByOthers: (quote: string) => boolean;
};

const DECISIVE_LOCAL: readonly ReplyReason[] = ['automatic_response', 'suspicious_request'];
const sameSentence = (a: string, b: string) => {
  const left = a.toLowerCase().replace(/\s+/g, ' ').trim(), right = b.toLowerCase().replace(/\s+/g, ' ').trim();
  return !!left && !!right && (left.includes(right) || right.includes(left));
};

/**
 * One reply decision from the model's answer and the rules' reading of the same message.
 *
 * The model is kept where it sees what the rules cannot: a request phrased in a way no
 * pattern here knows. The rules win where the message settles the matter: an automatic
 * reply, an impersonation pattern, an approval the message says happens in a portal, a reply
 * that is only conditional, an optional invitation. Where neither can settle it, the result
 * is "uncertain" and goes to review — it is never shown as a confident "no reply needed".
 */
export function reconcileReply(model: ReplyAssessment | undefined, modelRequired: boolean, local: ReplyAssessment,
  check: ReplyEvidenceCheck, fallbackEvidence = ''): ReplyAssessment {
  const reconciled = (value: ReplyAssessment): ReplyAssessment => ({ ...value, source: 'reconciled' });
  if (DECISIVE_LOCAL.includes(local.reasonCode)) return local;
  const claim: ReplyAssessment = model ?? {
    status: modelRequired ? 'required' : 'not_required', urgency: 'unknown', channel: modelRequired ? 'email' : 'none',
    reasonCode: modelRequired ? 'information_requested' : 'no_request', evidence: fallbackEvidence,
    explanation: modelRequired ? 'The message asks you for a response.' : '', source: 'model',
  };

  // A model may recognize a payment-redirection or verification-bypass scam that
  // the local request parser still reads as "confirm by email". Require a supported
  // current-message quote and concrete scam signals, so a routine invoice request
  // cannot be suppressed just because the model called it suspicious.
  if(claim.reasonCode==='suspicious_request'&&claim.evidence&&check.inCurrentMessage(claim.evidence)
    &&(paymentRedirection(claim.evidence)||FINANCIAL_ASK.test(claim.evidence)&&BYPASS.test(claim.evidence)))
    return reconciled({...claim,status:'not_required',channel:'none',evidence:clip(claim.evidence,MAX_EVIDENCE)});

  if (claim.status === 'required') {
    const evidence = claim.evidence || (local.status === 'required' ? local.evidence : fallbackEvidence);
    if (claim.channel === 'other')
      return reconciled({ ...local.status === 'required' ? local : { ...local, status: 'not_required', reasonCode: 'action_in_other_channel',
        channel: 'other', explanation: 'This is done outside email; no email answer is requested.' }, evidence: local.evidence || claim.evidence });
    if (claim.reasonCode === 'optional_engagement')
      return reconciled({ ...local, status: local.status === 'required' ? 'required' : 'not_required' });
    if (!evidence) return local.status === 'required' ? local : reconciled({ ...local, status: 'uncertain', reasonCode: 'insufficient_context',
      channel: 'unknown', explanation: 'The analysis said a reply is needed but did not show where the message asks for one.' });
    if (!check.inCurrentMessage(evidence))
      return local.status === 'required' ? local : reconciled({ ...local, status: 'uncertain', reasonCode: 'insufficient_context',
        channel: 'unknown', evidence: clip(evidence, MAX_EVIDENCE),
        explanation: check.supported(evidence) ? 'The request appears only in quoted earlier mail; check whether it still stands.'
          : 'The analysis cited text that is not in this message.' });
    if (check.promotional(evidence) && local.status !== 'required')
      return reconciled({ ...local, status: 'not_required', reasonCode: 'optional_engagement',
        explanation: explain('optional_engagement', { subject: '', text: '', from: { address: '' }, receivedAt: 0 }) });
    if (check.ownedByOthers(evidence) && local.status !== 'required')
      return reconciled({ ...local, status: 'uncertain', reasonCode: 'insufficient_context', channel: 'unknown',
        evidence: clip(evidence, MAX_EVIDENCE), explanation: 'The request may be meant for someone else.' });
    // The rules saw this very sentence and found it answered elsewhere, conditional or optional.
    if (local.status === 'not_required' && sameSentence(local.evidence, evidence)
      && ['action_in_other_channel', 'conditional_reply_inactive', 'optional_engagement'].includes(local.reasonCode)) return reconciled(local);
    // Or the cited sentence settles it on its own: "please contact me if your plans change".
    const own = local.status === 'required' ? undefined : standingOf(evidence);
    if (own) return reconciled({ ...local, status: 'not_required', reasonCode: own.reason, channel: own.reason === 'action_in_other_channel' ? 'other' : 'none',
      evidence: clip(evidence, MAX_EVIDENCE), condition: own.condition,
      explanation: own.reason === 'conditional_reply_inactive' ? `Reply only ${(own.condition || 'if something changes').replace(/^only\s+/i, '').replace(/^If\b/, 'if')}.`
        : own.reason === 'optional_engagement' ? 'This invitation is optional; a reply is not expected.' : 'This is done outside email; no email answer is requested.' });
    const urgency = claim.urgency === 'prompt' && local.urgency !== 'prompt' && local.status === 'required' ? local.urgency : claim.urgency;
    return reconciled({ ...claim, status: 'required', channel: 'email', evidence: clip(evidence, MAX_EVIDENCE),
      urgency: urgency === 'unknown' && local.status === 'required' ? local.urgency : urgency,
      due: claim.due ?? (local.status === 'required' ? local.due : undefined),
      explanation: clip(claim.explanation || (local.status === 'required' ? local.explanation : 'The message asks you for a response.'), MAX_EXPLANATION) });
  }

  // The model says no reply (or is unsure). An explicit request for an emailed answer
  // overrules a bare "no"; any other disagreement is left for review.
  if (local.status === 'required') {
    const explicit = local.reasonCode === 'emailed_deliverable'
      || /\b(?:reply with|email back|by email|send (?:me|us)|return the signed|please (?:send|provide|confirm|reply|tell))\b/i.test(local.evidence);
    if (explicit) return reconciled(local);
    return reconciled({ ...local, status: 'uncertain', reasonCode: 'insufficient_context', channel: 'unknown',
      explanation: 'This may need an answer: the message asks a question, but the analysis judged otherwise.' });
  }
  if (claim.status === 'uncertain') return reconciled({ ...claim, explanation: clip(claim.explanation || 'Whether a reply is needed is unclear.', MAX_EXPLANATION) });
  return local.reasonCode !== 'no_request' ? local : reconciled({ ...local, ...model ? { reasonCode: claim.reasonCode, evidence: claim.evidence, explanation: claim.explanation || local.explanation } : {} });
}
