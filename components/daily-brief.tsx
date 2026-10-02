'use client';
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Check, ShieldCheck, Sparkles, Undo2 } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { ACTION_LABEL, DIGEST_SHOWN, digestItems, digestSummary, dueIsSoon, dueLabel, fallbackText, provisionalItems, type Digest, type DigestAction } from '@/lib/digest';
import { demoDigest } from '@/lib/demo-digest';

const DONE_LIMIT = 500;

/**
 * The daily digest: up to five things most worth attention, each with a one-line "what to do".
 *
 * Which items appear and in what order comes from the app's importance policy, recomputed here
 * from the live emails and the shared dashboard clock. Replying removes an item at once, and
 * "due today" follows the viewer's timezone. The AI only supplies the wording (`digest`); with
 * none, each item shows the email's own subject and summary. It also explains whether the
 * content is sample data, an AI summary, or the deterministic fallback.
 */
export function DailyBrief({
  emails,
  now,
  connected,
  ai,
  aiConfigured,
  busy,
  updated,
  collapsed,
  onCollapse,
  onSelect,
  digest,
  scope = 'demo',
}: {
  emails: Email[];
  /** The dashboard's shared clock; null until the browser supplies one. */
  now: number | null;
  connected: boolean;
  ai: boolean;
  aiConfigured: boolean;
  busy: boolean;
  updated: number | null;
  collapsed: boolean;
  onCollapse: () => void;
  onSelect: (email: Email) => void;
  /** AI-written wording saved with the inbox. Ranking never depends on it. */
  digest?: Digest;
  /** Whose ticked-off items these are, so they stay with one person and one mailbox view. */
  scope?: string;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const storageKey = `brief:digest-done:${scope}`;
  // What was ticked off lives only in this browser; failing to read or write it is harmless.
  useEffect(() => {
    const load = window.setTimeout(() => {
      try {
        setDone(new Set(JSON.parse(window.localStorage.getItem(storageKey) || '[]') as string[]));
      } catch {
        setDone(new Set());
      }
    }, 0);
    return () => window.clearTimeout(load);
  }, [storageKey]);
  function remember(next: Set<string>) {
    setDone(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next].slice(-DONE_LIMIT)));
    } catch {
      /* private mode or blocked storage */
    }
  }
  // Noise never reaches the digest, so promotions cannot consume a slot.
  // Until the browser supplies a clock the server's order and stored flags are used, so the first
  // paint already shows real content; the live policy takes over on the next frame.
  const items = useMemo(() => (now === null ? provisionalItems(emails) : digestItems(emails, now)), [emails, now]);
  const shown = items.filter((item) => !done.has(item.key)).slice(0, DIGEST_SHOWN);
  const hidden = items.filter((item) => done.has(item.key)).length;
  const wording = connected ? digest : demoDigest;
  const texts = useMemo(() => new Map((wording?.items || []).map((item) => [item.id, item])), [wording]);
  const effectiveAction = (key: string, fallback: DigestAction) => texts.get(key)?.action || fallback;

  const preparing = connected && !updated && busy;
  const lastSync = updated
    ? new Date(updated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;
  const tally = now === null ? '' : digestSummary(shown.map((item) => ({ ...item, action: effectiveAction(item.key, item.action) })), now);
  const hasMail = emails.some((email) => email.category !== 'noise');
  const intro = !connected
    ? 'A few things need you. Everything else can wait.'
    : preparing
      ? 'Reading your Gmail and preparing your first summary…'
      : !updated
        ? 'Your first brief is not ready yet. Select Refresh inbox to try again.'
        : !emails.length
          ? 'Your Gmail inbox is empty.'
          : !hasMail
            ? 'Your inbox contains newsletters and promotions. Review them in Noise.'
            : !shown.length
                ? items.length
                  ? 'You have ticked off everything on today’s list.'
                  : 'Nothing in your inbox needs you right now. Routine mail can wait.'
                : tally ||
                  (ai
                    ? 'Here are the highlights from your Gmail inbox.'
                    : aiConfigured
                      ? 'Your latest Gmail messages. AI summaries are temporarily unavailable.'
                      : 'Your latest Gmail messages. AI summaries have not been configured yet.');
  const title =
    now === null
      ? 'Your daily brief'
      : shown.length === 0
        ? connected && updated && hasMail && !items.length
          ? 'Nothing urgent today'
          : 'Your daily brief'
        : shown.length === 1
          ? 'Your most important thing today'
          : `Your ${shown.length} most important things today`;
  return (
    <section
      className={`briefing-card digest-card ${collapsed ? 'briefing-collapsed' : ''}`}
      aria-busy={preparing}
      aria-label="Daily brief"
    >
      <div className="card-heading">
        <span className="section-icon">
          <Sparkles size={18} />
        </span>
        <h2>{title}</h2>
        <span className="ai-label">
          {connected
            ? preparing
              ? 'PREPARING'
              : ai
                ? 'AI SUMMARY'
                : 'INBOX HIGHLIGHTS'
            : 'SAMPLE BRIEF'}
        </span>
        <span className="brief-time">
          {lastSync ? 'Updated ' + lastSync : 'Just for you'}
        </span>
      </div>
      {!collapsed && (
        <>
          <output className="brief-intro digest-summary">{intro}</output>
          {shown.length > 0 && (
            <ol className="digest-list">
              {shown.map((item, index) => {
                const written = texts.get(item.key);
                const text = written || fallbackText(item);
                const action = effectiveAction(item.key, item.action);
                const due = now === null ? undefined : dueLabel(item, now);
                return (
                  <li key={item.key} className="digest-item" data-action={action}>
                    <span className="digest-rank" aria-hidden="true">{index + 1}</span>
                    <button type="button" className="digest-open" onClick={() => onSelect(item.email)}>
                      <strong>{text.headline}</strong>
                      <span className="digest-why">{text.why}</span>
                      <span className="digest-meta">
                        <span className="digest-chip">{ACTION_LABEL[action]}</span>
                        {due && now !== null && <span className="digest-chip due" data-soon={dueIsSoon(item, now) || undefined}>{due}</span>}
                        <span className="digest-from">{item.email.sender} · {item.email.time}</span>
                        {item.keys.length > 1 && <span className="digest-from">+{item.keys.length - 1} related</span>}
                      </span>
                      <ArrowUpRight className="digest-arrow" size={15} />
                    </button>
                    <button
                      type="button"
                      className="digest-done"
                      aria-label={`Mark done: ${text.headline}`}
                      title="Mark done"
                      onClick={() => remember(new Set([...done, item.key]))}
                    >
                      <Check size={14} />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {hidden > 0 && now !== null && (
            <button type="button" className="digest-restore" onClick={() => remember(new Set())}>
              <Undo2 size={13} />
              Show {hidden} ticked-off {hidden === 1 ? 'item' : 'items'} again
            </button>
          )}
        </>
      )}
      <div className="brief-footer">
        <span>
          <ShieldCheck size={14} />{' '}
          {collapsed
            ? 'You’re all caught up on the highlights.'
            : 'The important bits, without the inbox dive.'}
        </span>
        <button onClick={onCollapse}>
          {collapsed ? 'Show summary' : 'I’m caught up'}
          <Check size={15} />
        </button>
      </div>
    </section>
  );
}
