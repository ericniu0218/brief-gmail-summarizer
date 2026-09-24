'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { dateKey, emailDates, weekDays } from '@/lib/calendar';

/** Seven-day email agenda derived from date phrases; it never writes to a calendar. */
export function WeekCalendar({ emails, demo, onSelect }: { emails: Email[]; demo: boolean; onSelect: (email: Email) => void }) {
  const [today, setToday] = useState<Date | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setToday(new Date());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 60000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);
  if (!today) return <section className="week-calendar" aria-label="This week"><h2><CalendarDays size={16}/> This week</h2></section>;
  const days = weekDays(today);
  const active = days.find(day => dateKey(day) === selected) || today;
  const activeKey = dateKey(active);
  // Parse each visible message once, then reuse those dates for day counts and the agenda.
  const dated = emails.filter(email => email.category !== 'noise').map(email => ({ email, dates: emailDates(email, demo ? today : undefined) }));
  const matches = (day: Date) => dated.filter(item => item.dates.includes(dateKey(day)));
  const items = matches(active);
  return <section className="week-calendar" aria-label="This week">
    <div className="week-calendar-heading"><h2><CalendarDays size={16}/> This week</h2><span>{days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span></div>
    <div className="week-calendar-days">{days.map(day => {
      const key = dateKey(day);
      const count = matches(day).length;
      return <button key={key} type="button" aria-pressed={activeKey === key} aria-current={key === dateKey(today) ? 'date' : undefined} aria-label={`${day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${count} related emails`} onClick={() => setSelected(key)}>
        <span>{day.toLocaleDateString('en-US', { weekday: 'narrow' })}</span><strong>{day.getDate()}</strong><span className={`calendar-dot ${count ? 'has-mail' : ''}`} aria-hidden="true"/>
      </button>;
    })}</div>
    <div className="calendar-agenda" aria-live="polite"><h3>{active.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
      {items.length ? items.map(({ email }) => <button type="button" key={emailKey(email)} onClick={() => onSelect(email)}><span><strong>{email.subject}</strong><small>{email.sender}</small></span><ArrowUpRight size={14}/></button>) : <p>No dated emails for this day.</p>}
    </div>
  </section>;
}
