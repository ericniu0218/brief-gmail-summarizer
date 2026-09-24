import { failure, json, runtime, userId } from '@/server/runtime';
import { applyOverride, loadOverrides } from '@/server/overrides';
import { applyPolicy } from '@/lib/classification';
import type { Snapshot } from '@/server/sync';

export async function GET(){
  try{
    const user=await userId();const e=runtime();
    const stored=await runtime().DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    if(!stored)return json({emails:[],ai:false,updated:null});
    const snapshot=JSON.parse(stored.data) as Snapshot;
    // Repair on read: snapshots written before the conflict policy existed can hold a
    // message that was filed as Junk despite an unresolved obligation. Re-deriving from
    // the stored classification restores its visibility without another AI call, and
    // corrections are re-read from their own table so real user intent is preserved.
    const overrides=await loadOverrides(user,e);
    const now=Date.now();
    snapshot.emails=(snapshot.emails||[]).map(email=>{
      if(!email.classification)return email;
      const {classification,category,tags,priority,label}=applyPolicy(applyOverride(email.classification,overrides.get(email.id)),now);
      return {...email,classification,category,tags,priority,label};
    });
    return json(snapshot);
  }catch(error){return failure(error);}
}
