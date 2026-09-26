import { failure, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { getOwnedConnection, ownedConnections, refreshTokenFor } from '@/server/gmail';

/**
 * Disconnects one mailbox. Ownership is verified first, then only that account's records
 * are removed — every other connected mailbox keeps its mail, corrections and receipts.
 *
 * Revocation at Google is best-effort and reported honestly. Google may revoke sibling
 * grants issued to the same OAuth client, so `revoked` describes what this request was
 * told, not a guarantee about other mailboxes.
 *
 * Published team artifacts are intentionally left alone: they belong to the workspace that
 * accepted them, and removing a private Gmail connection is not consent to delete shared
 * work that other people may be relying on.
 */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const body=await inputObject(request);
    // Rejects a foreign account, an unknown id and the reserved combined-view selection.
    const owned=await getOwnedConnection(user,typeof body.accountId==='string'?body.accountId:'',e);

    let revoked=false;
    try{
      const refresh=await refreshTokenFor(owned,e);
      const response=await fetch('https://oauth2.googleapis.com/revoke',{method:'POST',body:new URLSearchParams({token:refresh}),signal:AbortSignal.timeout(10000)});
      revoked=response.ok;
    }catch{revoked=false;}

    // Deleting the connection first stops an in-flight refresh from publishing: its
    // lease check requires the row to still exist, so a late sync cannot recreate it.
    await e.DB.batch([
      e.DB.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?').bind(owned.id,user),
      ...['snapshots','mailbox_messages','sender_rules','unsubscribed','operations','overrides'].map(table=>
        e.DB.prepare(`DELETE FROM ${table} WHERE account_id = ? AND user_id = ?`).bind(owned.id,user)),
    ]);

    // If the disconnected mailbox was the default, promote another one the user owns.
    // With nothing left the preference is removed entirely and the app returns to demo mode.
    const remaining=await ownedConnections(user,e);
    const preference=await e.DB.prepare('SELECT default_account_id FROM account_preferences WHERE user_id = ?').bind(user).first<{default_account_id:string}>();
    let defaultAccountId=preference?.default_account_id||null;
    if(preference?.default_account_id===owned.id||!remaining.length){
      if(remaining.length){
        defaultAccountId=remaining[0].id;
        await e.DB.prepare('UPDATE account_preferences SET default_account_id = ? WHERE user_id = ?').bind(defaultAccountId,user).run();
      }else{
        defaultAccountId=null;
        await e.DB.prepare('DELETE FROM account_preferences WHERE user_id = ?').bind(user).run();
      }
    }
    // Report the preference that is actually stored. Naming the first remaining mailbox
    // would be wrong whenever a different one is the default and was left untouched.
    return json({disconnected:true,revoked,remaining:remaining.length,defaultAccountId});
  }catch(error){return failure(error);}
}
