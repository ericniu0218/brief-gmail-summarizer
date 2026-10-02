import { cancelScheduled, listScheduled } from '@/server/scheduled';
import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';

/** The signed-in user's queued emails (pending and failed), so they can be reviewed, edited or cancelled. */
export async function GET(){
  try{return json({items:await listScheduled(await userId(),runtime())});}
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
