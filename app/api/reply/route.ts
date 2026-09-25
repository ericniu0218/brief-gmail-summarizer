import { accessToken, getOwnedConnection, gmail, parseMessage, type GmailMessage } from '@/server/gmail';
import { polishReply, replyOptions } from '@/server/ai';
import { encode, failure, HttpError, inputObject, json, mutation, parseStoredJson, runtime, userId } from '@/server/runtime';
import { mutateSnapshot } from '@/server/snapshots';
import { markMessageReplied } from '@/server/messages';

/**
 * Handles all connected-mailbox reply actions. Suggestions are generated for review;
 * Gmail is changed only for the explicit draft and send actions.
 */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const input=await inputObject(request,65536) as {id?:string;accountId?:string;action?:string;tone?:string;body?:string;variation?:number;notes?:string;confirmUnsent?:boolean};
    if(!input.id||!/^[a-zA-Z0-9_-]{1,150}$/.test(input.id))throw new HttpError(400,'Choose a valid email.');
    if(!['options','polish','draft','send'].includes(input.action||''))throw new HttpError(400,'Choose a reply action.');
    // A reply always leaves from the mailbox the message arrived in. The account comes
    // from the request and is verified here, never inferred from the selected view.
    const owned=await getOwnedConnection(user,input.accountId||'',e);
    const token=await accessToken(user,owned.id,e);
    // Reload the source message from Gmail instead of trusting sender or thread data from
    // the browser. This keeps reply destinations under server control.
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(input.id)+'?format=full',token));
    if(input.action==='options'||input.action==='polish'){
      const tone=['Concise','Friendly','Professional'].includes(input.tone||'')?input.tone!:'Concise';
      if(input.action==='polish'){
        if(typeof input.notes!=='string'||!input.notes.trim())throw new HttpError(400,'Describe what you want to say first.');
        if(input.notes.length>4000)throw new HttpError(400,'Keep your notes under 4,000 characters.');
        return json(await polishReply(email,input.notes,tone));
      }
      const variation=typeof input.variation==='number'&&Number.isInteger(input.variation)?Math.min(Math.max(input.variation,0),50):0;
      return json(await replyOptions(email,tone,variation));
    }
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000)throw new HttpError(400,'Write a reply of up to 20,000 characters.');
    if(!/^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/.test(email.address))throw new HttpError(400,'The sender address could not be verified. Please reply in Gmail.');
    // The account is part of the fingerprint, so identical text sent from two mailboxes
    // stays two separate operations rather than being suppressed as a duplicate.
    const fingerprint=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([user,owned.id,input.id,input.action,input.body])))));
    // The fingerprint makes retries idempotent: the same send request cannot create a
    // second email, and an uncertain earlier attempt must be checked in Gmail first.
    const previous=await e.DB.prepare('SELECT status, result, created FROM operations WHERE id = ? AND user_id = ?').bind(fingerprint,user).first<{status:string;result:string;created:number}>();
    if(previous?.status==='complete')return json(parseStoredJson(previous.result,'reply receipt',(value):value is {id:string;status:'sent'|'drafted'}=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return false;
      const receipt=value as Record<string,unknown>;
      return typeof receipt.id==='string'&&(receipt.status==='sent'||receipt.status==='drafted');
    }));
    if(previous){
      // An uncertain provider response may be retried only after the person explicitly
      // confirms they checked Gmail. A pending operation also gets a one-minute window
      // to finish, which prevents another tab from overriding a request still in flight.
      const recoverable=previous.status==='unconfirmed'||(previous.status==='pending'&&Date.now()-previous.created>=60000);
      if(input.confirmUnsent===true&&recoverable){
        await e.DB.prepare("DELETE FROM operations WHERE id = ? AND user_id = ? AND status != 'complete'").bind(fingerprint,user).run();
      }else{
        // Saying when it happened turns a dead end into something the person can check:
        // they can look for that time in Gmail and see whether the reply is really there.
        const when=previous.created?new Date(previous.created).toISOString().slice(0,16).replace('T',' ')+' UTC':null;
        throw new HttpError(409,previous.status==='pending'&&!recoverable
          ?'This reply is already being processed. Wait a moment before checking Gmail.'
          :`A previous request${when?` from ${when}`:''} is still unconfirmed. Check Gmail before trying again.`);
      }
    }
    const claim=await e.DB.prepare("INSERT OR IGNORE INTO operations (id,user_id,account_id,status,created) VALUES (?,?,?,'pending',?)").bind(fingerprint,user,owned.id,Date.now()).run();
    if(!claim.meta.changes)throw new HttpError(409,'This reply is already being processed.');
    const subject=/^re:/i.test(email.subject)?email.subject:'Re: '+email.subject;
    // Build the RFC 2822 message explicitly, preserving Gmail's thread headers when they
    // are safe and available.
    const headerId=email.messageId && !/[\r\n]/.test(email.messageId)?email.messageId:'';
    const raw=encode([`To: ${email.address}`,`Subject: =?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(subject),b=>String.fromCharCode(b)).join(''))}?=`,...(headerId?[`In-Reply-To: ${headerId}`,`References: ${headerId}`]:[]),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',btoa(Array.from(new TextEncoder().encode(input.body),b=>String.fromCharCode(b)).join('')).match(/.{1,76}/g)!.join('\r\n')].join('\r\n'));
    const message={raw,threadId:email.threadId};
    let result:{id:string};
    try{
      result=await gmail<{id:string}>(input.action==='send'?'messages/send':'drafts',token,{method:'POST',body:JSON.stringify(input.action==='send'?message:{message})});
    }catch(error){
      // Gmail refusing the request outright means nothing was created, so the claim is
      // released and the same reply can be sent again once the cause is fixed. A timeout
      // or a server error might still have been delivered, so that claim is kept and the
      // person is asked to check Gmail rather than risk sending twice.
      const refused=error instanceof HttpError&&[400,401,403,429].includes(error.status);
      await (refused
        ? e.DB.prepare("DELETE FROM operations WHERE id = ? AND user_id = ? AND status = 'pending'").bind(fingerprint,user).run()
        : e.DB.prepare("UPDATE operations SET status='unconfirmed' WHERE id = ? AND user_id = ? AND status = 'pending'").bind(fingerprint,user).run());
      throw error;
    }
    const response={id:result.id,status:input.action==='send'?'sent':'drafted'};
    await e.DB.prepare("UPDATE operations SET status='complete', result=? WHERE id=? AND user_id=?").bind(JSON.stringify(response),fingerprint,user).run();
    if(input.action==='send'){
      // Reflect a successful send in the cached inbox without waiting for the next sync.
      // Gmail and the operation receipt are already committed. Cache repair is best
      // effort so a damaged or racing snapshot cannot report a successful send as failed.
      try{
        const updated=await markMessageReplied(user,owned.id,input.id,e);
        if(!updated)await mutateSnapshot(user,owned.id,e,snapshot=>{
          snapshot.emails=snapshot.emails.map(message=>message.id===input.id?{...message,needsReply:false}:message);
        });
      }
      catch{console.error('Reply sent, but the mailbox cache could not be updated.');}
    }
    return json(response);
  }catch(error){return failure(error);}
}
