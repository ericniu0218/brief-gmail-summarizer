import { accessToken, gmail, parseMessage, type GmailMessage } from '@/server/gmail';
import { replySuggestion } from '@/server/ai';
import { encode, failure, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const input=await request.json() as {id?:string;action?:string;tone?:string;body?:string};
    if(!input.id||!/^[a-zA-Z0-9_-]{1,150}$/.test(input.id))throw new HttpError(400,'Choose a valid email.');
    if(!['generate','draft','send'].includes(input.action||''))throw new HttpError(400,'Choose a reply action.');
    const token=await accessToken(user);
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(input.id)+'?format=full',token));
    if(input.action==='generate'){
      const tone=['Concise','Friendly','Professional'].includes(input.tone||'')?input.tone!:'Concise';
      return json(await replySuggestion(email,tone));
    }
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000)throw new HttpError(400,'Write a reply of up to 20,000 characters.');
    if(!/^[^\s<>\r\n@]+@[^\s<>\r\n@]+\.[^\s<>\r\n@]+$/.test(email.address))throw new HttpError(400,'The sender address could not be verified. Please reply in Gmail.');
    const fingerprint=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([user,input.id,input.action,input.body])))));
    const previous=await e.DB.prepare('SELECT status, result FROM operations WHERE id = ? AND user_id = ?').bind(fingerprint,user).first<{status:string;result:string}>();
    if(previous?.status==='complete')return json(JSON.parse(previous.result));
    if(previous)throw new HttpError(409,'A previous request is still unconfirmed. Check Gmail before trying again.');
    const claim=await e.DB.prepare("INSERT OR IGNORE INTO operations (id,user_id,status) VALUES (?,?,'pending')").bind(fingerprint,user).run();
    if(!claim.meta.changes)throw new HttpError(409,'This reply is already being processed.');
    const subject=/^re:/i.test(email.subject)?email.subject:'Re: '+email.subject;
    const headerId=email.messageId && !/[\r\n]/.test(email.messageId)?email.messageId:'';
    const raw=encode([`To: ${email.address}`,`Subject: =?UTF-8?B?${btoa(Array.from(new TextEncoder().encode(subject),b=>String.fromCharCode(b)).join(''))}?=`,...(headerId?[`In-Reply-To: ${headerId}`,`References: ${headerId}`]:[]),'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',btoa(Array.from(new TextEncoder().encode(input.body),b=>String.fromCharCode(b)).join('')).match(/.{1,76}/g)!.join('\r\n')].join('\r\n'));
    const message={raw,threadId:email.threadId};
    const result=await gmail<{id:string}>(input.action==='send'?'messages/send':'drafts',token,{method:'POST',body:JSON.stringify(input.action==='send'?message:{message})});
    const response={id:result.id,status:input.action==='send'?'sent':'drafted'};
    await e.DB.prepare("UPDATE operations SET status='complete', result=? WHERE id=? AND user_id=?").bind(JSON.stringify(response),fingerprint,user).run();
    if(input.action==='send'){
      const saved=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id=?').bind(user).first<{data:string}>();
      if(saved){
        const snapshot=JSON.parse(saved.data);
        snapshot.emails=snapshot.emails.map((m:{id:string;needsReply:boolean})=>m.id===input.id?{...m,needsReply:false}:m);
        await e.DB.prepare('UPDATE snapshots SET data=? WHERE user_id=?').bind(JSON.stringify(snapshot),user).run();
      }
    }
    return json(response);
  }catch(error){return failure(error);}
}
