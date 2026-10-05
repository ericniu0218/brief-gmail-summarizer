'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { WorkspaceClient } from '@/lib/workspaces/client';
import {
  dayLabel,
  MAX_MESSAGE_LENGTH,
  messageTurns,
  sendsOnKey,
  startsNewDay,
  timeLabel,
  type Message,
} from '@/lib/chat';

/**
 * The workspace conversation.
 *
 * Messages are followed by cursor: each poll asks for everything after the highest
 * sequence already held, so nothing is missed or shown twice however the timing falls.
 * Hosting here gives no push channel, so this polls — often while the tab is in front,
 * rarely when it is not. A send appears immediately and carries a key, so a retry on a
 * weak connection cannot post the same message twice.
 *
 * The whole tail is re-read occasionally as well, because withdrawing a message changes
 * one already sent, which a forward-only cursor would never revisit.
 */

const api = new WorkspaceClient();
const FOLLOW_MS = 4000;
const HIDDEN_MS = 30000;
const RELOAD_MS = 60000;
/** Treat the reader as "at the bottom" within this many pixels of it. */
const NEAR_BOTTOM = 80;

export function TeamChat({
  workspaceId,
  canWrite,
  onRead,
  followMs = FOLLOW_MS,
}: {
  workspaceId: string;
  canWrite: boolean;
  onRead: (sequence: number) => void;
  /** How often the conversation is followed. The default is a reading pace. */
  followMs?: number;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [me, setMe] = useState('');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [behind, setBehind] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** The highest sequence held, which is where the next poll resumes from. */
  const highest = useRef(0);
  const base = `workspaces/${encodeURIComponent(workspaceId)}/messages`;

  const merge = useCallback((incoming: Message[], replace: boolean) => {
    for (const message of incoming)
      highest.current = Math.max(highest.current, message.sequence);
    setMessages((previous) => {
      if (replace) return incoming;
      if (!incoming.length) return previous;
      // Keyed by sequence, so a message already held is updated rather than repeated even
      // if a poll and a send deliver it at the same moment.
      const bySequence = new Map(previous.map((m) => [m.sequence, m]));
      for (const message of incoming) bySequence.set(message.sequence, message);
      return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
    });
  }, []);

  const load = useCallback(
    async (after: number | null, signal?: AbortSignal) => {
      const query = after === null ? '' : `?after=${after}`;
      const result = await api.request<{
        items: Message[];
        latest: number;
        me: string;
      }>(`${base}${query}`, signal ? { signal } : {});
      if (signal?.aborted) return;
      merge(result.items, after === null);
      setMe(result.me);
      setNow(Date.now());
      if (result.latest) onRead(result.latest);
    },
    [base, merge, onRead],
  );

  useEffect(() => {
    const controller = new AbortController();
    let sinceReload = 0;
    const follow = async (full: boolean) => {
      try {
        await load(full ? null : highest.current, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted)
          setNotice((error as Error).message);
      }
    };
    const first = setTimeout(() => void follow(true), 0);
    const timer = setInterval(() => {
      if (document.hidden) return;
      sinceReload += followMs;
      const full = sinceReload >= RELOAD_MS;
      if (full) sinceReload = 0;
      void follow(full);
    }, followMs);
    const slow = setInterval(() => {
      if (document.hidden) void follow(false);
    }, HIDDEN_MS);
    const tick = setInterval(() => setNow(Date.now()), 60000);
    return () => {
      controller.abort();
      clearTimeout(first);
      clearInterval(timer);
      clearInterval(slow);
      clearInterval(tick);
    };
  }, [load, followMs]);

  useEffect(() => {
    // Follow the conversation only when the reader is already at the bottom; yanking the
    // view while they are reading something further up is worse than a quiet arrival.
    const node = list.current;
    if (!node) return;
    if (atBottom.current) node.scrollTop = node.scrollHeight;
    // Scrolling is a DOM effect; the flag describing it is scheduled rather than set in
    // the effect body, which would re-render inside the same commit.
    const settle = setTimeout(
      () => setBehind(!atBottom.current && messages.length > 0),
      0,
    );
    return () => clearTimeout(settle);
  }, [messages]);

  function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setNotice('');
    const key = crypto.randomUUID();
    void api
      .request<Message>(base, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ body }),
      })
      .then((message) => {
        atBottom.current = true;
        merge([message], false);
        setDraft('');
      })
      .catch((error: unknown) => setNotice((error as Error).message))
      .finally(() => setSending(false));
  }

  const turns = messageTurns(messages);
  return (
    <div className="team-panel team-chat">
      <h2>Conversation</h2>
      <div
        className="team-chat-list"
        ref={list}
        onScroll={(e) => {
          const node = e.currentTarget;
          atBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM;
          if (atBottom.current) setBehind(false);
        }}
      >
        {!messages.length && (
          <p className="team-meta">
            No messages yet. This is where the group talks.
          </p>
        )}
        {turns.map((turn, index) => (
          <div key={turn.key}>
            {startsNewDay(turns, index) && (
              <div className="team-chat-day">{dayLabel(turn.created, now)}</div>
            )}
            <div
              className={`team-chat-turn${turn.authorId === me ? ' mine' : ''}`}
            >
              <div className="team-chat-who">
                <strong>{turn.authorName}</strong>
                <small>{timeLabel(turn.created)}</small>
              </div>
              {turn.messages.map((message) => (
                <div
                  className="team-chat-line"
                  key={message.id}
                >
                  {/* Plain text only: rendered as a string, never as markup. */}
                  <p className={message.deleted ? 'withdrawn' : undefined}>
                    {message.deleted ? 'Message withdrawn' : message.body}
                  </p>
                  {!message.deleted && message.authorId === me && (
                    <button
                      aria-label={`Withdraw message: ${message.body.slice(0, 40)}`}
                      onClick={() =>
                        void api
                          .request(
                            `${base}/${encodeURIComponent(message.id)}`,
                            { method: 'DELETE' },
                          )
                          .then(() => load(null))
                          .catch((error: unknown) =>
                            setNotice((error as Error).message),
                          )
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {behind && (
        <button
          className="team-chat-jump"
          onClick={() => {
            atBottom.current = true;
            if (list.current)
              list.current.scrollTop = list.current.scrollHeight;
            setBehind(false);
          }}
        >
          <ArrowDown size={14} /> New messages
        </button>
      )}
      {notice && <output className="team-meta">{notice}</output>}
      {canWrite ? (
        <div className="team-chat-compose">
          <Textarea
            aria-label="Message"
            value={draft}
            rows={2}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Write to the group…"
            disabled={sending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (!sendsOnKey(e.key, e.shiftKey)) return;
              e.preventDefault();
              send();
            }}
          />
          <Button disabled={sending || !draft.trim()} onClick={send}>
            <Send size={15} /> Send
          </Button>
        </div>
      ) : (
        <p className="team-meta">
          You can read this conversation. An editor or owner can post to it.
        </p>
      )}
    </div>
  );
}
