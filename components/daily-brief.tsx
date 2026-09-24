'use client';
import { ArrowUpRight, Check, ShieldCheck, Sparkles } from 'lucide-react';
import { demoEmails, emailKey, type Email } from '@/lib/mail';
import { sortInboxEmails } from '@/lib/inbox-priority';

/**
 * Presents at most three high-value inbox highlights and explains whether the content is
 * sample data, an AI summary, or the deterministic fallback.
 */
export function DailyBrief({
  emails,
  connected,
  ai,
  aiConfigured,
  busy,
  updated,
  collapsed,
  onCollapse,
  onSelect,
}: {
  emails: Email[];
  connected: boolean;
  ai: boolean;
  aiConfigured: boolean;
  busy: boolean;
  updated: number | null;
  collapsed: boolean;
  onCollapse: () => void;
  onSelect: (email: Email) => void;
}) {
  // Noise is excluded before sorting so promotions never consume a highlight slot.
  const highlights = sortInboxEmails(
    emails.filter((email) => email.category !== 'noise'),
  ).slice(0, 3);
  const preparing = connected && !updated && busy;
  const lastSync = updated
    ? new Date(updated).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;
  const intro = !connected
    ? 'A few things need you. Everything else can wait.'
    : preparing
      ? 'Reading your Gmail and preparing your first summary…'
      : !updated
        ? 'Your first brief is not ready yet. Select Refresh inbox to try again.'
        : !emails.length
          ? 'Your Gmail inbox is empty.'
          : !highlights.length
            ? 'Your inbox contains newsletters and promotions. Review them in Noise.'
            : ai
              ? 'Here are the highlights from your Gmail inbox.'
              : aiConfigured
                ? 'Your latest Gmail messages. AI summaries are temporarily unavailable.'
                : 'Your latest Gmail messages. AI summaries have not been configured yet.';
  return (
    <section
      className={`briefing-card ${collapsed ? 'briefing-collapsed' : ''}`}
      aria-busy={preparing}
    >
      <div className="card-heading">
        <span className="section-icon">
          <Sparkles size={18} />
        </span>
        <h2>Your daily brief</h2>
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
          <output className="brief-intro">{intro}</output>
          <div className="brief-points">
            {connected ? (
              highlights.map((email) => (
                <button key={emailKey(email)} onClick={() => onSelect(email)}>
                  <span
                    className={`point-dot ${email.priority === 'high' ? 'urgent' : ''}`}
                  />
                  <p>
                    <strong>{email.subject}.</strong> {email.summary}
                  </p>
                  <ArrowUpRight size={16} />
                </button>
              ))
            ) : (
              <>
                <button onClick={() => onSelect(demoEmails[0])}>
                  <span className="point-dot urgent" />
                  <p>
                    <strong>
                      The website launch is ready for your sign-off.
                    </strong>{' '}
                    Sarah needs your approval by <b>2 PM today</b> to keep
                    Thursday’s launch on track.
                  </p>
                  <ArrowUpRight size={16} />
                </button>
                <button onClick={() => onSelect(demoEmails[1])}>
                  <span className="point-dot" />
                  <p>
                    <strong>Two budget items need a second look.</strong> James
                    has shared the revised Q3 budget ahead of tomorrow’s review.
                  </p>
                  <ArrowUpRight size={16} />
                </button>
                <button onClick={() => onSelect(demoEmails[2])}>
                  <span className="point-dot" />
                  <p>
                    <strong>A quick yes or no for Emily.</strong> She’s checking
                    if Thursday at 10 AM works for a project catch-up.
                  </p>
                  <ArrowUpRight size={16} />
                </button>
              </>
            )}
          </div>
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
