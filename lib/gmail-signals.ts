/**
 * Gmail's own verdicts on a message, as its system labels report them.
 *
 * Gmail sorts every message before this app sees it: a tab (Primary, Social, Promotions,
 * Updates, Forums), an Important marker learned from the recipient's own habits, and the
 * recipient's own star. These are evidence, never decisions. The classifiers weigh them
 * beside what the message says, and a manual correction in this app always wins.
 *
 * Spam never reaches the app (the sync query excludes it) and Unread is stored as its own
 * field, so neither is kept here. User-created labels are opaque ids and are not kept.
 */
export const GMAIL_SIGNALS = ['IMPORTANT', 'STARRED', 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'] as const;
export type GmailSignal = typeof GMAIL_SIGNALS[number];

const KNOWN = new Set<string>(GMAIL_SIGNALS);

/** The Gmail signals among a message's labels, or undefined when labels were never recorded. */
export function gmailSignals(labels: unknown): GmailSignal[] | undefined {
  if (!Array.isArray(labels)) return undefined;
  return [...new Set(labels.filter((label): label is GmailSignal => typeof label === 'string' && KNOWN.has(label)))];
}

/** Gmail tabs whose mail is bulk by design: marketing, and notifications from social networks. */
export function inBulkTab(labels: unknown) {
  return Array.isArray(labels) && (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL'));
}

/**
 * Whether Gmail shows the message on its Primary tab: anything not sorted into Social,
 * Promotions, Updates or Forums. Unknown labels count as Primary, so a record stored before
 * labels were kept is shown rather than silently hidden.
 */
export function inPrimaryTab(labels: unknown) {
  return !Array.isArray(labels) || !labels.some(label =>
    label === 'CATEGORY_SOCIAL' || label === 'CATEGORY_PROMOTIONS' || label === 'CATEGORY_UPDATES' || label === 'CATEGORY_FORUMS');
}

/** Gmail's Forums tab: mailing-list and group discussion addressed to many people. */
export function inForumsTab(labels: unknown) {
  return Array.isArray(labels) && labels.includes('CATEGORY_FORUMS');
}
