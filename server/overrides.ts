import type { Runtime } from './runtime';
import type { Section, Tag } from '@/lib/categories';
import type { Classification, ObligationState } from '@/lib/classification';
import type { NormalizedMessage } from './message';

export type Override={
  messageId:string;
  /** Forced primary section, or undefined to leave the classifier's choice. */
  category?:Section;
  addTags:Tag[];
  removeTags:Tag[];
  notJunk:boolean;
  obligationState?:ObligationState;
  source:'message'|'rule';
  createdAt:number;
};

type Row={message_id:string;category:string|null;add_tags:string;remove_tags:string;not_junk:number;obligation_state:string|null;source:string;created:number};

function toOverride(row:Row):Override{
  return {
    messageId:row.message_id,
    category:(row.category||undefined) as Section|undefined,
    addTags:JSON.parse(row.add_tags) as Tag[],
    removeTags:JSON.parse(row.remove_tags) as Tag[],
    notJunk:!!row.not_junk,
    obligationState:(row.obligation_state||undefined) as ObligationState|undefined,
    source:row.source==='rule'?'rule':'message',
    createdAt:row.created,
  };
}

export async function loadOverrides(user:string,e:Runtime){
  const rows=await e.DB.prepare('SELECT message_id, category, add_tags, remove_tags, not_junk, obligation_state, source, created FROM overrides WHERE user_id = ?').bind(user).all<Row>();
  return new Map((rows.results||[]).map(row=>[row.message_id,toOverride(row)]));
}

export async function saveOverride(user:string,override:Override,e:Runtime){
  await e.DB.prepare(
    'INSERT INTO overrides (user_id,message_id,category,add_tags,remove_tags,not_junk,obligation_state,source,created) VALUES (?,?,?,?,?,?,?,?,?) '+
    'ON CONFLICT(user_id,message_id) DO UPDATE SET category=excluded.category,add_tags=excluded.add_tags,remove_tags=excluded.remove_tags,not_junk=excluded.not_junk,obligation_state=excluded.obligation_state,source=excluded.source,created=excluded.created',
  ).bind(user,override.messageId,override.category||null,JSON.stringify(override.addTags),JSON.stringify(override.removeTags),override.notJunk?1:0,override.obligationState||null,override.source,override.createdAt).run();
}

/** Returning a message to automatic classification removes its correction entirely. */
export async function clearOverride(user:string,messageId:string,e:Runtime){
  await e.DB.prepare('DELETE FROM overrides WHERE user_id = ? AND message_id = ?').bind(user,messageId).run();
}

/**
 * Precedence: an explicit message-level correction wins, then a deliberate user rule,
 * then the validated classifier result. Overrides live in their own table, so syncs,
 * retries and model upgrades never erase them.
 */
export function applyOverride(classification:Classification,override?:Override):Classification{
  if(!override)return classification;
  const next:Classification={...classification,override:{source:override.source,addTags:override.addTags,removeTags:override.removeTags}};
  if(override.notJunk&&next.disposition==='junk')next.disposition='useful';
  if(override.category==='noise')next.disposition='junk';
  else if(override.category){
    next.context=override.category;
    if(next.disposition==='junk')next.disposition='useful';
  }
  if(override.obligationState)next.obligations=next.obligations.map(o=>({...o,state:override.obligationState!}));
  // A correction resolves the message: it is no longer awaiting review.
  next.processingStatus='classified';
  next.reason=override.source==='rule'?'Set by one of your rules.':'You corrected this message.';
  return next;
}

/**
 * Identifies the content a classification was derived from. A changed fingerprint means
 * the stored result no longer applies; an unchanged one means reading or refreshing the
 * message must not trigger reclassification.
 */
export function contentFingerprint(message:Pick<NormalizedMessage,'subject'|'text'|'quoted'|'calendar'>){
  const source=`${message.subject}\u0000${message.text}\u0000${message.quoted}\u0000${message.calendar?.start||''}${message.calendar?.status||''}`;
  let hash=0x811c9dc5;
  for(let i=0;i<source.length;i++){
    hash^=source.charCodeAt(i);
    hash=Math.imul(hash,0x01000193)>>>0;
  }
  return `${source.length.toString(36)}-${hash.toString(36)}`;
}
