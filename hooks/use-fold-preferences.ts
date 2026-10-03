'use client';
import { useCallback, useEffect, useState } from 'react';
import { foldMessageKey, foldSenderKey, type FoldPreference, type FoldPreferences } from '@/lib/folding';
import type { Email } from '@/lib/mail';

/** Keep even a large split fold intact; sender choices are never subject to this cap. */
const MAX_ENTRIES = 20000;

function read(key: string): FoldPreferences {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Only known values survive, so a hand-edited or older entry cannot change grouping.
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, FoldPreference] => entry[1] === 'group' || entry[1] === 'separate'));
  } catch { return {}; }
}

/**
 * The reader's folding preferences, remembered in this browser for the signed-in user:
 * "always group this sender", "keep this sender separate", and "keep these messages
 * separate". Other tabs pick up a change through the storage event.
 */
export function useFoldPreferences(user: string) {
  const key = `brief:fold-preferences:${user || 'demo'}`;
  const [preferences, setPreferences] = useState<FoldPreferences>({});
  useEffect(() => {
    // Read after hydration, so the server render and the first paint agree.
    const timer = window.setTimeout(() => setPreferences(read(key)), 0);
    const changed = (event: StorageEvent) => { if (event.key === key) setPreferences(read(key)); };
    window.addEventListener('storage', changed);
    return () => { window.clearTimeout(timer); window.removeEventListener('storage', changed); };
  }, [key]);
  const update = useCallback((change: (current: Record<string, FoldPreference>) => void) => {
    setPreferences(previous => {
      const next: Record<string, FoldPreference> = { ...previous };
      change(next);
      const entries = Object.entries(next);
      // A large message fold must not evict deliberate sender choices.
      const senderEntries=entries.filter(([entry])=>!entry.startsWith('["message",'));
      const messageEntries=entries.filter(([entry])=>entry.startsWith('["message",'));
      const kept = Object.fromEntries([...senderEntries,...messageEntries.slice(-MAX_ENTRIES)]);
      try { window.localStorage.setItem(key, JSON.stringify(kept)); } catch { /* Applies for this visit. */ }
      return kept;
    });
  }, [key]);
  /** Set or clear a sender's preference. Clearing also lets its kept-apart messages fold again. */
  const setSenderPreference = useCallback((email: Email, value: FoldPreference | undefined) => update(next => {
    delete next[foldSenderKey(email)];
    delete next[foldMessageKey(email)];
    if (value) next[foldSenderKey(email)] = value;
  }), [update]);
  /** Keep exactly these messages out of any group, leaving their senders' other mail alone. */
  const keepSeparate = useCallback((emails: Email[]) => update(next => {
    for (const email of emails) next[foldMessageKey(email)] = 'separate';
  }), [update]);
  return { preferences, setSenderPreference, keepSeparate };
}
