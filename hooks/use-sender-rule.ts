'use client';
import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/inbox-client';
import { actionAccountId, type Email } from '@/lib/mail';

/**
 * The one place a sender Junk/Keep preference is saved.
 *
 * Both the reader's top-right control and the detailed controls below a message use this,
 * so the two can never disagree about what is saved, which revision is current, or what a
 * conflict means.
 *
 * Scope is always one signed-in user, one connected Gmail account, and one exact stored
 * sender address. The account travels with the request rather than being read from the
 * current selection, so acting on a message in the combined view still targets the mailbox
 * that received it.
 */

export type JunkPreference = 'junk' | 'not-junk';
export type SenderRulePending = 'mark' | 'undo' | null;

/** What a completed save reports back, so a caller can offer to reverse exactly it. */
export type SenderRuleOutcome =
  | { ok: true; revision: number; previous?: JunkPreference }
  | { ok: false };

type Response = {
  email?: Email;
  senderRuleRevision?: number;
  senderJunkPreference?: JunkPreference | null;
};

export type SenderRuleNotice = { text: string; tone: 'saved' | 'error' } | null;

export function useSenderRule({ email, demo, onApplied, onRefresh }: {
  email: Email;
  demo: boolean;
  onApplied: (email: Email) => void;
  /** Re-reads the cached mailbox so every affected message moves, not just this one. */
  onRefresh?: () => Promise<boolean>;
}) {
  const [pending, setPending] = useState<SenderRulePending>(null);
  const [notice, setNotice] = useState<SenderRuleNotice>(null);
  // A synchronous guard as well as the rendered `disabled` state: React applies state
  // asynchronously, so two fast clicks can both pass a check that has not re-rendered yet.
  const running = useRef(false);

  // Read as individual values so the save callback stays stable across renders that
  // rebuild an otherwise identical message object.
  const { id, accountId: account, correctionRevision, senderRuleRevision: senderRevision,
    senderJunkPreference: senderPreference } = email;
  const active = senderPreference === 'junk';

  /**
   * `value` is the preference to save, or undefined to clear the rule.
   *
   * `at` pins the revision this write is ordered against. The temporary Undo passes the
   * revision its own save returned, so it reverses that change and nothing newer.
   */
  // These are only ever called from event handlers, so they need no manual memoisation;
  // the React compiler handles it, and hand-written dependency lists would be one more
  // thing to keep in step with the fields read below.
  async function save(
    intent: Exclude<SenderRulePending, null>,
    value: JunkPreference | undefined,
    options: { at?: number; success?: string } = {},
  ): Promise<SenderRuleOutcome> {
    if (demo) {
      setNotice({ text: 'Connect Gmail to save sender preferences. This is the sample workspace.', tone: 'error' });
      return { ok: false };
    }
    if (running.current) return { ok: false };
    running.current = true;
    setPending(intent);
    setNotice(null);

    // Captured before the request so a refresh arriving mid-flight cannot redirect it to
    // another account or message, and so Undo knows what it is reversing.
    const previous = senderPreference;
    const messageId = id;
    let accountId: string;
    try {
      accountId = actionAccountId({ accountId: account });
    } catch (error) {
      running.current = false;
      setPending(null);
      setNotice({ text: error instanceof Error ? error.message : 'This message has no mailbox.', tone: 'error' });
      return { ok: false };
    }

    try {
      const result = await api<Response>('/api/classification', {
        messageId,
        accountId,
        expectedRevision: correctionRevision ?? 0,
        expectedSenderRevision: options.at ?? senderRevision ?? 0,
        action: value === undefined
          ? { type: 'clear-sender-junk-preference' }
          : { type: 'set-sender-junk-preference', value },
      });
      if (result.email) onApplied(result.email);
      const refreshed = onRefresh ? await onRefresh() : true;
      setNotice({
        text: refreshed
          ? options.success ?? 'Saved.'
          : `${options.success ?? 'Saved.'} The list could not be refreshed — reload to see every affected message.`,
        tone: refreshed ? 'saved' : 'error',
      });
      return { ok: true, revision: result.senderRuleRevision ?? 0, previous };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The rule changed somewhere else. Show what is actually saved rather than
        // repeating the write over a choice made in another tab.
        try {
          const latest = await api<{ emails: Email[] }>(`/api/mailbox?accountId=${encodeURIComponent(accountId)}`);
          const match = latest.emails.find(item => item.id === messageId && item.accountId === accountId);
          if (match) onApplied(match);
        } catch { /* Keep the conflict message when the reload also fails. */ }
        setNotice({ text: 'This sender preference changed somewhere else. The current setting is shown.', tone: 'error' });
        return { ok: false };
      }
      setNotice({ text: error instanceof Error ? error.message : 'That preference could not be saved.', tone: 'error' });
      return { ok: false };
    } finally {
      running.current = false;
      setPending(null);
    }
  }

  const markJunk = () => save('mark', 'junk', { success: 'Sender marked as junk.' });

  /** Removes the saved rule. It does not create a Keep preference in its place. */
  const clearRule = () => save('undo', undefined, {
    success: 'Sender junk rule removed. Automatic sorting and message-specific corrections apply again.',
  });

  /**
   * Reverses one specific save. Where there was no preference before, the rule is cleared;
   * where there was a Keep preference, that is restored. It is ordered against the revision
   * the original save returned, so a newer change made elsewhere wins instead of being
   * silently overwritten.
   */
  const revert = (outcome: Extract<SenderRuleOutcome, { ok: true }>) =>
    save('undo', outcome.previous, {
      at: outcome.revision,
      success: outcome.previous
        ? 'Previous sender preference restored.'
        : 'Sender junk rule removed. Automatic sorting and message-specific corrections apply again.',
    });

  return { active, pending, notice, setNotice, markJunk, clearRule, revert, save };
}
