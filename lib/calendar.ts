import { emailKey, type Email } from './mail';
import { evaluateImportance, IMPORTANCE, obligationDueAt, receivedAtOf } from './importance';
import { isResolved, type Obligation } from './classification';
import { inferYear, weekdayOffset } from './dates';

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
    // An offer's expiry or a promotional webinar is not an event in the reader's week.
    if (obligation.commercial) return [];
    // The same validated resolver the importance policy uses, so a date rejected there —
    // 30 February, an impossible month — can never reappear here as a real event.
    let at=obligationDueAt(obligation);
    // A written wall-clock time with no timezone still belongs on its stated day.
    // This date is for calendar placement only, never an inferred due instant.
    if(at===undefined&&obligation.due?.reason==='timezone-unknown') {
      const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(obligation.due.date||'');
      if(match){
        const year=Number(match[1]),month=Number(match[2])-1,day=Number(match[3]);
        const candidate=new Date(Date.UTC(year,month,day,12));
        if(candidate.getUTCFullYear()===year&&candidate.getUTCMonth()===month&&candidate.getUTCDate()===day)at=candidate.getTime();
      }
    }
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
function writtenClock(phrase:string):number|undefined{
  const match=/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(phrase);
  if(!match)return undefined;
  const hour=Number(match[1]),minute=Number(match[2]||0);
  if(hour<1||hour>12||minute>59)return undefined;
  return (hour%12+(match[3].toLowerCase()==='pm'?12:0))*60+minute;
}

export function eventMinutes(email: Email, key: string): number | undefined {
  let earliest: number | undefined;
  for (const { obligation, at } of datedObligations(email)) {
    const due=obligation.due;
    if (!due) continue;
    const when=new Date(at);
    const minutes=due.time&&dateKey(when)===key?when.getHours()*60+when.getMinutes()
      :!due.time&&due.date===key?writtenClock(due.phrase):undefined;
    if(minutes===undefined)continue;
    if (earliest === undefined || minutes < earliest) earliest = minutes;
  }
  return earliest;
}

/**
 * Chronological order within one day: events with a time first, in clock order, then the
 * rest by when they arrived. Dates found in text have no time, so arrival order is the
 * closest to chronological the available data supports, and it keeps the list stable.
 */
export function byEventTime(key: string,now:number) {
  return (a: Email, b: Email) => {
    const first = eventMinutes(a, key);
    const second = eventMinutes(b, key);
    if (first !== second) {
      if (first === undefined) return 1;
      if (second === undefined) return -1;
      return first - second;
    }
    const aReceived=receivedAtOf(a,now),bReceived=receivedAtOf(b,now);
    if(aReceived!==bReceived){
      if(aReceived===undefined)return 1;
      if(bReceived===undefined)return -1;
      return aReceived-bReceived;
    }
    return emailKey(a).localeCompare(emailKey(b));
  };
}

// Resolve relative dates against the message's date, never the refresh date.
export function emailDates(email: Email, demoDate?: Date, now?: number): string[] {
  let text = `${email.subject}\n${email.body}`;
  const dates = new Set<string>();
  const anchor = email.receivedAt !== undefined ? new Date(email.receivedAt) : demoDate;
  // "Tomorrow" means nothing without a trustworthy arrival date. An implausibly future
  // timestamp would otherwise invent an event a year out, so relative phrases are refused
  // rather than anchored to it. Dates the message states outright are unaffected.
  const plausible = !!anchor && !Number.isNaN(anchor.getTime())
    && (now === undefined || anchor.getTime() <= now + IMPORTANCE.futureSkew);
  const validAnchor = plausible ? anchor : undefined;
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
  // The classification is the authority on what was called off. The text scan below is a
  // fallback for dates no obligation captured, so it must not find a cancelled or finished
  // obligation's own sentence and date again and put the event back. Other sentences, and
  // any live event in them, are scanned as before.
  const obligations = Array.isArray(email.classification?.obligations) ? email.classification.obligations : [];
  for (const obligation of obligations) {
    if (!obligation || typeof obligation !== 'object') continue;
    if (!isResolved(obligation) && obligation.meetingState !== 'cancelled' && !obligation.commercial) continue;
    // Its own sentence always; its date phrase only when that names a specific date. A bare
    // "Friday" or "tomorrow" removed everywhere would take a live event elsewhere with it.
    const phrase = obligation.due?.phrase;
    for (const retired of [obligation.evidence, typeof phrase === 'string' && /\d/.test(phrase) ? phrase : undefined])
      if (typeof retired === 'string' && retired.trim()) text = text.split(retired.trim()).join(' ');
  }
  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) add(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  for (const match of text.matchAll(/\b(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[,\s]+)?(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)) {
    const month = months.indexOf(match[1].slice(0, 3).toLowerCase()), day = Number(match[2]);
    // The same year rule as the resolver: "January 2" in mail from 31 December is next
    // January, and a date that could be either year is not placed at all.
    const inferred = match[3] ? { year: Number(match[3]), uncertain: false }
      : validAnchor ? inferYear(month, day, validAnchor.getTime()) : undefined;
    if (inferred && !inferred.uncertain) add(inferred.year, month, day);
    text = text.replace(match[0], ' '.repeat(match[0].length));
  }
  if (validAnchor) {
    for (const match of text.matchAll(/\b(today|tomorrow|yesterday|(?:(?:this|next|last)\s+)?(?<!\bpast\s+)(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))\b/gi)) {
      const term = match[1].toLowerCase().replace(/\s+/g, ' ');
      // Retrospective mentions describe prior context, not scheduled events.
      // Keep matching them so 'last Thursday' cannot fall through as 'Thursday'.
      if (term === 'yesterday' || term.startsWith('last ')) continue;
      // Shared with the resolver, so sorting and the calendar agree on which day it is.
      const offset = term === 'today' ? 0 : term === 'tomorrow' ? 1 : weekdayOffset(term, validAnchor.getDay());
      if (offset === undefined) continue;
      const day = new Date(validAnchor.getFullYear(), validAnchor.getMonth(), validAnchor.getDate() + offset);
      dates.add(dateKey(day));
    }
  }
  return [...dates];
}

export function nextEmailEvent(emails: Email[], today: Date, demo = false): { email: Email; date: string } | undefined {
  // Ignore Noise, keep today or later, then use the same live importance policy as Inbox.
  const current = dateKey(today);
  const horizonDate=new Date(today);
  // Long-range academic and renewal notices can legitimately arrive more than a year
  // early. Five years preserves those while still excluding absurd sentinel dates.
  horizonDate.setFullYear(horizonDate.getFullYear()+5);
  const horizon=dateKey(horizonDate);
  const now=today.getTime();
  const event=emails.filter(email => email.category !== 'noise')
    // Score once per email before expanding its dates; the comparator can run O(n log n)
    // times and must remain a cheap comparison of values already derived.
    .map(email=>({email,rank:evaluateImportance(email,now).rank,
      dates:emailDates(email,demo?today:undefined,now)}))
    .flatMap(item => item.dates.filter(date => date >= current&&date<=horizon).map(date => ({ email:item.email, date, rank:item.rank })))
    .sort((a, b) => a.date.localeCompare(b.date)
      ||a.rank-b.rank
      ||emailKey(a.email).localeCompare(emailKey(b.email)))[0];
  return event?{email:event.email,date:event.date}:undefined;
}
