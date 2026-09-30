import { privateDestination, safeUnsubscribe } from './gmail';
import type { NormalizedMessage } from './message';
import type { Runtime } from './runtime';
import { newsletterIdentity, oneClickAuthenticated, parseListUnsubscribe, type NewsletterIdentity, type UnsubscribeCapability } from '@/lib/unsubscribe';

/**
 * What this app can do about the newsletter a message came from, decided entirely from the
 * message itself.
 *
 * Every value here comes from the copy of the message fetched from the receiving Gmail
 * account. Nothing is taken from the browser, and no destination is ever guessed from a
 * sender's domain: a request is only sent where the message's own headers say to send it.
 *
 * Section 7 hardens the header parsing (folding, duplicates, conflicting values, length
 * limits); this is the shape that parsing feeds.
 */
export type UnsubscribePlan = {
  capability: UnsubscribeCapability;
  /** Where an automatic request may be POSTed. Only set for `one-click`. */
  automatic?: string;
  /** A page the person can open themselves. Only set when it passed basic URL checks. */
  page?: string;
  /** The address the sender asks to be mailed, when that is the only method offered. */
  mailto?: string;
  identity: NewsletterIdentity;
};

/**
 * Whether a link is safe to *offer* to the person.
 *
 * This is deliberately weaker than {@link safeUnsubscribe}, which gates requests this
 * server makes by itself. Opening a page happens in the person's own browser, under their
 * control, so an unknown provider is allowed — but the scheme, credentials and port are
 * still checked so the interface never presents a link that is obviously not a web page.
 */
function safeToOpen(url: string) {
  let target: URL;
  try { target = new URL(url); } catch { return false; }
  if (target.protocol !== 'https:') return false;
  if (target.username || target.password) return false;
  if (privateDestination(target.hostname)) return false;
  return !target.port || target.port === '443';
}

export function describeUnsubscribe(message: NormalizedMessage, e: Runtime): UnsubscribePlan {
  const values = message.headerValues;
  const identity = newsletterIdentity(message.id, message.headers['list-id']);
  const listed = parseListUnsubscribe(values?.['list-unsubscribe'] ?? message.headers['list-unsubscribe']);
  const { https, mailto: mail } = listed;
  // Repeated headers that disagree, or a value nothing could be read from, leave the app
  // with no destination it can attribute to the sender.
  if (listed.conflicting || (listed.malformed && !https.length && !mail.length))
    return { capability: 'unverified', identity };

  const post = (values?.['list-unsubscribe-post'] || [message.headers['list-unsubscribe-post'] || ''])
    .join(' ').toLowerCase();
  const oneClick = post.includes('list-unsubscribe=one-click');

  // A one-click endpoint is only automatic when the server may safely reach it *and* the
  // headers carrying the offer are covered by a passing signature. Where either fails, the
  // link is still worth offering by hand, so the person is not left with nothing.
  const automatic = https.find(url => safeUnsubscribe(url, e));
  if (oneClick && automatic && oneClickAuthenticated(values, message.headers))
    return { capability: 'one-click', automatic, page: automatic, identity };

  const page = https.find(safeToOpen);
  if (page) return { capability: 'manual-page', page, identity };

  // An https method exists but is not a link this app will show: not https after parsing,
  // carrying credentials, or on an unexpected port.
  if (https.length) return { capability: 'unverified', identity };

  if (mail.length) return { capability: 'email-required', mailto: mail[0], identity };
  return { capability: 'none', identity };
}
