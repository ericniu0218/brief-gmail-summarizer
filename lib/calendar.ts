import { emailKey, type Email } from './mail';
import { evaluateImportance, obligationDueAt, receivedAtOf } from './importance';
import { isResolved, type Obligation } from './classification';

/**
 * Lightweight calendar helpers for the dashboard. They find date phrases in email text
 * and turn them into local date keys; they do not create or modify calendar events.
 */

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function weekDays(today: Date): Date[] {
  // Convert JavaScript's Sunday-first numbering into a Monday-first dashboard week.
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

/**
 * Whole Monday-start weeks covering the month `date` falls in, so a month grid always has
 * complete rows. Days belonging to the neighbouring months are included; distinguishing
 * them is the caller's job.
 *
 * Days are built from date parts rather than by adding milliseconds, so a daylight-saving
 * change inside the month cannot shift a row by a day.
 */
export function monthGrid(date: Date): Date[] {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const leading = (first.getDay() + 6) % 7;
  const length = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const total = Math.ceil((leading + length) / 7) * 7;
  return Array.from({ length: total }, (_, index) =>
    new Date(first.getFullYear(), first.getMonth(), 1 - leading + index));
}

/**
 * Obligations a calendar should show: still standing, not called off, and carrying a date
 * that resolved. Cancelled and completed work stays readable in its category but is not an
 * upcoming event, and an impossible date is no date at all.
 */
function datedObligations(email: Email): { obligation: Obligation; at: number }[] {
  const obligations = Array.isArray(email.classification?.obligations) ? email.classification.obligations : [];
  return obligations.flatMap(obligation => {
    if (!obligation || typeof obligation !== 'object') return [];
    if (isResolved(obligation) || obligation.meetingState === 'cancelled') return [];
    // The same validated resolver the importance policy uses, so a date rejected there —
    // 30 February, an impossible month — can never reappear here as a real event.
    const at = obligationDueAt(obligation);
    return at === undefined ? [] : [{ obligation, at }];
  });
}

/**
 * Minutes past midnight for this email's earliest event on `key`, when a clock time is
 * known. A date-only obligation has no time and is skipped here; it still appears on the
 * day through `emailDates`.
 *
 * Earliest, not first: an email listing 3 PM before 9 AM describes a day that starts at
 * nine, and returning whichever obligation happened to be written first would order the
 * day wrongly.
 */
export function eventMinutes(email: Email, key: string): number | undefined {
  let earliest: number | undefined;
  for (const { obligation, at } of datedObligations(email)) {
    if (!obligation.due?.time) continue;
    const when = new Date(at);
    if (dateKey(when) !== key) continue;
    const minutes = when.getHours() * 60 + when.getMinutes();
    if (earliest === undefined || minutes < earliest) earliest = minutes;
  }
  return earliest;
}

/**
 * Chronological order within one day: events with a time first, in clock order, then the
 * rest by when they arrived. Dates found in text have no time, so arrival order is the
 * closest to chronological the available data supports, and it keeps the list stable.
 */
export function byEventTime(key: string) {
  return (a: Email, b: Email) => {
    const first = eventMinutes(a, key);
    const second = eventMinutes(b, key);
    if (first !== second) {
      if (first === undefined) return 1;
      if (second === undefined) return -1;
      return first - second;
    }
    const aReceived=receivedAtOf(a),bReceived=receivedAtOf(b);
    if(aReceived!==bReceived){
      if(aReceived===undefined)return 1;
      if(bReceived===undefined)return -1;
      return aReceived-bReceived;
    }
    return emailKey(a).localeCompare(emailKey(b));
  };
}

// Resolve relative dates against the message's date, never the refresh date.
export function emailDates(email: Email, demoDate?: Date): string[] {
  let text = `${email.subject}\n${email.body}`;
  const dates = new Set<string>();
  const anchor = email.receivedAt !== undefined ? new Date(email.receivedAt) : demoDate;
  const validAnchor = anchor && !Number.isNaN(anchor.getTime()) ? anchor : undefined;
  const add = (year: number, month: number, day: number) => {
    // Dates can silently roll into another month, so compare the parts to reject inputs
    // such as February 31.
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) dates.add(dateKey(date));
  };
  // Structured obligations are the most reliable dates an email has, so they are taken
  // whether they carry a clock time or only a date. A timestamp is an absolute instant and
  // is placed on the day it falls on for the viewer, matching eventMinutes and the grid.
  // A date-only obligation names a calendar day directly and is used as written, rather
  // than being pushed a day by the UTC end-of-day the resolver gives it.
  for(const {obligation,at} of datedObligations(email)){
    if(obligation.due?.time){dates.add(dateKey(new Date(at)));continue;}
    const parts=/^(\d{4})-(\d{2})-(\d{2})$/.exec(obligation.due?.date||'');
    if(parts)dates.add(dateKey(new Date(Number(parts[1]),Number(parts[2])-1,Number(parts[3]))));
  }
  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const match of text.matchAll(/\b(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)) {
    const year = match[3] ? Number(match[3]) : validAnchor?.getFullYear();
    if (year) add(year, months.indexOf(match[1].slice(0, 3).toLowerCase()), Number(match[2]));
    text = text.replace(match[0], ' '.repeat(match[0].length));
  }
  if (validAnchor) {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const match of text.matchAll(/\b(today|tomorrow|yesterday|(?:(?:this|next|last)\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/gi)) {
      const term = match[1].toLowerCase().replace(/\s+/g, ' ');
      // Retrospective mentions describe prior context, not scheduled events.
      // Keep matching them so 'last Thursday' cannot fall through as 'Thursday'.
      if (term === 'yesterday' || term.startsWith('last ')) continue;
      let offset = term === 'today' ? 0 : term === 'tomorrow' ? 1 : null;
      if (offset === null) {
        const weekday = weekdays.indexOf(term.split(' ').at(-1)!);
        offset = (weekday - validAnchor.getDay() + 7) % 7;
        if (term.startsWith('next ') && offset === 0) offset = 7;
        if (term.startsWith('this ')) offset = (weekday + 6) % 7 - (validAnchor.getDay() + 6) % 7;
      }
      const day = new Date(validAnchor.getFullYear(), validAnchor.getMonth(), validAnchor.getDate() + offset);
      dates.add(dateKey(day));
    }
  }
  return [...dates];
}

export function nextEmailEvent(emails: Email[], today: Date, demo = false): { email: Email; date: string } | undefined {
  // Ignore Noise, keep today or later, then use the same live importance policy as Inbox.
  const current = dateKey(today);
  const now=today.getTime();
  const event=emails.filter(email => email.category !== 'noise')
    // Score once per email before expanding its dates; the comparator can run O(n log n)
    // times and must remain a cheap comparison of values already derived.
    .map(email=>({email,rank:evaluateImportance(email,now).rank,
      dates:emailDates(email,demo?today:undefined)}))
    .flatMap(item => item.dates.filter(date => date >= current).map(date => ({ email:item.email, date, rank:item.rank })))
    .sort((a, b) => a.date.localeCompare(b.date)
      ||a.rank-b.rank
      ||emailKey(a.email).localeCompare(emailKey(b.email)))[0];
  return event?{email:event.email,date:event.date}:undefined;
}
