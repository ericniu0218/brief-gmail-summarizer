import type { Email } from './mail';

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function weekDays(today: Date): Date[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

// Resolve relative dates against the message's date, never the refresh date.
export function emailDates(email: Email, demoDate?: Date): string[] {
  let text = `${email.subject}\n${email.body}`;
  const dates = new Set<string>();
  const anchor = email.receivedAt !== undefined ? new Date(email.receivedAt) : demoDate;
  const validAnchor = anchor && !Number.isNaN(anchor.getTime()) ? anchor : undefined;
  const add = (year: number, month: number, day: number) => {
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) dates.add(dateKey(date));
  };
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
  const current = dateKey(today);
  return emails.filter(email => email.category !== 'noise')
    .flatMap(email => emailDates(email, demo ? today : undefined).filter(date => date >= current).map(date => ({ email, date })))
    .sort((a, b) => a.date.localeCompare(b.date) || Number(b.email.priority === 'high') - Number(a.email.priority === 'high'))[0];
}
