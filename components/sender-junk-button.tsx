'use client';
import { useRef, useState } from 'react';
import { Ban, Undo2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useSenderRule, type SenderRuleOutcome } from '@/hooks/use-sender-rule';
import type { Email } from '@/lib/mail';

/**
 * Mark or unmark this message's sender as junk, from the reader's action row.
 *
 * The active state comes from the saved preference, never from the message having been
 * sorted into Noise: an automatic Junk classification and a rule the user confirmed are
 * different things, and only the second one has anything to undo.
 *
 * The rule covers this exact sender address in the Gmail account that received the
 * message. Other senders at the same domain, and the same sender in another connected
 * account, are unaffected.
 */
export function SenderJunkButton({ email, demo, onApplied, onRefresh }: {
  email: Email;
  demo: boolean;
  onApplied: (email: Email) => void;
  onRefresh?: () => Promise<boolean>;
}) {
  const { active, pending, notice, setNotice, markJunk, clearRule, revert } =
    useSenderRule({ email, demo, onApplied, onRefresh });
  const [confirming, setConfirming] = useState(false);
  const [reversible, setReversible] = useState<Extract<SenderRuleOutcome, { ok: true }> | null>(null);
  // Focus returns here when the confirmation closes, however it was dismissed.
  const trigger = useRef<HTMLButtonElement>(null);

  const busy = pending !== null;
  const sender = email.address || 'this sender';
  const mailbox = email.accountEmail || 'this mailbox';

  function dismiss() {
    setConfirming(false);
    // Base UI restores focus on its own for a click, but not for every dismissal path.
    window.setTimeout(() => trigger.current?.focus(), 0);
  }

  async function confirmMark() {
    const outcome = await markJunk();
    if (!outcome.ok) return; // Keep the dialog open with the error still readable.
    setConfirming(false);
    setReversible(outcome);
    window.setTimeout(() => trigger.current?.focus(), 0);
  }

  async function undoRule() {
    const outcome = await clearRule();
    if (outcome.ok) setReversible(null);
  }

  async function undoRecent() {
    if (!reversible) return;
    const outcome = await revert(reversible);
    if (outcome.ok) setReversible(null);
  }

  const label = active ? 'Undo sender junk' : 'Mark sender as junk';
  const busyLabel = pending === 'mark' ? 'Saving…' : 'Undoing…';

  return <>
    <button
      ref={trigger}
      type="button"
      className="sender-junk-button"
      data-active={active || undefined}
      disabled={busy}
      aria-busy={busy || undefined}
      // The visible text shortens on a narrow screen, so the accessible name is stated
      // here and stays complete at every width.
      aria-label={busy ? busyLabel : label}
      title={active ? 'This sender is marked as junk.' : label}
      onClick={() => {
        if (active) { void undoRule(); return; }
        if (demo) { void markJunk(); return; }
        setNotice(null);
        setConfirming(true);
      }}
    >
      {active ? <Undo2 size={14} /> : <Ban size={14} />}
      <span className="sender-junk-label">{busy ? busyLabel : label}</span>
      <span className="sender-junk-label-short" aria-hidden="true">{busy ? '…' : active ? 'Undo' : 'Junk'}</span>
    </button>

    {active && !busy && <output className="sender-junk-state">This sender is marked as junk.</output>}

    {notice && <output className={`sender-junk-notice${notice.tone === 'error' ? ' error' : ''}`} aria-live="polite">
      <span>{notice.text}</span>
      {/* Reverses that one save. After it expires the permanent control above remains the
          way to remove the rule; it is not a second chance at this exact change. */}
      {notice.tone === 'saved' && reversible && <button type="button" disabled={busy} onClick={() => void undoRecent()}>Undo</button>}
      <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>×</button>
    </output>}

    <Dialog open={confirming} onOpenChange={open => { if (!open) dismiss(); }}>
      <DialogContent className="sender-junk-dialog">
        <DialogTitle>Mark this sender as junk?</DialogTitle>
        <DialogDescription>
          Existing and future messages from {sender} in {mailbox} will appear in Noise in this app.
          Messages you explicitly chose to keep are exceptions. Nothing is deleted, unsubscribed, or changed in Gmail.
        </DialogDescription>
        {notice?.tone === 'error' && <output className="sender-junk-notice error" aria-live="polite">{notice.text}</output>}
        <div className="sender-junk-dialog-actions">
          <button type="button" className="button white" disabled={busy} onClick={dismiss}>Cancel</button>
          <button type="button" className="button blue" disabled={busy} onClick={() => void confirmMark()}>
            {pending === 'mark' ? 'Saving…' : 'Mark sender as junk'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
