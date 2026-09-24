import { accessToken, gmail, parseMessage, safeUnsubscribe, type GmailMessage } from '@/server/gmail';
import { failure, HttpError, json, mutation, runtime, userId } from '@/server/runtime';

/** Performs a verified one-click unsubscribe or sends the user to Gmail as a fallback. */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();const {id}=await request.json() as {id:string};
    if(!id||!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new HttpError(400,'Choose a valid sender.');
    // Fetch the message again so the browser cannot supply an arbitrary unsubscribe URL.
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',await accessToken(user)));
    if(!email.unsubscribe||!email.oneClick||!safeUnsubscribe(email.unsubscribe,e))return json({manual:true,url:'https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(email.threadId||id)});
    const response=await fetch(email.unsubscribe,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click',redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new HttpError(502,'This sender could not confirm your unsubscribe. Please use the unsubscribe option in Gmail.');
    // Remember the sender and remove its messages from the current snapshot immediately.
    await e.DB.prepare('INSERT OR IGNORE INTO unsubscribed (id,user_id,address,created) VALUES (?,?,?,?)').bind(user+':'+email.address,user,email.address,Date.now()).run();
    const snapshot=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    if(snapshot){const data=JSON.parse(snapshot.data);data.emails=data.emails.filter((m:{address:string})=>m.address!==email.address);await e.DB.prepare('UPDATE snapshots SET data=? WHERE user_id=?').bind(JSON.stringify(data),user).run();}
    return json({status:'unsubscribed',address:email.address});
  }catch(error){return failure(error);}
}
