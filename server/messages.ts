import type { StoredEmail } from './sync';
import type { Runtime } from './runtime';

type Row={data:string;replied?:number};

function emailFromRow(row:Row){
  const email=parseStoredEmail(row.data);
  return email&&row.replied?{...email,needsReply:false}:email;
}

/** Runtime boundary for one independently stored email. Invalid rows are skipped. */
export function parseStoredEmail(value:string):StoredEmail|undefined{
  try{
    const item:unknown=JSON.parse(value);
    if(!item||typeof item!=='object'||Array.isArray(item))return undefined;
    const email=item as Partial<StoredEmail>;
    if(typeof email.id!=='string'||!email.id||typeof email.address!=='string'||typeof email.subject!=='string')return undefined;
    return item as StoredEmail;
  }catch{return undefined;}
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
