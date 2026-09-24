import { getOwnedConnection, accessToken, gmail, parseMessage, safeUnsubscribe, type GmailMessage } from '@/server/gmail';
import { failure, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
import { gmailThreadUrl } from '@/lib/mail';
import { mutateSnapshot } from '@/server/snapshots';

/** Performs a verified one-click unsubscribe or sends the user to Gmail as a fallback. */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();const {id,accountId}=await request.json() as {id:string;accountId?:string};
    if(!id||!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new HttpError(400,'Choose a valid sender.');
    // Unsubscribing uses the mailbox the message arrived in, so the endpoint comes from
    // that account's copy of the message and the record is kept per mailbox.
    const owned=await getOwnedConnection(user,accountId||'',e);
    // Fetch the message again so the browser cannot supply an arbitrary unsubscribe URL.
    const email=parseMessage(await gmail<GmailMessage>('messages/'+encodeURIComponent(id)+'?format=full',await accessToken(user,owned.id,e)));
    if(!email.unsubscribe||!email.oneClick||!safeUnsubscribe(email.unsubscribe,e))return json({manual:true,url:gmailThreadUrl(owned.email,email.threadId||id)});
    const response=await fetch(email.unsubscribe,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click',redirect:'manual',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new HttpError(502,'This sender could not confirm your unsubscribe. Please use the unsubscribe option in Gmail.');
    // Remember the sender and remove its messages from the current snapshot immediately.
    await e.DB.prepare('INSERT OR IGNORE INTO unsubscribed (id,user_id,account_id,address,created) VALUES (?,?,?,?,?)').bind(owned.id+':'+email.address,user,owned.id,email.address,Date.now()).run();
    // The provider action and durable sender preference succeeded already. A cache race
    // must not turn that into an error response; the next mailbox read/sync will repair it.
    try{
      const removed=await e.DB.prepare("DELETE FROM mailbox_messages WHERE account_id=? AND user_id=? AND json_extract(data,'$.address')=?")
        .bind(owned.id,user,email.address).run();
      if(!removed.meta.changes)await mutateSnapshot(user,owned.id,e,snapshot=>{
          snapshot.emails=snapshot.emails.filter(message=>message.address!==email.address);
        });
    }
    catch{console.error('Unsubscribed, but the mailbox cache could not be updated.');}
    return json({status:'unsubscribed',address:email.address});
  }catch(error){return failure(error);}
}
