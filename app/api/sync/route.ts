import { failure, inputObject, HttpError, json, mutation, runtime, userId } from '@/server/runtime';
import { connection } from '@/server/gmail';
import { mailbox } from '@/server/mailbox';
import { syncInbox } from '@/server/sync';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const {accountId}=await inputObject(request) as {accountId?:string};
    const accounts=accountId==='all'
      ?(await e.DB.prepare('SELECT id, email, last_sync FROM connections WHERE user_id=?').bind(user).all<{id:string;email:string;last_sync:number|null}>()).results
      :[await connection(user,e,accountId)];
    const errors:{accountId:string;email:string;message:string}[]=[];
    // Each account has its own lease; a failed account retains its prior snapshot.
    for(const account of accounts){
      try{
        const existing=await e.DB.prepare('SELECT updated FROM snapshots WHERE user_id=? AND account_id=?').bind(user,account.id).first<{updated:number}>();
        if(account.last_sync===null||!existing||Date.now()-existing.updated>=60000)await syncInbox(user,e,account.id);
      }catch(error){errors.push({accountId:account.id,email:account.email,message:error instanceof HttpError?error.message:'Could not refresh this account.'});}
    }
    return json({...await mailbox(user,e),errors});
  }catch(error){return failure(error);}
}
