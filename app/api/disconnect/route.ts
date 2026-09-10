import { decrypt, failure, json, mutation, runtime, userId } from '@/server/runtime';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const connection=await e.DB.prepare('SELECT token FROM connections WHERE user_id=?').bind(user).first<{token:string}>();
    let revoked=!connection;
    if(connection){try{const response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:await decrypt(connection.token,user)}),signal:AbortSignal.timeout(10000)});revoked=response.ok;}catch{revoked=false;}}
    await e.DB.batch(['connections','snapshots','oauth_states','operations','unsubscribed'].map(table=>e.DB.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(user)));
    return json({disconnected:true,revoked});
  }catch(error){return failure(error);}
}
