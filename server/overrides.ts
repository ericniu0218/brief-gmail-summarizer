import type { Runtime } from './runtime';
import { HttpError } from './runtime';
import type { Section, Tag } from '@/lib/categories';
import {
  applyPolicy,
  needsReview,
  obligationCorrectionKey,
  type Classification,
  type ObligationState,
} from '@/lib/classification';
import type { NormalizedMessage } from './message';

export type JunkPreference='junk'|'not-junk';
export const MAX_SENDER_ADDRESS=320;

/** Canonical sender key accepted by rules. Invalid or synthetic identities are rejected. */
export function normalizeSenderAddress(value:unknown):string|undefined{
  if(typeof value!=='string')return undefined;
  const address=value.trim().toLowerCase();
  const at=address.indexOf('@');
  let control=false;
  for(let index=0;index<address.length;index++){
    const code=address.charCodeAt(index);
    if(code<=31||code===127){control=true;break;}
  }
  if(!address||address.length>MAX_SENDER_ADDRESS||/\s/.test(address)||control||
    at<=0||at!==address.lastIndexOf('@')||at===address.length-1)return undefined;
  return address;
}
/**
 * A saved preference for one sender inside one account. An inactive rule is a cleared
 * tombstone: it still reports its revision so writes stay ordered, but carries no
 * preference and has no effect on classification.
 */
export type SenderRule={address:string;junkPreference?:JunkPreference;revision:number;active:boolean};

/** The preference a rule actually applies, or nothing when it was cleared. */
export function activeJunkPreference(rule?:SenderRule):JunkPreference|undefined{
  return rule?.active?rule.junkPreference:undefined;
}

/**
 * Persisted user intent for one message. An inactive row is a reset tombstone: it carries
 * no manual decisions, but its revision prevents an older in-flight request from
 * recreating corrections after the user selected “Return to automatic classification”.
 *
 * The legacy fields remain readable while populated databases move to the command model.
 */
export type Override={
  messageId:string;
  category?:Section;
  addTags:Tag[];
  removeTags:Tag[];
  junkPreference?:JunkPreference;
  obligationStates?:Record<string,ObligationState>;
  /** Legacy compatibility: true means not-junk. */
  notJunk?:boolean;
  /** Legacy compatibility: an old correction applied one state to every obligation. */
  obligationState?:ObligationState;
  source:'message'|'rule';
  createdAt:number;
  revision?:number;
  active?:boolean;
};

export type CorrectionAction=
  |{type:'set-section';section:Section}
  |{type:'clear-section'}
  |{type:'set-junk-preference';value:JunkPreference}
  |{type:'clear-junk-preference'}
  |{type:'add-tag';tag:Tag}
  |{type:'remove-tag';tag:Tag}
  |{type:'clear-tag-correction';tag:Tag}
  |{type:'set-obligation-state';obligationKey:string;state:ObligationState}
  |{type:'clear-obligation-state';obligationKey:string}
  |{type:'reset-all'};

type Row={
  message_id:string;category:string|null;add_tags:string;remove_tags:string;
  not_junk:number;obligation_state:string|null;source:string;created:number;
  junk_preference:string|null;obligation_states:string;revision:number;active:number;
};

const SECTIONS:Section[]=['work','personal','noise'];
export const CORRECTABLE_TAGS:Tag[]=['deadlines','meetings','requests','actions','research','low-priority'];
const TAGS:Tag[]=[...CORRECTABLE_TAGS,'junk'];
export const CORRECTABLE_STATES:ObligationState[]=['open','completed','cancelled','superseded','unknown'];
const DERIVED_REVIEW_REASONS=new Set(['junk-with-open-obligation','junk-with-security-event','unclear-task-owner','ambiguous-date','conflicting-dates','classification-failed']);

function parsedTags(value:string):Tag[]{
  try{
    const parsed:unknown=JSON.parse(value);
    return Array.isArray(parsed)?[...new Set(parsed.filter((tag):tag is Tag=>TAGS.includes(tag as Tag)))]:[];
  }catch{return [];}
}

function parsedObligationStates(value:string):Record<string,ObligationState>{
  try{
    const parsed:unknown=JSON.parse(value);
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key,state])=>
      key.length>0&&key.length<=2048&&CORRECTABLE_STATES.includes(state as ObligationState),
    )) as Record<string,ObligationState>;
  }catch{return {};}
}

function normalizedOverride(override:Override):Override&{revision:number;active:boolean;obligationStates:Record<string,ObligationState>}{
  // Legacy clients represented “not junk” as removing the Junk tag. Translate that
  // deliberately so the message cannot remain a tagless item in Noise.
  const junkPreference=override.junkPreference??(override.notJunk||override.removeTags?.includes('junk')?'not-junk':undefined);
  return {...override,
    addTags:[...new Set(override.addTags||[])],removeTags:[...new Set(override.removeTags||[])],
    junkPreference,obligationStates:override.obligationStates||{},
    revision:override.revision??0,active:override.active!==false};
}

function toOverride(row:Row):Override{
  const junkPreference:JunkPreference|undefined=row.junk_preference==='junk'||row.junk_preference==='not-junk'
    ?row.junk_preference:row.not_junk?'not-junk':undefined;
  return {
    messageId:row.message_id,
    category:SECTIONS.includes(row.category as Section)?row.category as Section:undefined,
    addTags:parsedTags(row.add_tags),removeTags:parsedTags(row.remove_tags),junkPreference,
    obligationStates:parsedObligationStates(row.obligation_states),notJunk:junkPreference==='not-junk',
    obligationState:CORRECTABLE_STATES.includes(row.obligation_state as ObligationState)?row.obligation_state as ObligationState:undefined,
    source:row.source==='rule'?'rule':'message',createdAt:row.created,
    revision:Number.isInteger(row.revision)&&row.revision>=0?row.revision:0,active:row.active!==0,
  };
}

const SELECT_COLUMNS='message_id, category, add_tags, remove_tags, not_junk, obligation_state, source, created, junk_preference, obligation_states, revision, active';

/** Corrections are per mailbox, so the same message id in two accounts stays independent. */
export async function loadOverrides(user:string,accountId:string,e:Runtime,messageIds?:string[]){
  if(messageIds){
    const ids=[...new Set(messageIds)].filter(Boolean),result=new Map<string,Override>();
    // Stay below SQLite/D1's bind-variable limit while avoiding a scan of old tombstones
    // and corrections for messages that are not present in this mailbox view.
    for(let i=0;i<ids.length;i+=80){
      const chunk=ids.slice(i,i+80);
      const rows=await e.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM overrides WHERE account_id = ? AND user_id = ? AND message_id IN (${chunk.map(()=>'?').join(',')})`)
        .bind(accountId,user,...chunk).all<Row>();
      for(const row of rows.results||[])result.set(row.message_id,toOverride(row));
    }
    return result;
  }
  const rows=await e.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM overrides WHERE account_id = ? AND user_id = ?`).bind(accountId,user).all<Row>();
  return new Map((rows.results||[]).map(row=>[row.message_id,toOverride(row)]));
}

export async function loadOverride(user:string,accountId:string,messageId:string,e:Runtime){
  const row=await e.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM overrides WHERE account_id = ? AND user_id = ? AND message_id = ?`).bind(accountId,user,messageId).first<Row>();
  return row?toOverride(row):undefined;
}

/**
 * Apply one explicit command to the existing manual intent. Independent decisions are
 * copied forward, while the opposing value for the same tag or disposition is removed.
 */
export function reduceOverride(current:Override|undefined,messageId:string,action:CorrectionAction,now:number):Override{
  const old=normalizedOverride(current||{messageId,addTags:[],removeTags:[],source:'message',createdAt:now,revision:0,active:false});
  const next:Override={...old,messageId,addTags:[...old.addTags],removeTags:[...old.removeTags],
    obligationStates:{...old.obligationStates},source:'message',createdAt:now,revision:old.revision+1,active:true};
  const additions=new Set(next.addTags),removals=new Set(next.removeTags);
  switch(action.type){
    case 'set-section':
      next.category=action.section;
      break;
    case 'clear-section':next.category=undefined;break;
    case 'set-junk-preference':
      next.junkPreference=action.value;
      break;
    case 'clear-junk-preference':next.junkPreference=undefined;break;
    case 'add-tag':additions.add(action.tag);removals.delete(action.tag);break;
    case 'remove-tag':removals.add(action.tag);additions.delete(action.tag);break;
    case 'clear-tag-correction':additions.delete(action.tag);removals.delete(action.tag);break;
    case 'set-obligation-state':next.obligationStates![action.obligationKey]=action.state;break;
    case 'clear-obligation-state':delete next.obligationStates![action.obligationKey];break;
    case 'reset-all':
      next.category=undefined;next.junkPreference=undefined;next.addTags=[];next.removeTags=[];
      next.obligationStates={};next.obligationState=undefined;next.notJunk=false;next.active=false;
      return next;
  }
  next.addTags=[...additions];next.removeTags=[...removals];
  // Keep legacy columns coherent for older application versions during a rolling deploy.
  next.notJunk=next.junkPreference==='not-junk';next.obligationState=undefined;
  return next;
}

/**
 * Compare-and-swap makes a read/modify/write safe. Two requests may read the same row,
 * but only the first can advance its revision; the second receives a conflict instead of
 * silently erasing the first decision. Reset uses the same row rather than deleting it.
 */
export async function applyCorrection(user:string,accountId:string,messageId:string,expectedRevision:number,action:CorrectionAction,e:Runtime){
  const current=await loadOverride(user,accountId,messageId,e);
  const revision=current?.revision??0;
  if(revision!==expectedRevision)throw new HttpError(409,'This message changed in another tab. Reload it and try again.');
  const next=reduceOverride(current,messageId,action,Date.now());
  const values=[next.category||null,JSON.stringify(next.addTags),JSON.stringify(next.removeTags),next.notJunk?1:0,
    next.obligationState||null,next.source,next.createdAt,next.junkPreference||null,JSON.stringify(next.obligationStates||{}),next.revision!,next.active?1:0];
  if(current){
    const result=await e.DB.prepare(
      'UPDATE overrides SET category=?, add_tags=?, remove_tags=?, not_junk=?, obligation_state=?, source=?, created=?, junk_preference=?, obligation_states=?, revision=?, active=? WHERE account_id=? AND user_id=? AND message_id=? AND revision=? AND EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=?)',
    ).bind(...values,accountId,user,messageId,expectedRevision,accountId,user).run();
    if(!result.meta.changes)throw new HttpError(409,'This message changed in another tab. Reload it and try again.');
  }else{
    const result=await e.DB.prepare(
      'INSERT INTO overrides (category,add_tags,remove_tags,not_junk,obligation_state,source,created,junk_preference,obligation_states,revision,active,account_id,user_id,message_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=?) ON CONFLICT(account_id,message_id) DO NOTHING',
    ).bind(...values,accountId,user,messageId,accountId,user).run();
    if(!result.meta.changes)throw new HttpError(409,'This message changed in another tab. Reload it and try again.');
  }
  return next;
}

/**
 * Recover the classifier layer from a stored value. Current snapshots carry it directly;
 * an older snapshot is safe only when it contains no manual-override marker. Conflict
 * policy fields are removed so current policy can be applied again from the proposal.
 */
export function automaticBaseline(classification:Classification|undefined):Classification|undefined{
  if(!classification||classification.override)return undefined;
  const disposition=classification.proposedDisposition??classification.disposition;
  return {...classification,disposition,proposedDisposition:undefined,reviewReason:undefined,
    obligations:Array.isArray(classification.obligations)?classification.obligations.map(obligation=>({...obligation,due:obligation.due?{...obligation.due}:undefined})):[],
    topics:Array.isArray(classification.topics)?[...classification.topics]:[],override:undefined};
}

/**
 * Compose the only displayed result: untouched automatic facts, then manual intent, then
 * current safety/taxonomy policy. Neither input is mutated, so repeated reads are stable.
 */
export function composeClassification(automaticClassification:Classification,manualOverride:Override|undefined,now:number){
  return applyPolicy(applyOverride(automaticClassification,manualOverride),now);
}

/** Safe subset returned to the browser; revisions and ownership remain separate fields. */
export function manualCorrectionView(override:Override|undefined){
  if(!override||override.active===false)return undefined;
  const manual=normalizedOverride(override);
  return {category:manual.category,addTags:[...manual.addTags],removeTags:[...manual.removeTags],
    junkPreference:manual.junkPreference,obligationStates:{...manual.obligationStates}};
}

export async function loadSenderRules(user:string,accountId:string,e:Runtime){
  const rows=await e.DB.prepare('SELECT address,junk_preference,revision,active FROM sender_rules WHERE account_id=? AND user_id=?')
    .bind(accountId,user).all<{address:string;junk_preference:string;revision:number;active:number}>();
  const rules=new Map<string,SenderRule>();
  // Cleared rules stay in the map so their revision is still reported to the browser; only
  // an active row carries a preference, so composition is unaffected by a tombstone.
  for(const row of rows.results||[]){
    const address=normalizeSenderAddress(row.address);
    if(!address)continue;
    const usable=row.junk_preference==='junk'||row.junk_preference==='not-junk';
    const active=row.active!==0&&usable;
    rules.set(address,{address,revision:row.revision,active,
      junkPreference:active?row.junk_preference as JunkPreference:undefined});
  }
  return rules;
}

/** Resolve a rule with the same canonical key used for storage and loading. */
export function senderRuleFor(rules:Map<string,SenderRule>,address:unknown){
  const normalized=normalizeSenderAddress(address);
  return normalized?rules.get(normalized):undefined;
}

/**
 * Message intent wins; a sender rule fills only the Junk dimension it did not set.
 *
 * Two kinds of message-level choice outrank the rule: an explicit Junk or Keep preference,
 * and routing the message to a section other than Noise. Both are deliberate decisions
 * about this message, and a rule about its sender is the more general statement.
 */
export function withSenderRule(manual:Override|undefined,rule:SenderRule|undefined,messageId:string):Override|undefined{
  const preference=activeJunkPreference(rule);
  if(!preference)return manual;
  const routedOut=!!manual?.category&&manual.category!=='noise';
  if(manual?.active!==false&&(manual?.junkPreference||routedOut))return manual;
  if(!manual||manual.active===false)return {messageId,addTags:[],removeTags:[],junkPreference:preference,source:'rule',createdAt:0,active:true,revision:manual?.revision??0};
  return {...manual,junkPreference:preference};
}

/**
 * Save or clear one sender preference under compare-and-swap.
 *
 * Clearing writes an inactive tombstone instead of deleting the row. A delete would
 * restart the revision at zero, which would let a request written before the clear
 * recreate the very rule it was meant to remove. The cleared revision is returned so the
 * browser can keep writing in order.
 */
export async function saveSenderRule(user:string,accountId:string,address:string,expectedRevision:number,value:JunkPreference|undefined,e:Runtime):Promise<SenderRule>{
  const normalized=normalizeSenderAddress(address);
  if(!normalized)throw new HttpError(400,'This message does not have a usable sender address.');
  address=normalized;
  const conflict=()=>new HttpError(409,'This sender preference changed in another tab. Reload and try again.');
  const current=await e.DB.prepare('SELECT junk_preference,revision,active FROM sender_rules WHERE account_id=? AND user_id=? AND address=?')
    .bind(accountId,user,address).first<{junk_preference:string;revision:number;active:number}>();
  if((current?.revision??0)!==expectedRevision)throw conflict();
  const revision=expectedRevision+1,now=Date.now();

  if(value===undefined){
    // Nothing was ever saved for this sender, so there is nothing to clear and no new
    // revision to report. Staying idempotent here keeps a repeated Undo harmless.
    if(!current)return {address,revision:expectedRevision,active:false};
    const result=await e.DB.prepare('UPDATE sender_rules SET active=0,revision=?,updated=? WHERE account_id=? AND user_id=? AND address=? AND revision=?')
      .bind(revision,now,accountId,user,address,expectedRevision).run();
    if(!result.meta.changes)throw conflict();
    return {address,revision,active:false};
  }

  if(current){
    const result=await e.DB.prepare('UPDATE sender_rules SET junk_preference=?,revision=?,updated=?,active=1 WHERE account_id=? AND user_id=? AND address=? AND revision=?')
      .bind(value,revision,now,accountId,user,address,expectedRevision).run();
    if(!result.meta.changes)throw conflict();
  }else{
    // The ownership check rides inside the insert so a foreign account id cannot create a
    // rule, and the conflict clause makes two racing inserts produce one winner.
    const result=await e.DB.prepare('INSERT INTO sender_rules (user_id,account_id,address,junk_preference,revision,updated,active) SELECT ?,?,?,?,?,?,1 WHERE EXISTS (SELECT 1 FROM connections WHERE id=? AND user_id=?) ON CONFLICT(account_id,address) DO NOTHING')
      .bind(user,accountId,address,value,revision,now,accountId,user).run();
    if(!result.meta.changes)throw conflict();
  }
  return {address,junkPreference:value,revision,active:true};
}

/** Apply manual intent to a fresh copy of the automatic result. */
export function applyOverride(classification:Classification,override?:Override):Classification{
  const base=automaticBaseline(classification)??{...classification,override:undefined,
    obligations:Array.isArray(classification.obligations)?classification.obligations.map(o=>({...o,due:o.due?{...o.due}:undefined})):[],
    topics:Array.isArray(classification.topics)?[...classification.topics]:[]};
  if(!override||override.active===false)return base;
  const manual=normalizedOverride(override);
  const next:Classification={...base,override:{source:manual.source,category:manual.category,
    addTags:[...manual.addTags],removeTags:[...manual.removeTags],junkPreference:manual.junkPreference}};
  if(manual.junkPreference==='not-junk'&&next.disposition==='junk')next.disposition='useful';
  if(manual.junkPreference==='junk'||manual.category==='noise')next.disposition='junk';
  else if(manual.category){next.context=manual.category;if(next.disposition==='junk')next.disposition='useful';}

  const keyed=Object.entries(manual.obligationStates||{});
  const counts=new Map<string,number>();
  for(const obligation of next.obligations){const key=obligationCorrectionKey(obligation);counts.set(key,(counts.get(key)||0)+1);}
  let unmatched=false;
  next.obligations=next.obligations.map(obligation=>{
    const key=obligationCorrectionKey(obligation),state=manual.obligationStates?.[key];
    if(!state||counts.get(key)!==1)return {...obligation};
    // Meeting lifecycle has two fields. Keep them coherent so reopening an automatically
    // cancelled meeting works and a manual cancellation is not displayed as confirmed.
    const meetingState=obligation.kind!=='meeting'?obligation.meetingState
      :state==='cancelled'?'cancelled'
      :state==='open'&&obligation.meetingState==='cancelled'?'proposed'
      :obligation.meetingState;
    return {...obligation,state,meetingState};
  });
  for(const [key] of keyed)if(counts.get(key)!==1)unmatched=true;
  // Old rows used one state for every task. Preserve that behavior until the user makes
  // an individual task correction or resets the message.
  if(manual.obligationState&&!keyed.length)next.obligations=next.obligations.map(o=>({...o,state:manual.obligationState!}));
  // A correction in one dimension must not clear an unrelated ambiguous date, ownership
  // question, provider failure, or security review. Recalculate structural reasons and
  // clear only a derived reason that the correction truly resolved.
  const remainingReview=needsReview(next);
  if(remainingReview){next.processingStatus='needs_review';next.uncertainty=remainingReview;}
  else if(next.processingStatus==='needs_review'&&next.uncertainty&&DERIVED_REVIEW_REASONS.has(next.uncertainty)){
    next.processingStatus='classified';next.uncertainty=undefined;
  }
  if(unmatched){next.processingStatus='needs_review';next.uncertainty='manual-obligation-unmatched';}
  return next;
}

/** Identifies content that an automatic classification was derived from. */
export function contentFingerprint(message:Pick<NormalizedMessage,'subject'|'text'|'quoted'|'calendar'>){
  const source=`${message.subject}\u0000${message.text}\u0000${message.quoted}\u0000${message.calendar?.start||''}${message.calendar?.status||''}`;
  let hash=0x811c9dc5;
  for(let i=0;i<source.length;i++){hash^=source.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
  return `${source.length.toString(36)}-${hash.toString(36)}`;
}
