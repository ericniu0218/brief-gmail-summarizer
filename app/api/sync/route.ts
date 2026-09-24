import { failure, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { syncInbox } from '@/server/sync';
import { ALL_INBOXES, getOwnedConnection, ownedConnections } from '@/server/gmail';
import { readMailbox } from '@/server/mailbox';

/**
 * Refreshes one mailbox, or every connected mailbox for the combined view. A failing
 * account reports its own error and never prevents the others from refreshing.
 */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const body=await inputObject(request).catch(()=>({} as Record<string,unknown>));
    const requested=typeof body.accountId==='string'?body.accountId:ALL_INBOXES;
    const targets=requested===ALL_INBOXES
      ? (await ownedConnections(user,e)).map(c=>c.id)
      : [(await getOwnedConnection(user,requested,e)).id];
    const accounts:Record<string,{ok:boolean;error?:string}>={};
    for(const accountId of targets){
      try{
        // A very recent snapshot absorbs double-clicks without repeating Gmail work.
        const existing=await e.DB.prepare('SELECT snapshots.updated, connections.sync_page_token FROM connections LEFT JOIN snapshots ON snapshots.account_id=connections.id AND snapshots.user_id=connections.user_id WHERE connections.id=? AND connections.user_id=?')
          .bind(accountId,user).first<{updated:number|null;sync_page_token:string|null}>();
        if(existing?.updated&&!existing.sync_page_token&&Date.now()-existing.updated<60000){accounts[accountId]={ok:true};continue;}
        // One bounded page keeps a browser request within provider and worker limits.
        // The saved cursor lets scheduled and later explicit refreshes continue safely.
        await syncInbox(user,accountId,e);
        accounts[accountId]={ok:true};
      }catch(error){accounts[accountId]={ok:false,error:error instanceof Error?error.message:'Refresh failed.'};}
    }
    // Return the refreshed view itself, so a caller gets mail in one round trip. Accounts
    // that failed keep their previous snapshot and are listed with their error, which is
    // why a partial refresh still returns everything that did load.
    const view=await readMailbox(user,requested,e);
    const values=Object.values(accounts);
    return json({...view,refreshed:values.filter(r=>r.ok).length,failed:values.filter(r=>!r.ok).length});
  }catch(error){return failure(error);}
}
