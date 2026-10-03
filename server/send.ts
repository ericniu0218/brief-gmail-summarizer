import { gmail, gmailDelete, gmailUpload } from './gmail';
import { encode, HttpError, parseStoredJson, type Runtime } from './runtime';

/**
 * The one place an email leaves the app: replies, new emails, and emails sent later.
 *
 * It is the reply route's send protocol, moved here so every kind of send has exactly the
 * same guarantees. The same request cannot create a second email, an uncertain earlier
 * attempt must be checked in Gmail before it is retried, and a claim is released only when
 * Gmail clearly refused the message.
 */
export const DEFAULT_DAILY_SEND_LIMIT=100;
const DAY=86400000;
export type Receipt={id:string;status:'sent'|'drafted';threadId?:string};

export async function fingerprintOf(parts:unknown[]){
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(parts)))));
}
function isReceipt(value:unknown):value is Receipt {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const receipt=value as Record<string,unknown>;
  return typeof receipt.id==='string'&&(receipt.status==='sent'||receipt.status==='drafted');
}

/**
 * Sends a message or saves a draft at most once per fingerprint.
 *
 * `parts` identify the request. The user and mailbox are added to them, so identical text
 * sent from two mailboxes stays two separate operations. Pass `raw` (base64url, with an
 * optional thread) for an ordinary message, or `mime` for one with attachments.
 * `noun` only words the messages shown to the user.
 */
export async function deliverOnce({user,accountId,token,e,action,parts,raw,mime,threadId,draftId,discardDraftId,confirmUnsent=false,noun='reply',reportThread=false}:{
  user:string;accountId:string;token:string;e:Runtime;action:'send'|'draft';parts:unknown[];
  raw?:string;mime?:string;threadId?:string;draftId?:string;discardDraftId?:string;confirmUnsent?:boolean;noun?:'reply'|'email';reportThread?:boolean;
}):Promise<Receipt> {
  if((draftId||discardDraftId)&&!/^[-A-Za-z0-9_]{1,150}$/.test(draftId||discardDraftId||''))throw new HttpError(400,'The saved draft is no longer valid.');
  if(draftId||discardDraftId){
    const known=await e.DB.prepare("SELECT 1 AS found FROM operations WHERE user_id=? AND account_id=? AND action='draft' AND status='complete' AND json_extract(result,'$.id')=? LIMIT 1")
      .bind(user,accountId,draftId||discardDraftId).first();
    if(!known)throw new HttpError(409,'That draft is not linked to this email. Save a new draft instead.');
  }
  const fingerprint=await fingerprintOf([user,accountId,...parts]);
  const previous=await e.DB.prepare('SELECT status, result, created, attempt FROM operations WHERE id = ? AND user_id = ?').bind(fingerprint,user).first<{status:string;result:string;created:number;attempt:string|null}>();
  if(previous?.status==='complete')return parseStoredJson(previous.result,`${noun} receipt`,isReceipt);
  if(previous){
    // An uncertain provider response may be retried only after the person explicitly
    // confirms they checked Gmail. A pending operation also gets a one-minute window
    // to finish, which prevents another tab from overriding a request still in flight.
    const recoverable=previous.status==='unconfirmed'||(previous.status==='pending'&&Date.now()-previous.created>=60000);
    if(confirmUnsent!==true||!recoverable){
      // Saying when it happened turns a dead end into something the person can check:
      // they can look for that time in Gmail and see whether it is really there.
      const when=previous.created?new Date(previous.created).toISOString().slice(0,16).replace('T',' ')+' UTC':null;
      throw new HttpError(409,previous.status==='pending'&&!recoverable
        ?`This ${noun} is already being processed. Wait a moment before checking Gmail.`
        :`A previous request${when?` from ${when}`:''} is still unconfirmed. Check Gmail before trying again.`);
    }
  }
  if(action==='send'){
    // A rolling 24-hour cap per user protects the Gmail account from being flagged as a
    // spammer if a script or a mistake sends in bulk. It is a soft limit: two simultaneous
    // sends can overshoot by one. Retrying an uncertain send is not a new email, so it is
    // not blocked by a limit its first attempt already counted against.
    const configured=Number(e.SEND_DAILY_LIMIT);const limit=Number.isInteger(configured)&&configured>0?configured:DEFAULT_DAILY_SEND_LIMIT;
    const recent=await e.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE user_id = ? AND action = 'send' AND created > ?").bind(user,Date.now()-DAY).first<{n:number}>();
    if(!previous&&(Number(recent?.n)||0)>=limit)throw new HttpError(429,`You have reached the limit of ${limit} sent emails in 24 hours. Try again later, or send from Gmail directly.`);
  }
  // Each attempt owns the operation under its own id, and every later write names it.
  // A confirmed retry takes over only the exact attempt it read: two tabs retrying the
  // same unconfirmed send both read it, but only the first replacement matches, so the
  // second stops here instead of deleting the first one's claim and sending again.
  const attempt=crypto.randomUUID();
  const claim=previous
    ?await e.DB.prepare("UPDATE operations SET status='pending',result=NULL,created=?,attempt=?,action=? WHERE id=? AND user_id=? AND status=? AND created=? AND attempt IS ?")
      .bind(Date.now(),attempt,action,fingerprint,user,previous.status,previous.created,previous.attempt??null).run()
    :await e.DB.prepare("INSERT OR IGNORE INTO operations (id,user_id,account_id,status,created,attempt,action) VALUES (?,?,?,'pending',?,?,?)").bind(fingerprint,user,accountId,Date.now(),attempt,action).run();
  if(!claim.meta.changes)throw new HttpError(409,`This ${noun} is already being processed.`);
  const path=action==='send'?'messages/send':draftId?`drafts/${encodeURIComponent(draftId)}`:'drafts';
  let result:{id:string;threadId?:string};
  const deliver=async(destination:string,method:'POST'|'PUT')=>mime!==undefined
    ?gmailUpload<{id:string;threadId?:string}>(destination,token,mime,method)
    :gmail<{id:string;threadId?:string}>(destination,token,{method,body:JSON.stringify(action==='send'
      ?threadId?{raw,threadId}:{raw}
      :{message:threadId?{raw,threadId}:{raw}})});
  try{
    try{result=await deliver(path,draftId&&action==='draft'?'PUT':'POST');}
    catch(error){
      if(action!=='draft'||!draftId||!(error instanceof HttpError)||error.status!==404)throw error;
      // The person deleted this draft in Gmail after we last saved it. The update
      // definitively created nothing, so make a fresh draft using the same content.
      result=await deliver('drafts','POST');
    }
  }catch(error){
    // Gmail refusing the request outright means nothing was created, so the claim is
    // released and the same message can be sent again once the cause is fixed. A timeout
    // or a server error might still have been delivered, so that claim is kept and the
    // person is asked to check Gmail rather than risk sending twice.
    const refused=error instanceof HttpError&&[400,401,403,404,429].includes(error.status);
    await (refused
      ? e.DB.prepare("DELETE FROM operations WHERE id = ? AND user_id = ? AND status = 'pending' AND attempt = ?").bind(fingerprint,user,attempt).run()
      : e.DB.prepare("UPDATE operations SET status='unconfirmed' WHERE id = ? AND user_id = ? AND status = 'pending' AND attempt = ?").bind(fingerprint,user,attempt).run());
    throw error;
  }
  const receipt:Receipt={id:result.id,status:action==='send'?'sent':'drafted',...(reportThread&&result.threadId?{threadId:result.threadId}:{})};
  await e.DB.prepare("UPDATE operations SET status='complete', result=? WHERE id=? AND user_id=? AND attempt=?").bind(JSON.stringify(receipt),fingerprint,user,attempt).run();
  if(action==='send'&&discardDraftId){
    try{await gmailDelete(`drafts/${encodeURIComponent(discardDraftId)}`,token);}
    catch{console.error('Sent email, but its saved draft could not be removed.');}
  }
  return receipt;
}
