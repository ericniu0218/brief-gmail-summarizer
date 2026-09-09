import { failure, json, runtime, userId } from '@/server/runtime';
export async function GET(){
  try{
    const user=await userId();
    const snapshot=await runtime().DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    return json(snapshot?JSON.parse(snapshot.data):{emails:[],ai:false,updated:null});
  }catch(error){return failure(error);}
}
