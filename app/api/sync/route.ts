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
    const body=await inputObject(request);
    const requested=typeof body.accountId==='string'?body.accountId:ALL_INBOXES;
    const explicit=body.explicit===true;
    // The combined refresh visits the mailbox that waited longest first. A fixed order
    // would always spend the request's time on the same accounts, leaving the last one
    // permanently stale once there are more mailboxes than one request can refresh.
    const targets=requested===ALL_INBOXES
      ? (await ownedConnections(user,e)).sort((a,b)=>(a.last_sync||0)-(b.last_sync||0))
      : [await getOwnedConnection(user,requested,e)];
    const accounts:Record<string,{ok:boolean;error?:string}>={};
    // How much Gmail work one request will start. Each account's own refresh is a single
    // bounded page under its own lease, so this only decides how many of them are begun:
    // the rest keep their cursor and continue on the next refresh.
    const deadline=Date.now()+20000;
    for(const target of targets){
      const accountId=target.id;
      if(targets.length>1&&Date.now()>deadline){accounts[accountId]={ok:false,error:'Not refreshed yet — this refresh ran out of time. Refresh again to continue.'};continue;}
      try{
        // A very recent snapshot absorbs double-clicks without repeating Gmail work.
        const existing=await e.DB.prepare('SELECT snapshots.updated, connections.sync_page_token FROM connections LEFT JOIN snapshots ON snapshots.account_id=connections.id AND snapshots.user_id=connections.user_id WHERE connections.id=? AND connections.user_id=?')
          .bind(accountId,user).first<{updated:number|null;sync_page_token:string|null}>();
        // A very recent snapshot absorbs double-clicks from automatic refreshes. A person
        // pressing Refresh is asking for new mail, so their request is never suppressed.
        if(!explicit&&existing?.updated&&!existing.sync_page_token&&Date.now()-existing.updated<60000){accounts[accountId]={ok:true};continue;}
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
    const failures=targets.flatMap(target=>accounts[target.id]?.ok?[]:[{accountId:target.id,email:target.email,error:accounts[target.id]?.error||'Refresh failed.'}]);
    return json({...view,refreshed:values.filter(r=>r.ok).length,failed:failures.length,failures});
  }catch(error){return failure(error);}
}
