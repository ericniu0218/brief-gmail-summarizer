import { accessToken, buildRawMessage } from './gmail';
import { deliverOnce } from './send';
import { HttpError, type Runtime } from './runtime';

/**
 * Emails queued to send later. They are sent by the background agent, so a time is honoured to
 * within the agent's schedule rather than to the minute. Every send goes through the same
 * `deliverOnce` as an email sent now, so it can never go out twice.
 */
export const MAX_PENDING_SCHEDULED=20;
export const MAX_SCHEDULE_DAYS=30;
const MINUTE=60000;
const DAY=86400000;
const MAX_TOKEN_ATTEMPTS=3;
export type ScheduledPayload={to:string[];cc:string[];bcc:string[];subject:string;body:string};
export type ScheduledItem={id:string;accountId:string;accountEmail:string|null;sendAt:number;status:'scheduled'|'sending'|'failed';error:string|null;payload:ScheduledPayload};

export async function scheduleEmail(user:string,accountId:string,e:Runtime,id:string,payload:ScheduledPayload,sendAt:number){
  const now=Date.now();
  const heartbeat=await e.DB.prepare('SELECT last_run FROM agent_status WHERE id = ?').bind('scheduler').first<{last_run:number}>();
  if(!heartbeat||now-heartbeat.last_run>=40*MINUTE)
    throw new HttpError(503,'Scheduled sending is unavailable because the background sender has not checked in recently. Send now or try again after it resumes.');
  if(!Number.isInteger(sendAt)||sendAt<now+MINUTE)throw new HttpError(400,'Choose a time in the future.');
  if(sendAt>now+MAX_SCHEDULE_DAYS*DAY)throw new HttpError(400,`Choose a time within the next ${MAX_SCHEDULE_DAYS} days.`);
  // A repeated request for the same email (a double click) is ignored, so check for it before the limit.
  const existing=await e.DB.prepare('SELECT send_at FROM scheduled_emails WHERE id = ? AND user_id = ?').bind(id,user).first<{send_at:number}>();
  if(existing)return {id,sendAt:existing.send_at};
  const open=await e.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_emails WHERE user_id = ? AND status IN ('scheduled','sending','failed')").bind(user).first<{n:number}>();
  if((Number(open?.n)||0)>=MAX_PENDING_SCHEDULED)throw new HttpError(429,`You can have at most ${MAX_PENDING_SCHEDULED} scheduled emails. Cancel one or wait for one to send.`);
  const saved=await e.DB.prepare("INSERT OR IGNORE INTO scheduled_emails (id,user_id,account_id,send_at,payload,status,attempts,created,updated) VALUES (?,?,?,?,?,'scheduled',0,?,?)").bind(id,user,accountId,sendAt,JSON.stringify(payload),now,now).run();
  if(!saved.meta.changes)throw new HttpError(409,'This email is already scheduled.');
  return {id,sendAt};
}
export async function listScheduled(user:string,e:Runtime):Promise<ScheduledItem[]> {
  const rows=await e.DB.prepare("SELECT s.id, s.account_id, c.email AS account_email, s.send_at, s.status, s.error, s.payload FROM scheduled_emails s LEFT JOIN connections c ON c.id = s.account_id AND c.user_id = s.user_id WHERE s.user_id = ? AND s.status IN ('scheduled','sending','failed') ORDER BY s.send_at").bind(user).all<{id:string;account_id:string;account_email:string|null;send_at:number;status:ScheduledItem['status'];error:string|null;payload:string}>();
  const items:ScheduledItem[]=[];
  for(const row of rows.results||[]){
    // A row whose content cannot be read is left out rather than failing the whole list.
    try{items.push({id:row.id,accountId:row.account_id,accountEmail:row.account_email,sendAt:row.send_at,status:row.status,error:row.error,payload:JSON.parse(row.payload) as ScheduledPayload});}catch{/* skip */}
  }
  return items;
}
// Cancelling also clears the saved content. A failed email can be dismissed the same way.
export async function cancelScheduled(user:string,e:Runtime,id:string){
  const result=await e.DB.prepare("UPDATE scheduled_emails SET status='cancelled', payload='{}', updated=? WHERE id = ? AND user_id = ? AND status IN ('scheduled','failed')").bind(Date.now(),id,user).run();
  if(!result.meta.changes)throw new HttpError(409,'This email has already been sent or cancelled.');
}
const failureNote=(error:unknown)=>{
  const message=error instanceof HttpError?error.message:'Sending failed.';
  // The daily limit fires before a Gmail request. A 4xx refusal releases the send
  // claim, so those cases are known not to have delivered anything.
  const definitelyUnsent=error instanceof HttpError&&[400,401,403,404,409,429].includes(error.status);
  return message+(definitelyUnsent?' Nothing was sent.':' It may or may not have gone out, so check your Gmail Sent folder before sending again.');
};
/** Sends every email whose time has come. Called from the background agent. */
export async function sendDueScheduled(e:Runtime){
  const now=Date.now();
  await e.DB.prepare("UPDATE scheduled_emails SET status='failed', error=?, updated=? WHERE status = 'sending' AND updated < ?").bind('Sending was interrupted and could not be confirmed. Check your Gmail Sent folder before sending again.',now,now-15*MINUTE).run();
  await e.DB.prepare("DELETE FROM scheduled_emails WHERE status IN ('sent','cancelled') AND updated < ?").bind(now-7*DAY).run();
  const due=await e.DB.prepare("SELECT id, user_id, account_id, payload, attempts FROM scheduled_emails WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at LIMIT 20").bind(now).all<{id:string;user_id:string;account_id:string;payload:string;attempts:number}>();
  for(const row of due.results||[]){
    const claim=await e.DB.prepare("UPDATE scheduled_emails SET status='sending', updated=? WHERE id = ? AND status = 'scheduled'").bind(Date.now(),row.id).run();
    if(!claim.meta.changes)continue;
    const finish=(status:'sent'|'failed'|'scheduled',error:string|null,attempts=row.attempts)=>e.DB.prepare("UPDATE scheduled_emails SET status=?, error=?, attempts=?, payload=CASE WHEN ?='sent' THEN '{}' ELSE payload END, updated=? WHERE id = ?").bind(status,error,attempts,status,Date.now(),row.id).run();
    let token:string;
    try{token=await accessToken(row.user_id,row.account_id,e);}
    catch(error){
      // Nothing has been sent yet, so a hiccup renewing access is safe to try again on the next run.
      const attempts=row.attempts+1;
      const permanent=error instanceof HttpError&&(error.status===404||error.status===409);
      if(attempts<MAX_TOKEN_ATTEMPTS&&!permanent)await finish('scheduled',null,attempts);
      else await finish('failed',(error instanceof HttpError?error.message:'Your Gmail connection could not be used.')+' Nothing was sent.',attempts);
      continue;
    }
    try{
      const payload=JSON.parse(row.payload) as ScheduledPayload;
      await deliverOnce({user:row.user_id,accountId:row.account_id,token,e,action:'send',noun:'email',parts:['scheduled',row.id],raw:buildRawMessage(payload)});
      await finish('sent',null);
    }catch(error){await finish('failed',failureNote(error));}
  }
}
