import { cancelScheduled, listScheduled } from '@/server/scheduled';
import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';

/** The signed-in user's queued emails (pending and failed), so they can be reviewed, edited or cancelled. */
export async function GET(){
  try{
    const e=runtime();
    const heartbeat=await e.DB.prepare('SELECT last_run FROM agent_status WHERE id = ?').bind('scheduler').first<{last_run:number}>();
    return json({items:await listScheduled(await userId(),e),schedulerActive:!!heartbeat&&Date.now()-heartbeat.last_run<40*60000});
  }
  catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();
    const input=await inputObject(request);
    if(input.action!=='cancel'||typeof input.id!=='string'||!/^sch_[A-Za-z0-9_-]{20,80}$/.test(input.id))throw new HttpError(400,'Choose a scheduled email to cancel.');
    await cancelScheduled(user,runtime(),input.id);
    return json({cancelled:true});
  }catch(error){return failure(error);}
}
