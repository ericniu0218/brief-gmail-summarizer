import { emailKey, senderKey, type Email } from '@/lib/mail';
import { connectionStatus } from './connection-status';
import { runtime } from './runtime';
import type { Snapshot } from './sync';

export type MailboxSnapshot = { accountId:string; updated:number|null; ai:boolean; hasMore:boolean; warning?:string };
export async function mailbox(user:string,e=runtime()) {
  const rows=await e.DB.prepare('SELECT c.id, c.email, s.data FROM connections c LEFT JOIN snapshots s ON s.user_id=c.user_id AND s.account_id=c.id WHERE c.user_id=? ORDER BY c.email').bind(user).all<{id:string;email:string;data:string|null}>();
  const accounts:MailboxSnapshot[]=[];
  const emails:Email[]=[];
  for(const row of rows.results){
    const snapshot:Snapshot|null=row.data?JSON.parse(row.data):null;
    accounts.push({accountId:row.id,updated:snapshot?.updated??null,ai:snapshot?.ai??false,hasMore:!!snapshot?.hasMore,warning:snapshot?.warning});
    emails.push(...(snapshot?.emails||[]).map(email=>({...email,accountId:row.id,accountEmail:row.email})));
  }
  // Apply durable actions after reading snapshots so a concurrent sync cannot undo them.
  const [muted,operations]=await Promise.all([
    e.DB.prepare('SELECT account_id, address FROM unsubscribed WHERE user_id=?').bind(user).all<{account_id:string;address:string}>(),
    e.DB.prepare("SELECT account_id, result FROM operations WHERE user_id=? AND status='complete' AND json_valid(result)").bind(user).all<{account_id:string;result:string}>(),
  ]);
  const mutedSenders=new Set(muted.results.map(row=>JSON.stringify([row.account_id,row.address])));
  const replied=new Set(operations.results.flatMap(row=>{
    const receipt=JSON.parse(row.result) as {status?:string;sourceMessageId?:string};
    return receipt.status==='sent'&&receipt.sourceMessageId?[JSON.stringify([row.account_id,receipt.sourceMessageId])]:[];
  }));
  const visible=emails.filter(email=>!mutedSenders.has(senderKey(email))).map(email=>replied.has(emailKey(email))?{...email,needsReply:false}:email);
  visible.sort((a,b)=>(b.receivedAt||0)-(a.receivedAt||0));
  return {emails:visible,accounts,connection:await connectionStatus(user,e)};
}
