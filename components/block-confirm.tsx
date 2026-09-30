'use client';
import { useState } from 'react';
import { Ban } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * Asks before a sender is blocked, and explains what blocking does.
 *
 * "Don't ask again" is remembered in this browser only, per signed-in user, like the
 * app's other view preferences. Storage can be unavailable (private windows, blocked site
 * data); that is treated as "ask every time", which is the safe default.
 */
const skipKey = (user: string) => `brief-skip-block-confirm:${user}`;

export function skipsBlockConfirm(user: string) {
  try { return window.localStorage.getItem(skipKey(user)) === 'true'; } catch { return false; }
}

export function setSkipsBlockConfirm(user: string, skip: boolean) {
  try {
    if (skip) window.localStorage.setItem(skipKey(user), 'true');
    else window.localStorage.removeItem(skipKey(user));
  } catch { /* storage is optional */ }
}

/**
 * The explanation and the checkbox. Kept apart from the dialog so it can be mounted on
 * its own: dialogs do not render in the interaction-test browser (see tests/dom.ts).
 */
export function BlockConfirmFields({ dontAsk, onDontAskChange }: {
  dontAsk: boolean; onDontAskChange: (value: boolean) => void;
}) {
  return <div className="block-confirm-fields">
    <ul>
      <li>Their emails will be hidden in Gmail Hub.</li>
      <li>Nothing is deleted, and nothing changes in Gmail.</li>
      <li>The sender isn’t told.</li>
      <li>You can unblock them anytime from the bottom of this page.</li>
    </ul>
    <label className="block-confirm-skip">
      <input type="checkbox" checked={dontAsk} onChange={event => onDontAskChange(event.target.checked)} />
      Don’t ask me again
    </label>
  </div>;
}

export function BlockConfirm({ name, onConfirm, onCancel }: {
  /** Who is about to be blocked; the dialog is open while this is set. */
  name: string | null;
  onConfirm: (dontAsk: boolean) => void;
  onCancel: () => void;
}) {
  const [dontAsk, setDontAsk] = useState(false);
  // Every opening starts unticked, so one earlier tick is never carried into a later ask.
  const close = () => { setDontAsk(false); onCancel(); };
  return <AlertDialog open={name !== null} onOpenChange={open => { if (!open) close(); }}>
    <AlertDialogContent className="theme-prompt block-confirm">
      <AlertDialogHeader>
        <AlertDialogMedia><Ban /></AlertDialogMedia>
        <AlertDialogTitle>Block {name}?</AlertDialogTitle>
        <AlertDialogDescription>You won’t see emails from this sender in Gmail Hub.</AlertDialogDescription>
      </AlertDialogHeader>
      <BlockConfirmFields dontAsk={dontAsk} onDontAskChange={setDontAsk} />
      <AlertDialogFooter>
        <AlertDialogCancel onClick={close}>Cancel</AlertDialogCancel>
        <AlertDialogAction onClick={() => { const skip = dontAsk; setDontAsk(false); onConfirm(skip); }}>
          <Ban />Block sender
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
