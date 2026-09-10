import { accessToken, connection, gmail, parseMessage, safeUnsubscribe, type GmailMessage } from '@/server/gmail';
import { gmailLink } from '@/lib/mail';
import { failure, inputObject, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();const {id,accountId}=await inputObject(request) as {id:string;accountId?:string};
    if(typeof id!=='string'||!id||!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new HttpError(400,'Choose a valid sender.');
    if(typeof accountId!=='string'||!accountId)throw new HttpError(400,'Choose the Gmail account for this sender.');
    const account=await connection(user,e,accountId);
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',await accessToken(user,e,account.id)));
    if(!email.unsubscribe||!email.oneClick||!safeUnsubscribe(email.unsubscribe,e))return json({manual:true,url:gmailLink({...email,accountEmail:account.email})});
    const response=await fetch(email.unsubscribe,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click',redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new HttpError(502,'This sender could not confirm your unsubscribe. Please use the unsubscribe option in Gmail.');
    await e.DB.prepare('INSERT OR IGNORE INTO unsubscribed (id,user_id,account_id,address,created) SELECT ?,user_id,id,?,? FROM connections WHERE user_id=? AND id=?').bind(JSON.stringify([user,account.id,email.address]),email.address,Date.now(),user,account.id).run();
    return json({status:'unsubscribed',address:email.address});
  }catch(error){return failure(error);}
}
