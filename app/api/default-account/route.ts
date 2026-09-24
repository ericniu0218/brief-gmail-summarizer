import { failure, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { getOwnedConnection } from '@/server/gmail';

/** Sets the user's default mailbox. Ownership is verified before the preference is saved. */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const body=await inputObject(request);
    // Rejects both a foreign account and the reserved combined-view selection.
    const owned=await getOwnedConnection(user,typeof body.accountId==='string'?body.accountId:'',e);
    await e.DB.prepare('INSERT INTO account_preferences (user_id, default_account_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET default_account_id=excluded.default_account_id').bind(user,owned.id).run();
    return json({defaultAccountId:owned.id});
  }catch(error){return failure(error);}
}
