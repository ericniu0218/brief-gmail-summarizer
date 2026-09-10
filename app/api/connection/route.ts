import { failure, inputObject, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
import { connectionStatus } from '@/server/connection-status';
import { connection } from '@/server/gmail';
export async function GET(){
  try{
    return json(await connectionStatus(await userId()));
  }catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const {accountId}=await inputObject(request) as {accountId:string};
    if(typeof accountId!=='string')throw new HttpError(400,'Choose a Gmail account.');
    const account=await connection(user,e,accountId);
    await e.DB.prepare('INSERT INTO account_preferences (user_id,default_account_id) SELECT user_id,id FROM connections WHERE user_id=? AND id=? ON CONFLICT(user_id) DO UPDATE SET default_account_id=excluded.default_account_id').bind(user,account.id).run();
    return json(await connectionStatus(user,e));
  }catch(error){return failure(error);}
}
