import { failure, json, mutation, runtime, userId } from '@/server/runtime';
import { syncInbox } from '@/server/sync';

/** Starts a user-requested Gmail refresh, with a one-minute cache guard. */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    // Reuse a very recent snapshot to absorb double-clicks and remounts without repeating
    // Gmail and AI work.
    const existing=await e.DB.prepare('SELECT data, updated FROM snapshots WHERE user_id = ?').bind(user).first<{data:string;updated:number}>();
    if(existing && Date.now()-existing.updated<60000)return json(JSON.parse(existing.data));
    return json(await syncInbox(user,e));
  }catch(error){return failure(error);}
}
