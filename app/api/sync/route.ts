import { failure, json, mutation, runtime, userId } from '@/server/runtime';
import { syncInbox } from '@/server/sync';
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const existing=await e.DB.prepare('SELECT data, updated FROM snapshots WHERE user_id = ?').bind(user).first<{data:string;updated:number}>();
    if(existing && Date.now()-existing.updated<60000)return json(JSON.parse(existing.data));
    return json(await syncInbox(user,e));
  }catch(error){return failure(error);}
}
