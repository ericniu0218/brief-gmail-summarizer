import { replyAddress } from '@/lib/reply-address';
import { replyAllCc } from '@/lib/recipients';
import { accessToken, buildRawMessage, getOwnedConnection, gmail, parseMessage, parseRecipientGroups, type GmailMessage } from '@/server/gmail';
import { polishReply, replyOptions } from '@/server/ai';
import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { mutateSnapshot } from '@/server/snapshots';
import { markMessageReplied } from '@/server/messages';
import { userProfile } from '@/server/profile';
import { deliverOnce } from '@/server/send';

/**
 * Handles all connected-mailbox reply actions. Suggestions are generated for review;
 * Gmail is changed only for the explicit draft and send actions.
 */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const input=await inputObject(request,65536) as {id?:unknown;accountId?:unknown;action?:unknown;tone?:unknown;body?:unknown;variation?:unknown;notes?:unknown;confirmUnsent?:unknown;replyAll?:unknown;sendKey?:unknown;saveKey?:unknown;draftId?:unknown};
    // JSON is untrusted: a cast checks nothing. A non-string id would be coerced to the same
    // message by the pattern and the URL, yet fingerprint differently, and slip past the
    // duplicate-send protection below.
    if(typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{1,150}$/.test(input.id))throw new HttpError(400,'Choose a valid email.');
    if(typeof input.action!=='string'||!['options','polish','draft','send'].includes(input.action))throw new HttpError(400,'Choose a reply action.');
    // A reply always leaves from the mailbox the message arrived in. The account comes
    // from the request and is verified here, never inferred from the selected view.
    const owned=await getOwnedConnection(user,typeof input.accountId==='string'?input.accountId:'',e);
    const token=await accessToken(user,owned.id,e);
    // Reload the source message from Gmail instead of trusting sender or thread data from
    // the browser. This keeps reply destinations under server control.
    const original=await gmail<GmailMessage>('messages/'+encodeURIComponent(input.id)+'?format=full',token);
    const email=parseMessage(original);
    if(input.action==='options'||input.action==='polish'){
      const tone=typeof input.tone==='string'&&['Concise','Friendly','Professional'].includes(input.tone)?input.tone:'Concise';
      if(input.action==='polish'){
        if(typeof input.notes!=='string'||!input.notes.trim())throw new HttpError(400,'Describe what you want to say first.');
        if(input.notes.length>4000)throw new HttpError(400,'Keep your notes under 4,000 characters.');
        return json(await polishReply(email,input.notes,tone,e,(await userProfile(user,e)).name||undefined));
      }
      const variation=typeof input.variation==='number'&&Number.isInteger(input.variation)?Math.min(Math.max(input.variation,0),50):0;
      return json(await replyOptions(email,tone,variation,e,(await userProfile(user,e)).name||undefined));
    }
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000)throw new HttpError(400,'Write a reply of up to 20,000 characters.');
    if(input.sendKey!==undefined&&(typeof input.sendKey!=='string'||!/^[a-zA-Z0-9-]{8,64}$/.test(input.sendKey)))throw new HttpError(400,'Reload the reply and try again.');
    if(input.draftId!==undefined&&(typeof input.draftId!=='string'||!/^[-A-Za-z0-9_]{1,150}$/.test(input.draftId)))throw new HttpError(400,'The saved draft is no longer valid.');
    if(input.saveKey!==undefined&&(typeof input.saveKey!=='string'||!/^[a-zA-Z0-9-]{8,64}$/.test(input.saveKey)))throw new HttpError(400,'Reload the draft and try again.');
    const recipient=replyAddress(original.payload?.headers||[],email.address);
    if(!recipient)throw new HttpError(400,'The reply address could not be verified. Please reply in Gmail.');
    // Reply-all copies are worked out here from the message's own headers, never taken from the
    // browser, and exclude the user's mailbox and whoever the reply is already addressed to.
    const copied=input.replyAll===true?replyAllCc(email,[owned.email,recipient,email.address]):[];
    const {to,cc}=parseRecipientGroups({to:recipient,cc:copied.join(',')});
    const subject=/^re:/i.test(email.subject)?email.subject:'Re: '+email.subject;
    // Build the RFC 2822 message explicitly, preserving Gmail's thread headers when they
    // are safe and available.
    const headerId=email.messageId && !/[\r\n]/.test(email.messageId)?email.messageId:'';
    // The send protocol (idempotent fingerprint, unconfirmed retries, releasing a refused
    // claim) is shared with new and scheduled emails; see server/send.ts.
    const response=await deliverOnce({user,accountId:owned.id,token,e,action:input.action as 'send'|'draft',noun:'reply',
      parts:[input.id,input.action,input.action==='draft'?input.saveKey||'':input.sendKey||'',input.body,...(cc.length?[cc]:[])],
      raw:buildRawMessage({to,cc,subject,body:input.body,inReplyTo:headerId||undefined}),threadId:email.threadId,
      ...(input.action==='draft'?{draftId:input.draftId as string|undefined}:{discardDraftId:input.draftId as string|undefined}),
      confirmUnsent:input.confirmUnsent===true});
    if(input.action==='send'){
      // Reflect a successful send in the cached inbox without waiting for the next sync.
      // Gmail and the operation receipt are already committed. Cache repair is best
      // effort so a damaged or racing snapshot cannot report a successful send as failed.
      try{
        const updated=await markMessageReplied(user,owned.id,input.id,e);
        if(!updated)await mutateSnapshot(user,owned.id,e,snapshot=>{
          snapshot.emails=snapshot.emails.map(message=>message.id===input.id?{...message,needsReply:false,replied:true}:message);
        });
      }
      catch{console.error('Reply sent, but the mailbox cache could not be updated.');}
    }
    return json(response);
  }catch(error){return failure(error);}
}
