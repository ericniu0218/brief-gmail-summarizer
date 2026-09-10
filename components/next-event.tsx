'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { nextEmailEvent } from '@/lib/calendar';

export function NextEvent({ emails, demo, onSelect }: { emails: Email[]; demo: boolean; onSelect: (email: Email) => void }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 60000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);
  const event = now ? nextEmailEvent(emails, now, demo) : undefined;
  return <section className="next-event" aria-label="Next event">
    <h2><CalendarDays size={16}/> Next event</h2>
    {event ? <button type="button" onClick={() => onSelect(event.email)} aria-label={`Open email: ${event.email.subject}`}>
      <span className="next-event-date">{new Date(`${event.date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
      <strong>{event.email.subject}</strong>
      <span className="next-event-summary">{event.email.summary}</span>
      <span className="next-event-footer"><span>{event.email.sender}</span><ArrowUpRight size={14}/></span>
    </button> : <p>{now ? 'No upcoming dates found in your emails.' : 'Finding your next event…'}</p>}
  </section>;
}
