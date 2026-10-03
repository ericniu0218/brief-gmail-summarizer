import type { StoredEmail } from './sync';
import type { Runtime } from './runtime';
import { asCapability } from '@/lib/unsubscribe';
import { gmailSignals } from '@/lib/gmail-signals';

type Row={data:string;replied?:number};

/**
 * Whether a record shows a reply sent before the dedicated `replied` marker existed.
 *
 * Every writer derives the stored badge from the stored classification, except a successful
 * send, which cleared the badge alone. So a record whose badge is off while its own
 * classification says a reply is owed was answered. A record written consistently — which
 * is every one not touched by a send — never matches, so nothing unanswered is hidden.
 */
export function sentBeforeMarker(email:{needsReply?:unknown;classification?:{replyRequired?:unknown}}|undefined){
  return !!email&&email.needsReply===false&&email.classification?.replyRequired===true;
}

/**
 * The same test on stored JSON as written. Completing a damaged record turns a *missing*
 * badge into `false`, which is not evidence of anything, so only an explicit `false` counts.
 */
function rawSentBeforeMarker(data:string){
  try{return sentBeforeMarker(JSON.parse(data) as Parameters<typeof sentBeforeMarker>[0]);}catch{return false;}
}

/** Ids in a stored snapshot, as written, whose records show a send before the marker. */
export function snapshotSentIds(data:string|undefined){
  const ids=new Set<string>();
  try{
    const emails=(JSON.parse(data||'{}') as {emails?:unknown}).emails;
    for(const email of Array.isArray(emails)?emails:[])
      if(email&&typeof email==='object'&&typeof (email as {id?:unknown}).id==='string'&&sentBeforeMarker(email as Parameters<typeof sentBeforeMarker>[0]))
        ids.add((email as {id:string}).id);
  }catch{/* A damaged snapshot proves nothing. */}
  return ids;
}

function emailFromRow(row:Row){
  const email=parseStoredEmail(row.data);
  return email&&(row.replied||(sentBeforeMarker(email)&&rawSentBeforeMarker(row.data)))?{...email,needsReply:false,replied:true}:email;
}

/**
 * Fill the fields the interface reads without checking, so a record written by an older
 * version or damaged in storage cannot crash a render. Only fields where a default is
 * honest get one: an unknown sender is labelled as such rather than invented, and nothing
 * here supplies a date, a classification or an account.
 *
 * A record with no id is beyond repair and is dropped; every other field has a safe
 * stand-in, which is why the message stays readable instead of disappearing.
 */
export function completeStoredEmail(value:unknown):StoredEmail|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const email=value as Partial<StoredEmail>;
  if(typeof email.id!=='string'||!email.id)return undefined;
  const text=(candidate:unknown,fallback='')=>typeof candidate==='string'?candidate:fallback;
  const category=email.category==='work'||email.category==='personal'||email.category==='noise'?email.category:'personal';
  return {...email,
    id:email.id,
    address:text(email.address),
    sender:text(email.sender,'Unknown sender'),
    initials:text(email.initials,'?'),
    subject:text(email.subject,'(no subject)'),
    summary:text(email.summary),
    body:text(email.body),
    time:text(email.time),
    color:text(email.color,'gray'),
    category,
    priority:email.priority==='high'?'high':'normal',
    unsubscribeCapability:asCapability(email.unsubscribeCapability),
    listId:typeof email.listId==='string'&&email.listId?email.listId.slice(0,255):undefined,
    needsReply:!!email.needsReply,
    unread:!!email.unread,
    gmailLabels:gmailSignals(email.gmailLabels),
    inInbox:typeof email.inInbox==='boolean'?email.inInbox:undefined,
  } as StoredEmail;
}

/** Runtime boundary for one independently stored email. Invalid rows are skipped. */
export function parseStoredEmail(value:string):StoredEmail|undefined{
  try{return completeStoredEmail(JSON.parse(value));}
  catch{return undefined;}
}

export async function loadMessages(user:string,accountId:string,e:Runtime):Promise<StoredEmail[]>{
  const rows=await e.DB.prepare('SELECT data,replied FROM mailbox_messages WHERE account_id=? AND user_id=? ORDER BY received_at DESC, message_id')
    .bind(accountId,user).all<Row>();
  return (rows.results||[]).map(emailFromRow).filter((email):email is StoredEmail=>!!email);
}

export async function loadMessage(user:string,accountId:string,messageId:string,e:Runtime){
  const row=await e.DB.prepare('SELECT data,replied FROM mailbox_messages WHERE account_id=? AND user_id=? AND message_id=?')
    .bind(accountId,user,messageId).first<Row>();
  return row?emailFromRow(row):undefined;
}

export async function loadMessageMap(user:string,accountId:string,messageIds:string[],e:Runtime){
  const result=new Map<string,StoredEmail>(),ids=[...new Set(messageIds)].filter(Boolean);
  for(let i=0;i<ids.length;i+=80){
    const chunk=ids.slice(i,i+80);
    const rows=await e.DB.prepare(`SELECT data,replied FROM mailbox_messages WHERE account_id=? AND user_id=? AND message_id IN (${chunk.map(()=>'?').join(',')})`)
      .bind(accountId,user,...chunk).all<Row>();
    for(const row of rows.results||[]){const email=emailFromRow(row);if(email)result.set(email.id,email);}
  }
  return result;
}

/** Record a successful send atomically so a concurrent sync cannot restore the reply badge. */
export async function markMessageReplied(user:string,accountId:string,messageId:string,e:Runtime){
  const source=await e.DB.prepare('SELECT data,received_at FROM mailbox_messages WHERE account_id=? AND user_id=? AND message_id=?')
    .bind(accountId,user,messageId).first<{data:string;received_at:number}>();
  if(!source)return false;
  const email=parseStoredEmail(source.data);
  // A reply answers this message and older requests in its Gmail conversation. Later
  // requests stay open, and a missing thread id limits the update to this message.
  const result=email?.threadId
    ?await e.DB.prepare("UPDATE mailbox_messages SET replied=1,data=json_set(data,'$.needsReply',json('false')) WHERE account_id=? AND user_id=? AND json_extract(data,'$.threadId')=? AND received_at<=?")
      .bind(accountId,user,email.threadId,source.received_at).run()
    :await e.DB.prepare("UPDATE mailbox_messages SET replied=1,data=json_set(data,'$.needsReply',json('false')) WHERE account_id=? AND user_id=? AND message_id=?")
      .bind(accountId,user,messageId).run();
  return !!result.meta.changes;
}
