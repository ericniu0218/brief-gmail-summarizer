'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ShieldCheck, Sparkles, Undo2 } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { ACTION_LABEL, DIGEST_SHOWN, digestItems, digestMembership, digestSummary, dueIsSoon, dueLabel, fallbackText, provisionalItems, type Digest } from '@/lib/digest';
import { demoDigest } from '@/lib/demo-digest';
import { receivedLabel } from '@/lib/email-time';
import type { FoldPreferences } from '@/lib/folding';
import { api } from '@/hooks/use-inbox';

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
  accountId = 'all',
  foldPreferences = {},
  doneKeys, onDone, onMoveBack,
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
  accountId?: string;
  foldPreferences?: FoldPreferences;
  doneKeys?:ReadonlySet<string>;
  onDone?:(emails:Email[])=>void;
  onMoveBack?:(emails:Email[])=>void;
}) {
  const [done, setDone] = useState<Set<string>>(new Set());
  const [localWording,setLocalWording]=useState<{variant:string;digest:Digest}|null>(null);
  const requested=useRef('');
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
  const available=useMemo(()=>doneKeys?emails.filter(email=>!doneKeys.has(emailKey(email))):emails,[emails,doneKeys]);
  const items = useMemo(() => (now === null ? provisionalItems(available) : digestItems(available, now, foldPreferences)), [available, now, foldPreferences]);
  const handled=doneKeys?emails.filter(email=>email.category!=='noise'&&doneKeys.has(emailKey(email))):[];
  const shown = items.filter((item) => doneKeys||!done.has(item.key)).slice(0, DIGEST_SHOWN);
  const hidden = doneKeys?handled.length:items.filter((item) => done.has(item.key)).length;
  useEffect(()=>{
    if(!onDone||!done.size||!emails.length)return;
    const previous=now===null?provisionalItems(emails):digestItems(emails,now,foldPreferences);
    const keys=new Set(previous.filter(item=>done.has(item.key)).flatMap(item=>item.keys));
    for(const key of done)keys.add(key);
    const restored=emails.filter(email=>keys.has(emailKey(email))&&!doneKeys?.has(emailKey(email)));
    const timer=window.setTimeout(()=>{
      if(restored.length)onDone(restored);
      try{window.localStorage.removeItem(storageKey);}catch{/* Storage may be blocked. */}
      setDone(new Set());
    },0);
    return()=>window.clearTimeout(timer);
  },[done,doneKeys,onDone,emails,now,foldPreferences,storageKey]);
  const variant=JSON.stringify([scope,digest?.items.map(text=>[text.id,text.fp]),
    shown.map(item=>[item.key,item.keys,item.group,item.conversation,item.email.subject,item.email.summary,item.email.label,item.email.needsReply,item.email.priority])]);
  const extra=localWording?.variant===variant?localWording.digest:undefined;
  const wording = connected ? digest : demoDigest;
  // One lead message can have wording saved for more than one grouping (with and without the
  // reader's fold preferences), so every saved version is kept and the matching one is used.
  const texts = useMemo(() => {
    const byId=new Map<string,Digest['items']>();
    for(const text of [...(extra?.items||[]),...(wording?.items||[])])byId.set(text.id,[...(byId.get(text.id)||[]),text]);
    return byId;
  }, [wording,extra]);
  const fits = (written: Digest['items'][number], item: (typeof items)[number]) => {
    if(written.members!==undefined&&written.members!==item.keys.length)return false;
    if(written.grouping&&written.grouping!==(item.conversation?'conversation':item.group?'notifications':'single'))return false;
    if(written.membership&&written.membership!==digestMembership(item.keys))return false;
    // Older saved wording has no group metadata, so it is safe only for one message.
    if(written.members===undefined&&item.keys.length>1)return false;
    if(written.membership===undefined&&item.keys.length>1)return false;
    return true;
  };
  const writtenFor = (item: (typeof items)[number]) => texts.get(item.key)?.find(written=>fits(written,item));
  const missingLocalWording=connected&&aiConfigured&&!!digest?.items.length&&Object.keys(foldPreferences).length>0
    &&shown.some(item=>!writtenFor(item));
  const attemptKey=`${variant}:${digest?.generated||0}`;
  useEffect(()=>{
    if(!missingLocalWording||requested.current===attemptKey)return;
    requested.current=attemptKey;
    const controller=new AbortController();
    let settled=false;
    void api<Digest>('/api/digest/wording',{accountId,preferences:foldPreferences},controller.signal)
      .then(result=>{if(!controller.signal.aborted)setLocalWording({variant,digest:result});})
      .catch(()=>{/* Keep the honest fallback until the next inbox update. */})
      .finally(()=>{settled=true;});
    return()=>{
      controller.abort();
      // Cut off before it answered (a preference changed mid-request, say): allow the next
      // run to ask again instead of leaving this attempt marked as done.
      if(!settled&&requested.current===attemptKey)requested.current='';
    };
  },[missingLocalWording,variant,attemptKey,accountId,foldPreferences]);
  const effectiveAction = (item: (typeof items)[number]) => writtenFor(item)?.action || item.action;

  const preparing = connected && !updated && busy;
  const lastSync = updated
    ? new Date(updated).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : null;
  const tally = now === null ? '' : digestSummary(shown.map((item) => ({ ...item, action: effectiveAction(item) })), now);
  const aiBrief=shown.some(item=>!!writtenFor(item));
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
                  (aiBrief||ai
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
              : aiBrief||ai
                ? 'AI SUMMARY'
                : 'INBOX HIGHLIGHTS'
            : 'SAMPLE BRIEF'}
        </span>
        <span className="brief-time">
          {lastSync ? 'Updated ' + lastSync : 'Just for you'}
        </span>
        {/* The list is the brief's job, so its one control sits in the heading instead of
            a footer bar under it. Collapsed, the footer returns to say so and reopen it. */}
        {!collapsed && (
          <button type="button" className="digest-caught-up" onClick={onCollapse}>
            I’m caught up
            <Check size={14} />
          </button>
        )}
      </div>
      {!collapsed && (
        <>
          <output className={`brief-intro digest-summary${shown.length ? ' digest-tally' : ''}`}>{intro}</output>
          {shown.length > 0 && (
            <ol className="digest-list">
              {shown.map((item, index) => {
                const written = writtenFor(item);
                const text = written || fallbackText(item);
                const action = effectiveAction(item);
                const due = now === null ? undefined : dueLabel(item, now);
                return (
                  <li key={item.key} className="digest-item" data-action={action}>
                    <span className="digest-rank" aria-hidden="true">{index + 1}</span>
                    {/* Two lines: what and how urgent, then why and from whom. Long text is
                        trimmed on screen only; the full sentence stays readable on hover and
                        to screen readers. */}
                    <button type="button" className="digest-open" title={`${text.headline}. ${text.why}`} aria-label={`${text.headline}. ${text.why}`} onClick={() => onSelect(item.email)}>
                      <span className="digest-line">
                        <strong>{text.headline}</strong>
                        <span className="digest-chips">
                          <span className="digest-chip">{ACTION_LABEL[action]}</span>
                          {due && now !== null && <span className="digest-chip due" data-soon={dueIsSoon(item, now) || undefined}>{due}</span>}
                        </span>
                      </span>
                      <span className="digest-line digest-detail">
                        <span className="digest-why">{text.why}</span>
                        <span className="digest-from">{[item.email.sender, receivedLabel(item.email, now), item.keys.length > 1 ? `+${item.keys.length - 1} related` : ''].filter(Boolean).join(' · ')}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="digest-done"
                      aria-label={`Mark done: ${text.headline}`}
                      title="Mark done"
                      onClick={() => onDone?onDone(emails.filter(email=>item.keys.includes(emailKey(email)))):remember(new Set([...done, item.key]))}
                    >
                      <Check size={13} />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {hidden > 0 && now !== null && (
            <button type="button" className="digest-restore" onClick={() => onMoveBack?onMoveBack(handled):remember(new Set())}>
              <Undo2 size={13} />
              Show {hidden} ticked-off {hidden === 1 ? 'item' : 'items'} again
            </button>
          )}
        </>
      )}
      {collapsed && (
        <div className="brief-footer">
          <span>
            <ShieldCheck size={14} /> You’re all caught up on the highlights.
          </span>
          <button onClick={onCollapse}>
            Show summary
            <Check size={15} />
          </button>
        </div>
      )}
    </section>
  );
}
