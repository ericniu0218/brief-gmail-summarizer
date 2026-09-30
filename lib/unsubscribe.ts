/**
 * The vocabulary of unsubscribing.
 *
 * Two questions are asked separately, because they have separate answers and conflating
 * them is what lets an interface claim more than it knows:
 *
 *   - **Capability** — what this app can do with the selected message, right now.
 *   - **Outcome** — what happened when it tried.
 *
 * A message can be fully supported and never have been submitted; a request can be accepted
 * while the app has no idea whether the sender will act on it. Neither value is ever derived
 * from the other, and no successful response from this app's own API is treated as proof
 * that an external service unsubscribed anybody.
 *
 * Every value that arrives from the database or the network passes through the readers
 * below, so a row written by an older version, or a hand-edited one, degrades to a safe
 * value instead of reaching the interface as an unknown string.
 */

/** What the app can do with the selected message. */
export type UnsubscribeCapability =
  /** A supported one-click endpoint that passed destination checks. */
  | 'one-click'
  /** A link the person can open and finish themselves. */
  | 'manual-page'
  /** The sender asks to be emailed; this version does not send that mail. */
  | 'email-required'
  /** The message carries no usable unsubscribe instructions. */
  | 'none'
  /** Instructions exist, but the destination could not be verified as safe. */
  | 'unverified'
  /** The message could not be read, or the account needs reconnecting. */
  | 'unavailable';

/** What happened when the app tried. */
export type UnsubscribeOutcome =
  /** Nothing has been submitted for this message. */
  | 'none'
  /** A request is in flight. */
  | 'pending'
  /** The newsletter service accepted the request. It is not a promise that it acts on it. */
  | 'accepted'
  /** The service needs the person to finish somewhere else. */
  | 'action-required'
  /** The service refused, definitely and finally. */
  | 'failed'
  /** The request may or may not have arrived — a timeout, or a broken connection. */
  | 'unknown';

const CAPABILITIES: readonly UnsubscribeCapability[] =
  ['one-click', 'manual-page', 'email-required', 'none', 'unverified', 'unavailable'];
const OUTCOMES: readonly UnsubscribeOutcome[] =
  ['none', 'pending', 'accepted', 'action-required', 'failed', 'unknown'];

/** A stored or received capability, or `undefined` when the value is not one we know. */
export function asCapability(value: unknown): UnsubscribeCapability | undefined {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)
    ? value as UnsubscribeCapability : undefined;
}

/** A stored or received outcome, or `undefined` when the value is not one we know. */
export function asOutcome(value: unknown): UnsubscribeOutcome | undefined {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value)
    ? value as UnsubscribeOutcome : undefined;
}

/** Only these can be acted on without the person leaving the app. */
export function isAutomatic(capability: UnsubscribeCapability) {
  return capability === 'one-click';
}

/**
 * How narrowly a request can be attributed.
 *
 * `list` means the message named a List-ID, which identifies one newsletter. `message`
 * means it did not, so the record stays tied to the message it was made from rather than
 * claiming to cover everything the sender sends. `legacy-sender` exists only for rows
 * imported from the old sender-wide table; nothing creates it any more.
 */
export type UnsubscribeScope = 'list' | 'message' | 'legacy-sender';

export type NewsletterIdentity =
  | { scope: 'list'; listId: string; messageId: string }
  | { scope: 'message'; listId: undefined; messageId: string };

/** Upper bound on a stored List-ID, so a hostile header cannot become an unbounded key. */
const MAX_LIST_ID = 255;

/**
 * The newsletter a message belongs to, from its List-ID.
 *
 * RFC 2919 puts the identity inside angle brackets, usually after a human-readable phrase:
 * `Weekly Roundup <weekly.list.example.com>`. The bracketed part is the identity; the
 * phrase is decoration and is discarded. A value with no brackets is accepted as a whole
 * when it looks like a bare identifier, because senders do emit that.
 *
 * A List-ID identifies one list. It does **not** prove the publisher's unsubscribe endpoint
 * affects only that list, so callers must not describe the scope as certain.
 */
export function listIdOf(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  if (!value || value.length > MAX_LIST_ID * 4) return undefined;
  const bracketed = value.match(/<([^<>]+)>/);
  const identity = (bracketed ? bracketed[1] : value).trim().toLowerCase();
  // A bare value is only believable as an identity if it has no spaces or quotes; anything
  // else is a display phrase with no bracketed identity, which identifies nothing.
  if (!identity || identity.length > MAX_LIST_ID) return undefined;
  if (!bracketed && !/^[a-z0-9._~:@+-]+$/.test(identity)) return undefined;
  return identity;
}

/** The identity to record a request against, preferring the newsletter over the message. */
export function newsletterIdentity(messageId: string, listHeader?: string): NewsletterIdentity {
  const listId = listIdOf(listHeader);
  return listId ? { scope: 'list', listId, messageId } : { scope: 'message', listId: undefined, messageId };
}

/**
 * The stored key for one request.
 *
 * Two newsletters from one publisher have different List-IDs and therefore different keys,
 * so they are never merged. Where no List-ID exists the key is the message's, which keeps
 * unrelated newsletters apart at the cost of not recognising a repeat request for the same
 * list — the safe direction, since merging unrelated lists would silently claim a request
 * covered mail it never touched.
 */
export function requestKey(accountId: string, identity: NewsletterIdentity) {
  return identity.scope === 'list'
    ? `${accountId}:list:${identity.listId}`
    : `${accountId}:message:${identity.messageId}`;
}

/**
 * How honestly to describe what a request covers. Never states that one newsletter alone is
 * affected, because the publisher's own subscription scope is not knowable from here.
 */
export function scopeDescription(scope: UnsubscribeScope): string {
  if (scope === 'list') return 'This request names the newsletter this message belongs to. The sender decides which of its lists that covers.';
  if (scope === 'message') return 'This message names no newsletter id, so the request is recorded against this message. The sender decides what it covers.';
  return 'Imported from an older version, which recorded only the sender address. What it covered was not recorded.';
}

/**
 * A List-Unsubscribe header, read defensively.
 *
 * Senders emit this header in every shape the specification allows and several it does
 * not. Handled here: mixed capitalisation (the caller lower-cases names), folded
 * continuation lines, runs of whitespace inside and between entries, several methods in one
 * header, a header repeated, and values long enough to be an attack rather than an address.
 *
 * Nothing is inferred. A value that cannot be read yields no method, and the caller falls
 * back to the manual path instead of guessing a destination from the sender's domain.
 */

/** Longest header value worth reading. Beyond this the value is treated as unusable. */
const MAX_HEADER = 2048;
/** Longest single method. Real unsubscribe links carry tokens, so this is generous. */
const MAX_METHOD = 1024;

export type ListUnsubscribe = {
  https: string[];
  mailto: string[];
  /** True when repeated headers offered different methods, so none of them can be trusted. */
  conflicting: boolean;
  /** True when a header was present but nothing usable could be read from it. */
  malformed: boolean;
};

/** Unfold continuation lines and collapse whitespace, per RFC 5322 header folding. */
function unfold(value: string) {
  return value.replace(/\r?\n[ \t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function methodsOf(value: string) {
  // Only bracketed entries count. A bare URL in this header is not the documented form, and
  // accepting one would mean reading an unbracketed display string as a destination.
  return Array.from(value.matchAll(/<([^<>]*)>/g), match => match[1].trim())
    .filter(method => method && method.length <= MAX_METHOD);
}

export function parseListUnsubscribe(values: readonly string[] | string | undefined): ListUnsubscribe {
  const raw = (typeof values === 'string' ? [values] : values || [])
    .filter((value): value is string => typeof value === 'string');
  const empty: ListUnsubscribe = { https: [], mailto: [], conflicting: false, malformed: false };
  if (!raw.length) return empty;

  const perHeader = raw.map(value => {
    const text = unfold(value);
    if (!text || text.length > MAX_HEADER) return { https: [], mailto: [], unusable: true };
    const found = methodsOf(text);
    return {
      https: found.filter(method => /^https:\/\//i.test(method)).map(method=>{
        try{return new URL(method).href;}catch{return method;}
      }),
      mailto: found.filter(method => /^mailto:/i.test(method)),
      unusable: found.length === 0,
    };
  });

  const signature = (entry: { https: string[]; mailto: string[] }) =>
    JSON.stringify([entry.https, entry.mailto]);
  // Two headers offering the same methods are a harmless duplicate. Two offering different
  // ones mean the app cannot tell which the sender meant, and picking either could send a
  // request somewhere the sender did not intend.
  const conflicting = perHeader.length > 1
    && new Set(perHeader.map(signature)).size > 1;
  if (conflicting) return { https: [], mailto: [], conflicting: true, malformed: false };

  const first = perHeader[0];
  return {
    https: first.https, mailto: first.mailto, conflicting: false,
    malformed: first.unusable,
  };
}

/**
 * Whether one-click may be trusted for this message.
 *
 * RFC 8058 only allows an automatic POST when the `List-Unsubscribe` and
 * `List-Unsubscribe-Post` headers are covered by a passing DKIM signature. A header that
 * merely *claims* authentication passed proves nothing — anyone can add one — so two
 * independent things are required:
 *
 *   1. The receiving server's own `Authentication-Results` reports `dkim=pass`. Only the
 *      first such header is read, because that is the one the delivering server prepends;
 *      later ones travelled with the message and are attacker-controlled.
 *   2. A `DKIM-Signature` from that same domain lists both headers in its `h=` tag, which
 *      is what puts them under the signature rather than beside it.
 *
 * When either is missing the message is not treated as automatic. The link is still offered
 * for the person to open themselves.
 */
export function oneClickAuthenticated(
  headerValues: Record<string, string[] | undefined> | undefined,
  headers: Record<string, string> | undefined,
): boolean {
  const list = (name: string) =>
    headerValues?.[name] || (headers?.[name] ? [headers[name]!] : []);
  const results = list('authentication-results')[0];
  if (!results) return false;
  // Comments and quoted reasons are prose, not authentication results. Strip them
  // before splitting methods so an injected "dkim=pass" cannot become evidence.
  let clean='',depth=0,quoted=false,escaped=false;
  for(const char of unfold(results)){
    if(escaped){escaped=false;continue;}
    if(char==='\\'){escaped=true;continue;}
    if(!depth&&char==='"'){quoted=!quoted;clean+=' ';continue;}
    if(quoted)continue;
    if(char==='('){depth++;clean+=' ';continue;}
    if(char===')'){if(!depth)return false;depth--;continue;}
    if(!depth)clean+=char;
  }
  if(depth||quoted||escaped)return false;
  const signatures=list('dkim-signature').map(value=>{
    const tags=new Map<string,string>();
    for(const part of unfold(value).split(';')){
      const match=/^\s*([a-z]+)\s*=\s*(.*?)\s*$/i.exec(part);
      if(match){const key=match[1].toLowerCase();if(tags.has(key))return undefined;tags.set(key,match[2]);}
    }
    return tags;
  }).filter((tags):tags is Map<string,string>=>!!tags);
  for(const clause of clean.split(';').slice(1)){
    if(!/^\s*dkim\s*=\s*pass\b/i.test(clause))continue;
    const property=(name:string)=>new RegExp('\\bheader\\.'+name+'\\s*=\\s*([^\\s;]+)','i').exec(clause)?.[1];
    const identity=property('i');
    const domain=(property('d')||identity?.slice(identity.lastIndexOf('@')+1))?.toLowerCase();
    if(!domain||!/^[a-z0-9.-]+$/.test(domain))continue;
    const selector=property('s'),prefix=property('b');
    const matched=signatures.filter(tags=>tags.get('d')?.toLowerCase()===domain&&
      (!selector||tags.get('s')===selector)&&(!prefix||tags.get('b')?.startsWith(prefix)));
    // Without a selector/signature identifier, multiple signatures from one domain
    // cannot be bound to this result safely.
    if(matched.length!==1)continue;
    const covered=(matched[0].get('h')||'').toLowerCase().split(':').map(name=>name.trim());
    if(covered.includes('list-unsubscribe')&&covered.includes('list-unsubscribe-post'))return true;
  }
  return false;
}

/**
 * Why automatic unsubscribe did not finish, or that it did.
 *
 * The server returns one of these; the browser turns it into a sentence. Keeping the code
 * and the wording apart means the text can be rewritten without the server pretending a
 * different thing happened, and a code this version does not know degrades to the general
 * case instead of showing an empty notice.
 */
export type UnsubscribeReason =
  | 'accepted'
  | 'in-progress'
  | 'confirmation-required'
  | 'open-page'
  | 'email-required'
  | 'no-instructions'
  | 'unverified-destination'
  | 'account-disconnected'
  | 'provider-rejected'
  | 'uncertain'
  | 'unreadable'
  | 'record-not-saved';

/** What the person can do next, alongside the sentence. */
export type UnsubscribeAction = 'page' | 'gmail' | 'none';

const NOTICES: Record<UnsubscribeReason, { text: string; action: UnsubscribeAction }> = {
  'accepted': {
    text: 'The newsletter service accepted your unsubscribe request. Your existing emails will stay here.',
    action: 'none' },
  'in-progress': { text: 'That request is already being sent.', action: 'none' },
  'confirmation-required': {
    text: 'This newsletter requires confirmation on its website. Open the unsubscribe page to finish.',
    action: 'page' },
  'open-page': {
    text: 'This newsletter’s unsubscribe link has to be opened in your browser. Open the unsubscribe page to finish.',
    action: 'page' },
  'email-required': {
    text: 'This newsletter asks you to unsubscribe by email. Open the message in Gmail to follow its instructions.',
    action: 'gmail' },
  'no-instructions': {
    text: 'This email doesn’t include a supported unsubscribe option. Open it in Gmail to check the sender’s instructions.',
    action: 'gmail' },
  'unverified-destination': {
    text: 'We couldn’t verify this unsubscribe link. Open the original email in Gmail to review it.',
    action: 'gmail' },
  'account-disconnected': {
    text: 'Reconnect this Gmail account before trying again.', action: 'none' },
  'provider-rejected': {
    text: 'The newsletter service couldn’t accept the request. Try again later or finish in Gmail.',
    action: 'gmail' },
  'uncertain': {
    text: 'We couldn’t confirm whether the request went through. Check the newsletter’s subscription settings before trying again.',
    action: 'page' },
  'unreadable': {
    text: 'This message couldn’t be read from Gmail. Open it in Gmail to unsubscribe there.', action: 'gmail' },
  'record-not-saved': {
    text: 'The newsletter service accepted your request, but we couldn’t save that here. Nothing needs redoing.',
    action: 'none' },
};

/** The sentence and next step for a reason, falling back for a code this version predates. */
export function notice(reason: unknown): { text: string; action: UnsubscribeAction } {
  return (typeof reason === 'string' && reason in NOTICES
    ? NOTICES[reason as UnsubscribeReason]
    : { text: 'This unsubscribe could not be completed here. Open the message in Gmail to finish it.', action: 'gmail' });
}

/**
 * The reason to report, from what the app could do and what happened.
 *
 * Opening a page is never an outcome: a manual capability reports what the person must do,
 * and only a provider response can produce `accepted`.
 */
export function reasonFor(capability: UnsubscribeCapability, outcome: UnsubscribeOutcome,
  recordSaved = true): UnsubscribeReason {
  if (capability === 'email-required') return 'email-required';
  if (capability === 'none') return 'no-instructions';
  if (capability === 'unverified') return 'unverified-destination';
  if (capability === 'unavailable') return 'unreadable';
  // A link the server will not call by itself is still the sender's own. Say so and offer it,
  // rather than claiming the message has no unsubscribe option.
  if (capability === 'manual-page') return 'open-page';
  if (outcome === 'accepted') return recordSaved ? 'accepted' : 'record-not-saved';
  if (outcome === 'pending') return 'in-progress';
  if (outcome === 'action-required') return 'confirmation-required';
  if (outcome === 'failed') return 'provider-rejected';
  if (outcome === 'unknown') return 'uncertain';
  return 'no-instructions';
}
