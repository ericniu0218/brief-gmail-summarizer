import { HttpError, type Runtime } from './runtime';
import type { Snapshot } from './sync';
import { completeStoredEmail } from './messages';

/** Parse persisted mailbox data at its trust boundary instead of assuming valid JSON. */
export function parseSnapshot(value:string):Snapshot|undefined{
  try{
    const parsed:unknown=JSON.parse(value);
    if(!parsed||typeof parsed!=='object'||!Array.isArray((parsed as Snapshot).emails))return undefined;
    const snapshot=parsed as Snapshot;
    // Persisted JSON is untrusted at runtime. Drop malformed entries once here so every
    // mailbox consumer can iterate without a null or primitive crashing the whole view.
    // Completed rather than merely filtered: a record missing a sender or an address is
    // repairable, and dropping it would hide mail the user can still read.
    return {...snapshot,emails:snapshot.emails
      .map(email=>completeStoredEmail(email))
      .filter((email):email is NonNullable<typeof email>=>!!email)};
  }catch{return undefined;}
}

/**
 * Update a snapshot with optimistic concurrency. Reply and unsubscribe actions can run
 * beside a sync; the revision check makes one retry against the newest value instead of
 * silently replacing the other action's changes.
 */
export async function mutateSnapshot(user:string,accountId:string,e:Runtime,change:(snapshot:Snapshot)=>void){
  for(let attempt=0;attempt<4;attempt++){
    const row=await e.DB.prepare('SELECT data, revision FROM snapshots WHERE account_id=? AND user_id=?')
      .bind(accountId,user).first<{data:string;revision:number}>();
    if(!row)return false;
    const snapshot=parseSnapshot(row.data);
    if(!snapshot)throw new HttpError(409,'This mailbox cache is damaged. Refresh Gmail and try again.');
    change(snapshot);
    const result=await e.DB.prepare('UPDATE snapshots SET data=?, updated=?, revision=revision+1 WHERE account_id=? AND user_id=? AND revision=?')
      .bind(JSON.stringify(snapshot),Date.now(),accountId,user,row.revision).run();
    if(result.meta.changes)return true;
  }
  throw new HttpError(409,'The inbox changed while saving. Please try again.');
}
