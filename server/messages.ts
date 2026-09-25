import type { StoredEmail } from './sync';
import type { Runtime } from './runtime';

type Row={data:string;replied?:number};

function emailFromRow(row:Row){
  const email=parseStoredEmail(row.data);
  return email&&row.replied?{...email,needsReply:false}:email;
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
    needsReply:!!email.needsReply,
    unread:!!email.unread,
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
  const result=await e.DB.prepare("UPDATE mailbox_messages SET replied=1,data=json_set(data,'$.needsReply',json('false')) WHERE account_id=? AND user_id=? AND message_id=?")
    .bind(accountId,user,messageId).run();
  return !!result.meta.changes;
}
