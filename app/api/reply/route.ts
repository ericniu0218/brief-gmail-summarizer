import { accessToken, connection, gmail, parseMessage, type GmailMessage } from '@/server/gmail';
import { replySuggestion } from '@/server/ai';
import { encode, failure, inputObject, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const input=await inputObject(request) as {accountId?:string;id?:string;action?:string;tone?:string;body?:string;variation?:number};
    if(typeof input.id!=='string'||!input.id||!/^[a-zA-Z0-9_-]{1,150}$/.test(input.id))throw new HttpError(400,'Choose a valid email.');
    if(!['generate','draft','send'].includes(input.action||''))throw new HttpError(400,'Choose a reply action.');
    if(typeof input.accountId!=='string'||!input.accountId)throw new HttpError(400,'Choose the Gmail account for this reply.');
    const account=await connection(user,e,input.accountId);
    let fingerprint='';
    if(input.action!=='generate'){
      if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000)throw new HttpError(400,'Write a reply of up to 20,000 characters.');
      fingerprint=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(account.id===user?[user,input.id,input.action,input.body]:[user,account.id,input.id,input.action,input.body])))));
      const previous=await e.DB.prepare('SELECT status, result FROM operations WHERE id = ? AND user_id = ? AND account_id = ?').bind(fingerprint,user,account.id).first<{status:string;result:string}>();
      if(previous?.status==='complete'){const receipt=JSON.parse(previous.result) as {id:string;status:string};return json({id:receipt.id,status:receipt.status});}
      if(previous)throw new HttpError(409,'A previous request is still unconfirmed. Check Gmail before trying again.');
    }
    const token=await accessToken(user,e,account.id);
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(input.id)+'?format=full',token));
    if(input.action==='generate'){
      const tone=['Concise','Friendly','Professional'].includes(input.tone||'')?input.tone!:'Concise';
      const variation=typeof input.variation==='number'&&Number.isInteger(input.variation)?Math.min(Math.max(input.variation,0),50):0;
      return json(await replySuggestion({...email,accountEmail:account.email},tone,variation));
    }
    if(!/^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/.test(email.address))throw new HttpError(400,'The sender address could not be verified. Please reply in Gmail.');
    const claim=await e.DB.prepare("INSERT OR IGNORE INTO operations (id,user_id,account_id,status) SELECT ?,user_id,id,'pending' FROM connections WHERE user_id=? AND id=?").bind(fingerprint,user,account.id).run();
    if(!claim.meta.changes)throw new HttpError(409,'This reply is already being processed.');
    const subject=/^re:/i.test(email.subject)?email.subject:'Re: '+email.subject;
    const headerId=email.messageId && !/[\r\n]/.test(email.messageId)?email.messageId:'';
    const raw=encode([`To: ${email.address}`,`Subject: =?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(subject),b=>String.fromCharCode(b)).join(''))}?=`,...(headerId?[`In-Reply-To: ${headerId}`,`References: ${headerId}`]:[]),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',btoa(Array.from(new TextEncoder().encode(input.body!),b=>String.fromCharCode(b)).join('')).match(/.{1,76}/g)!.join('\r\n')].join('\r\n'));
    const message={raw,threadId:email.threadId};
    const result=await gmail<{id:string}>(input.action==='send'?'messages/send':'drafts',token,{method:'POST',body:JSON.stringify(input.action==='send'?message:{message})});
    const response={id:result.id,status:input.action==='send'?'sent':'drafted'};
    await e.DB.prepare("UPDATE operations SET status='complete', result=? WHERE id=? AND user_id=? AND account_id=?").bind(JSON.stringify({...response,sourceMessageId:input.id}),fingerprint,user,account.id).run();
    return json(response);
  }catch(error){return failure(error);}
}
