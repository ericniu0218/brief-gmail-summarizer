import type { ExtractedDate } from './classification';

/**
 * Conservative date resolver used by email classification. It supports a deliberately
 * small set of phrases and marks everything else ambiguous instead of guessing.
 */

const VAGUE=/\b(soon|asap|as soon as possible|when you can|at your convenience|shortly|sometime|in a bit|no rush)\b/i;
const WEEKDAYS=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];

function iso(year:number,month:number,day:number){
  // UTC construction plus a round-trip check prevents invalid dates rolling forward.
  const date=new Date(Date.UTC(year,month,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month||date.getUTCDate()!==day)return undefined;
  return date.toISOString().slice(0,10);
}

function shift(anchor:Date,days:number){
  return iso(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()+days);
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
  const zone=/\b(UTC|GMT|[A-Z]{2,4}T)\b/.exec(text)?.[1]||timezone;

  // Try supported forms from most explicit to least explicit.
  let date:string|undefined;
  const isoMatch=/\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  const monthMatch=new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map(m=>m.slice(0,3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`,'i').exec(text);
  const relative=/\b(today|tomorrow|(this|next)\s+(\w+day)|(\w+day))\b/i.exec(text);

  if(isoMatch){
    date=iso(Number(isoMatch[1]),Number(isoMatch[2])-1,Number(isoMatch[3]));
  }else if(monthMatch){
    const month=MONTHS.findIndex(name=>name.startsWith(monthMatch[1].slice(0,3).toLowerCase()));
    const year=monthMatch[3]?Number(monthMatch[3]):anchor.getUTCFullYear();
    if(month>=0)date=iso(year,month,Number(monthMatch[2]));
  }else if(relative){
    const term=relative[0].toLowerCase();
    if(term==='today')date=shift(anchor,0);
    else if(term==='tomorrow')date=shift(anchor,1);
    else{
      const weekday=WEEKDAYS.indexOf((relative[3]||relative[4]||'').toLowerCase());
      if(weekday>=0){
        let offset=(weekday-anchor.getUTCDay()+7)%7;
        if(relative[2]?.toLowerCase()==='next'&&offset===0)offset=7;
        if(offset===0)offset=7; // "Friday" sent on a Friday means the coming one.
        date=shift(anchor,offset);
      }
    }
  }

  if(!date)return {...base,reason:clock?'time-without-date':'no-supported-date'};

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
