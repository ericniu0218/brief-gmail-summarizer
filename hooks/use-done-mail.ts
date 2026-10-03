'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emailKey, type Email } from '@/lib/mail';

/** Enough for years of marking; the oldest marks fall away first. */
const MAX_ENTRIES = 5000;

/** Message key → when it was marked done. */
type DoneMarks = Readonly<Record<string, number>>;

function read(key: string, fallback:DoneMarks={}): DoneMarks {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Only well-formed entries survive, so a hand-edited value cannot hide mail.
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
  } catch { return fallback; }
}

/**
 * Mail the reader has marked done, remembered in this browser for the signed-in user.
 *
 * Done only moves a message out of the way in this app: nothing changes in Gmail, and a
 * new message in the same conversation is a different message, so it appears as usual.
 * Marks are per message (account and id), so one account's mail never hides another's.
 * Other tabs pick up a change through the storage event.
 */
export function useDoneMail(user: string) {
  const key = `brief:done-mail:${user || 'demo'}`;
  const [record, setRecord] = useState<{key:string;marks:DoneMarks}>({key,marks:{}});
  const marks=useMemo(()=>record.key===key?record.marks:{},[record,key]);
  const latest=useRef(record);
  const load=useCallback(()=>{const next={key,marks:read(key)};latest.current=next;setRecord(next);},[key]);
  useEffect(() => {
    // Read after hydration, so the server render and the first paint agree.
    const timer = window.setTimeout(() => load(), 0);
    const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) load(); };
    window.addEventListener('storage', changed);
    return () => { window.clearTimeout(timer); window.removeEventListener('storage', changed); };
  }, [key,load]);
  const update = useCallback((change: (next: Record<string, number>) => void) => {
    const previous=latest.current.key===key?latest.current.marks:{};
    const next: Record<string, number> = {...read(key,previous)};
    change(next);
    const kept = Object.fromEntries(Object.entries(next).sort((a,b)=>b[1]-a[1]).slice(0,MAX_ENTRIES));
    // The write happens during the click, even if React unmounts before committing state.
    try{window.localStorage.setItem(key,JSON.stringify(kept));}catch{/* Applies for this visit. */}
    latest.current={key,marks:kept};
    setRecord(latest.current);
  }, [key]);
  const markDone = useCallback((emails: Email[]) => update(next => {
    const at = Date.now();
    for (const email of emails) next[emailKey(email)] = at;
  }), [update]);
  const moveBack = useCallback((emails: Email[]) => update(next => {
    for (const email of emails) delete next[emailKey(email)];
  }), [update]);
  /** Split a list into what is still open and what is done, most recently done first. */
  const split = useCallback((emails: Email[]) => {
    const open: Email[] = [], done: Email[] = [];
    for (const email of emails) (marks[emailKey(email)] ? done : open).push(email);
    done.sort((a, b) => (marks[emailKey(b)] || 0) - (marks[emailKey(a)] || 0));
    return { open, done };
  }, [marks]);
  const count = useMemo(() => Object.keys(marks).length, [marks]);
  const keys=useMemo(()=>new Set(Object.keys(marks)),[marks]);
  return { split, markDone, moveBack, count, keys };
}
