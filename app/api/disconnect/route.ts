import { decrypt, failure, inputObject, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
import { connectionStatus } from '@/server/connection-status';
import { connection } from '@/server/gmail';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const {accountId}=await inputObject(request) as {accountId?:string};
    if(!accountId)throw new HttpError(400,'Choose the Gmail account to disconnect.');
    const account=await connection(user,e,accountId);
    let revoked=false;
    try{const response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:await decrypt(account.token,user,e)}),signal:AbortSignal.timeout(10000)});revoked=response.ok;}catch{revoked=false;}
    await e.DB.batch([
      e.DB.prepare('DELETE FROM connections WHERE user_id=? AND id=?').bind(user,account.id),
      ...['snapshots','operations','unsubscribed'].map(table=>e.DB.prepare(`DELETE FROM ${table} WHERE user_id=? AND account_id=?`).bind(user,account.id)),
      e.DB.prepare('DELETE FROM account_preferences WHERE user_id=? AND default_account_id=?').bind(user,account.id),
      e.DB.prepare('INSERT OR IGNORE INTO account_preferences (user_id,default_account_id) SELECT user_id,id FROM connections WHERE user_id=? ORDER BY email LIMIT 1').bind(user),
    ]);
    return json({...await connectionStatus(user,e),disconnected:true,accountId:account.id,revoked});
  }catch(error){return failure(error);}
}
