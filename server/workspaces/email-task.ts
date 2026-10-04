import { HttpError } from '../runtime';
import { string } from './validation';
import { parseSnapshot } from '../snapshots';
import { loadMessage } from '../messages';
import type { Runtime } from '../runtime';
import { withoutInvisibles } from '@/lib/purpose';
import {
  appliesToUser,
  effectiveClassification,
  isResolved,
  relevantDueAt,
  type Obligation,
} from '@/lib/classification';

/**
 * Turns one message in a private mailbox into the draft of a team task.
 *
 * Brief has already read the message and worked out what it asks for and by when, so this
 * is mostly a matter of not throwing that away: the deadline comes from the obligation the
 * classifier recorded, not from anything the browser says.
 *
 * Like the corpus bridge next door, the mailbox is read here on the server and only the
 * sender's name and the summary cross into the workspace. The browser never submits the
 * message text, and the caller must send back the hash of the draft a person actually read.
 */

export type EmailTaskDraft = {
  title: string;
  detail: string;
  /** A day as `YYYY-MM-DD`, an instant as ISO, or null when the message named no date. */
  due: string | null;
  sender: string;
  subject: string;
};

/** The soonest live obligation this message puts on the reader, as a task deadline. */
function deadlineOf(obligations: Obligation[]): string | null {
  let best: { at: number; timed: boolean } | undefined;
  for (const obligation of obligations) {
    if (
      !obligation ||
      typeof obligation !== 'object' ||
      !obligation.required ||
      !appliesToUser(obligation) ||
      isResolved(obligation)
    )
      continue;
    const at = relevantDueAt(obligation);
    if (at === undefined) continue;
    // A meeting is an appointment rather than work to finish, so it never becomes the
    // task's deadline unless nothing else offered one.
    if (!best || at < best.at)
      best = { at, timed: typeof obligation.due?.time === 'string' };
  }
  if (!best) return null;
  // A date-only deadline is handed back as the date, not as the 23:59 instant it resolves
  // to, so the task stores the same day-level deadline the message gave.
  return best.timed
    ? new Date(best.at).toISOString()
    : new Date(best.at).toISOString().slice(0, 10);
}

export async function emailTaskDraft(
  db: D1Database,
  userId: string,
  data: Record<string, unknown>,
): Promise<EmailTaskDraft> {
  const accountId = string(data.accountId, 'Account ID');
  const messageId = string(data.messageId, 'Message ID');
  if (accountId === 'all')
    throw new HttpError(
      400,
      'Open the message in one mailbox before adding it as a task.',
    );
  // Both identifiers together: an account id from the browser is never on its own proof
  // that the signed-in user owns that mailbox.
  const row = await db
    .prepare(
      'SELECT data FROM snapshots WHERE account_id = ? AND user_id = ?',
    )
    .bind(accountId, userId)
    .first<{ data: string }>();
  if (!row) throw new HttpError(404, 'Refresh this Gmail account first.');
  const snapshot = parseSnapshot(row.data);
  if (!snapshot)
    throw new HttpError(
      409,
      'This Gmail cache is damaged. Refresh the mailbox and try again.',
    );
  const email =
    (await loadMessage(userId, accountId, messageId, { DB: db } as Runtime)) ||
    snapshot.emails.find((item) => item?.id === messageId);
  if (!email)
    throw new HttpError(
      409,
      'That message is no longer in the snapshot. Refresh the mailbox.',
    );
  const stored = email.classification;
  const classification =
    stored && typeof stored === 'object' ? effectiveClassification(stored) : null;
  const obligations = Array.isArray(classification?.obligations)
    ? classification.obligations
    : [];
  // Campaign preview padding is invisible in a mail client but arrives here as hundreds
  // of characters, so it is stripped before the text is put in front of a team.
  const readable = (value: string) =>
    withoutInvisibles(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  const summary = readable(email.summary);
  return {
    title: readable(email.subject).slice(0, 200) || 'Follow up on a message',
    // The sender's name and the summary, which is what the corpus bridge shares too. The
    // address and the body stay in the owner's mailbox.
    detail: `From ${readable(email.sender)}${summary ? `: ${summary}` : ''}`.slice(
      0,
      4000,
    ),
    due: deadlineOf(obligations),
    sender: readable(email.sender),
    subject: readable(email.subject),
  };
}
