import type { ExtractedDate } from './classification';

/**
 * Conservative date resolver used by email classification. It supports a deliberately
 * small set of phrases and marks everything else ambiguous instead of guessing.
 */

const VAGUE=/\b(soon|asap|as soon as possible|when you can|at your convenience|shortly|sometime|in a bit|no rush)\b/i;
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];

function iso(year:number,month:number,day:number){
  // UTC construction plus a round-trip check prevents invalid dates rolling forward.
  const date=new Date(Date.UTC(year,month,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month||date.getUTCDate()!==day)return undefined;
  return date.toISOString().slice(0,10);
}

/**
 * Calendar arithmetic, deliberately separate from validating a written date. "Tomorrow" on
 * 30 September is 1 October: the day number overflows and the month rolls over. Passing
 * that through the strict validator (which exists to reject a written 31 February) made
 * every relative phrase fail on the last day of each month.
 */
function shift(anchor:Date,days:number){
  return new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()+days)).toISOString().slice(0,10);
}

export const WEEKDAY_NAMES=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'] as const;

/**
 * Days from `anchorDay` (0 = Sunday) to the weekday named by `term`, shared by the resolver
 * and the calendar so they can never place the same phrase on different days.
 *
 *   - "this Friday" said on a Friday is today.
 *   - a bare "Friday" said on a Friday means the coming one, a week ahead.
 *   - "next Friday" is never today; otherwise it is the coming Friday.
 *
 * Returns undefined for anything that is not a weekday phrase.
 */
export function weekdayOffset(term:string,anchorDay:number):number|undefined{
  const words=term.trim().toLowerCase().split(/\s+/);
  const weekday=WEEKDAY_NAMES.indexOf(words.at(-1) as typeof WEEKDAY_NAMES[number]);
  if(weekday<0||words.length>2)return undefined;
  const qualifier=words.length===2?words[0]:'';
  if(qualifier&&qualifier!=='this'&&qualifier!=='next')return undefined;
  const offset=(weekday-anchorDay+7)%7;
  if(offset===0)return qualifier==='this'?0:7;
  return offset;
}

const DAY=86400000;
/**
 * The year a date written without one most plausibly means, and whether that is certain.
 *
 * Mail is mostly about the near future and the recent past. A date up to a month before
 * arrival keeps the arrival year ("the meeting on September 15" in an October recap). A
 * date that would otherwise be long past but falls within about three months of arrival
 * in the next year belongs to that year ("January 2" in mail sent on 31 December). Anything
 * further either way could be either year, so it keeps the arrival year and is reported as
 * uncertain rather than confidently placed.
 */
export function inferYear(month:number,day:number,receivedAt:number):{year:number;uncertain:boolean}{
  const anchor=new Date(receivedAt);
  const year=anchor.getUTCFullYear();
  const start=Date.UTC(year,anchor.getUTCMonth(),anchor.getUTCDate());
  const same=Date.UTC(year,month,day);
  if(same>=start-31*DAY)return {year,uncertain:false};
  if(Date.UTC(year+1,month,day)-start<=92*DAY)return {year:year+1,uncertain:false};
  return {year,uncertain:true};
}

/**
 * Resolve a date phrase against the message's own timestamp, never the refresh time.
 * The original wording is always preserved, a date-only deadline never gains an invented
 * time, and anything unresolved stays ambiguous rather than being guessed.
 */
export function resolveDate(phrase:string,receivedAt:number,timezone?:string):ExtractedDate{
  const text=phrase.trim();
  const base:ExtractedDate={phrase:text,ambiguous:true};
  if(!text)return {...base,reason:'empty-phrase'};
  if(VAGUE.test(text))return {...base,reason:'vague-phrase'};

  const anchor=new Date(receivedAt);
  if(Number.isNaN(anchor.getTime()))return {...base,reason:'invalid-anchor'};

  const clock=/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text)||/\b(\d{1,2}):(\d{2})\b/.exec(text);
  // A 12-hour clock runs from 1 to 12; "13pm" and "0am" are not times at all.
  if(clock?.[3]&&(Number(clock[1])<1||Number(clock[1])>12))return {...base,reason:'invalid-time'};
  const zone=/\b(UTC|GMT|[A-Z]{2,4}T)\b/.exec(text)?.[1]||timezone;

  // Try supported forms from most explicit to least explicit.
  let date:string|undefined;
  const isoMatch=/\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  const monthMatch=new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map(m=>m.slice(0,3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,'i').exec(text);
  // Weekday names are listed: "\w+day" also matches "birthday", "holiday" and "someday".
  const weekdays=WEEKDAY_NAMES.join('|');
  // "Last Friday" and "this past Friday" look back; they are never the coming Friday.
  const relative=new RegExp(`\\b(today|tomorrow|(?:(?:this|next)\\s+)?(?<!\\b(?:last|past)\\s+)(?:${weekdays}))\\b`,'i').exec(text);
  if(!relative&&new RegExp(`\\b(?:last|past)\\s+(?:${weekdays})\\b`,'i').test(text)&&!isoMatch&&!monthMatch)
    return {...base,reason:'past-reference'};
  let yearUncertain=false;

  if(isoMatch){
    date=iso(Number(isoMatch[1]),Number(isoMatch[2])-1,Number(isoMatch[3]));
  }else if(monthMatch){
    const month=MONTHS.findIndex(name=>name.startsWith(monthMatch[1].slice(0,3).toLowerCase()));
    const day=Number(monthMatch[2]);
    const inferred=monthMatch[3]?{year:Number(monthMatch[3]),uncertain:false}:inferYear(month,day,receivedAt);
    yearUncertain=inferred.uncertain;
    if(month>=0)date=iso(inferred.year,month,day);
  }else if(relative){
    const term=relative[0].toLowerCase();
    if(term==='today')date=shift(anchor,0);
    else if(term==='tomorrow')date=shift(anchor,1);
    else{
      const offset=weekdayOffset(term,anchor.getUTCDay());
      if(offset!==undefined)date=shift(anchor,offset);
    }
  }

  if(!date)return {...base,reason:clock?'time-without-date':'no-supported-date'};
  // The day is known but not which year's: keep it for context, claim nothing from it.
  if(yearUncertain)return {phrase:text,date,ambiguous:true,reason:'year-uncertain'};

  // A clock time without a stated timezone changes meaning, so it is not silently resolved.
  if(clock&&!zone)return {phrase:text,date,ambiguous:true,reason:'timezone-unknown'};
  if(clock&&zone){
    let hour=Number(clock[1]);
    const minute=Number(clock[2]||0);
    const meridiem=clock[3]?.toLowerCase();
    if(meridiem==='pm'&&hour<12)hour+=12;
    if(meridiem==='am'&&hour===12)hour=0;
    if(hour<24&&minute<60&&(zone==='UTC'||zone==='GMT')){
      return {phrase:text,date,time:`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`,timezone:zone,ambiguous:false};
    }
    return {phrase:text,date,timezone:zone,ambiguous:true,reason:'timezone-not-supported'};
  }
  // Date-only deadlines keep no invented time.
  return {phrase:text,date,ambiguous:false};
}
