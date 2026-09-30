'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { byEventTime, dateKey, emailDates, eventMinutes, monthGrid, weekDays } from '@/lib/calendar';

type CalendarMode = 'day' | 'week' | 'month';
const MODES: { id: CalendarMode; name: string }[] = [
  { id: 'day', name: 'Day' },
  { id: 'week', name: 'Week' },
  { id: 'month', name: 'Month' },
];
const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * One day's mail as compact bullets.
 *
 * Each row is a single line, because a subject wrapped over three lines turns a short day
 * into a page of text. Pressing a bullet expands it in place for the sender and summary;
 * the arrow beside it is a separate control that opens the message itself, so browsing
 * the day and leaving it are never the same click.
 */
function AgendaItem({email,day,expanded,onToggle,onSelect}:{email:Email;day:string;expanded:boolean;onToggle:()=>void;onSelect:(email:Email)=>void}){
  // React supplies a unique, hydration-safe relationship between this disclosure button
  // and its detail panel. Sanitising message keys could make distinct keys collide.
  const detailId=`agenda-detail-${useId().replace(/:/g,'')}`;
  const minutes=eventMinutes(email,day);
  const statedTime=minutes===undefined?'':new Date(2020,0,1,Math.floor(minutes/60),minutes%60)
    .toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
  return <li>
    <div className="calendar-agenda-row">
      <button type="button" className="calendar-agenda-summary" aria-expanded={expanded} aria-controls={detailId}
        onClick={onToggle}>{email.subject}</button>
      {statedTime&&<small className="calendar-agenda-time">{statedTime}</small>}
      <button type="button" className="calendar-agenda-open" aria-label={`Open ${email.subject}`}
        onClick={() => onSelect(email)}><ArrowUpRight size={14}/></button>
    </div>
    {expanded && <div className="calendar-agenda-detail" id={detailId}>
      <strong>{email.sender}</strong>
      {email.summary && <p>{email.summary}</p>}
    </div>}
  </li>;
}

function AgendaList({ items, day, onSelect }: { items: Email[]; day:string; onSelect: (email: Email) => void }) {
  // One open at a time: the card is narrow, and keeping several expanded would undo the
  // compactness this list exists for.
  const [open, setOpen] = useState<string | null>(null);
  return <ul className="calendar-agenda-list">
    {items.map(email => {
      const key = emailKey(email);
      const expanded = open === key;
      return <AgendaItem key={key} email={email} day={day} expanded={expanded}
        onToggle={() => setOpen(expanded ? null : key)} onSelect={onSelect}/>;
    })}
  </ul>;
}

/**
 * Email agenda for a day, a week or a month. It reads dates out of message text and never
 * creates or changes a calendar event.
 *
 * Day and week list their mail directly. Month shows only density, because a month of
 * subjects cannot fit the card; clicking a date opens that day's events beside the grid.
 */
export function WeekCalendar({ emails, demo, onSelect }: { emails: Email[]; demo: boolean; onSelect: (email: Email) => void }) {
  const [today, setToday] = useState<Date | null>(null);
  const [mode, setMode] = useState<CalendarMode>('week');
  // The period on screen. Null follows the current date, so the card stays on today until
  // the reader deliberately moves away from it.
  const [cursor, setCursor] = useState<Date | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  useEffect(() => {
    const update = () => setToday(new Date());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 60000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    // Both the day panel and the range menu sit over other content, so Escape dismisses
    // whichever is open, as any layer of this kind should.
    const open = rangeOpen || (mode === 'month' && !!selected);
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRangeOpen(false);
      setSelected(null);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [mode, selected, rangeOpen]);
  const demoAnchor=demo?today?.getTime():undefined;
  // Gmail arrival times cannot be in the future. Use the real clock here rather than the
  // end of the day, which used to admit forged messages almost 24 hours early.
  const arrivalNow=today?.getTime();
  // Connected mail contains absolute dates, so a minute clock tick cannot change this
  // parsing work. Demo relative dates deliberately refresh when their anchor changes.
  const dated=useMemo(()=>emails.filter(email=>email.category!=='noise').map(email=>({
    email,dates:emailDates(email,demoAnchor===undefined?undefined:new Date(demoAnchor),arrivalNow),
  })),[emails,demoAnchor,arrivalNow]);
  if (!today) return <section className="week-calendar" aria-label="Email calendar"><h2><CalendarDays size={16}/> Calendar</h2></section>;

  const focus = cursor || today;
  const todayKey = dateKey(today);
  const week = weekDays(focus);
  // Reuse parsed dates for every day's count and list.
  const matches = (key: string) => dated.filter(item => item.dates.includes(key)).map(item => item.email);
  const listFor = (key: string) => matches(key).sort(byEventTime(key,today.getTime()));

  function shift(direction: number) {
    const next = new Date(focus.getFullYear(), focus.getMonth(), focus.getDate());
    if (mode === 'day') next.setDate(next.getDate() + direction);
    else if (mode === 'week') next.setDate(next.getDate() + 7 * direction);
    // Setting the day to 1 alongside the month stops the 31st of a long month from
    // rolling into the month after the one being moved to.
    else next.setMonth(next.getMonth() + direction, 1);
    setCursor(next);
    setSelected(null);
  }

  const range = (day: Date) => day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const span = `${range(week[0])} – ${range(week[6])}`;
  // The week the reader is on is worth stating plainly; once they step away from it the
  // heading has to say which week it is instead.
  const thisWeek = week.some(day => dateKey(day) === todayKey);
  const title = mode === 'day' ? focus.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : mode === 'week' ? (thisWeek ? 'This week' : span)
    : focus.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Week keeps its chosen day; day always describes the date it is showing.
  const agendaKey = mode === 'day' || !selected || !week.some(day => dateKey(day) === selected) ? dateKey(focus) : selected;
  const agenda = listFor(agendaKey);
  const agendaDate = week.find(day => dateKey(day) === agendaKey) || focus;
  const grid = monthGrid(focus);
  const openDay = selected ? grid.find(day => dateKey(day) === selected) : undefined;
  const openEvents = selected ? listFor(selected) : [];

  return <section className="week-calendar" aria-label="Email calendar">
    <div className="week-calendar-heading">
      {/* The heading is the range control: it already names the period on screen, so
          pressing it to change that period needs no second button beside it. */}
      <h2>
        <button type="button" className="calendar-range" aria-haspopup="menu" aria-expanded={rangeOpen}
          onClick={() => setRangeOpen(open => !open)}>
          <CalendarDays size={16}/><span>{title}</span><ChevronDown size={13} className="calendar-range-caret"/>
        </button>
        {rangeOpen && <ul className="calendar-range-menu" role="menu">
          {MODES.map(option => <li key={option.id} role="none">
            <button type="button" role="menuitem" aria-current={mode === option.id || undefined}
              onClick={() => { setMode(option.id); setSelected(null); setRangeOpen(false); }}>{option.name}</button>
          </li>)}
        </ul>}
      </h2>
      <div className="calendar-heading-right">
        {/* Every range steps. The dates a week covers are shown by the day buttons below,
            so the heading names the week instead of repeating them, which is what leaves
            room for the stepper on one line. */}
        <div className="calendar-nav">
          <button type="button" aria-label={`Previous ${mode}`} onClick={() => shift(-1)}><ChevronLeft size={14}/></button>
          <button type="button" aria-label={`Next ${mode}`} onClick={() => shift(1)}><ChevronRight size={14}/></button>
        </div>
      </div>
    </div>

    {mode === 'week' && <div className="week-calendar-days">{week.map(day => {
      const key = dateKey(day);
      const count = matches(key).length;
      return <button key={key} type="button" aria-pressed={agendaKey === key} aria-current={key === todayKey ? 'date' : undefined} aria-label={`${day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${count} related emails`} onClick={() => setSelected(key)}>
        <span>{day.toLocaleDateString('en-US', { weekday: 'narrow' })}</span><strong>{day.getDate()}</strong><span className={`calendar-dot ${count ? 'has-mail' : ''}`} aria-hidden="true"/>
      </button>;
    })}</div>}

    {mode === 'month' && <div className="calendar-month">
      <div className="calendar-weekdays" aria-hidden="true">{WEEKDAY_INITIALS.map((letter, index) => <span key={index}>{letter}</span>)}</div>
      <div className="week-calendar-days calendar-month-grid">{grid.map(day => {
        const key = dateKey(day);
        const count = matches(key).length;
        return <button key={key} type="button"
          data-outside={day.getMonth() !== focus.getMonth() || undefined}
          aria-pressed={selected === key}
          aria-current={key === todayKey ? 'date' : undefined}
          aria-label={`${day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}, ${count} ${count === 1 ? 'event' : 'events'}`}
          onClick={() => setSelected(selected === key ? null : key)}>
          <strong>{day.getDate()}</strong><span className={`calendar-dot ${count ? 'has-mail' : ''}`} aria-hidden="true"/>
        </button>;
      })}</div>
      {openDay && <section className="calendar-popup" aria-label={`Events on ${openDay.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`}>
        <div className="calendar-popup-heading">
          <strong>{openDay.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</strong>
          <button type="button" aria-label="Close day" onClick={() => setSelected(null)}><X size={13}/></button>
        </div>
        {openEvents.length ? <AgendaList items={openEvents} day={selected||''} onSelect={onSelect}/> : <p>No events on this day.</p>}
      </section>}
    </div>}

    {mode !== 'month' && <div className="calendar-agenda" aria-live="polite">
      <h3>{agendaDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</h3>
      {agenda.length ? <AgendaList items={agenda} day={agendaKey} onSelect={onSelect}/> : <p>No dated emails for this day.</p>}
    </div>}
  </section>;
}
