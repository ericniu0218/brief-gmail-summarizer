import { failure, json, userId } from '@/server/runtime';
import { mailbox } from '@/server/mailbox';
export async function GET(){
  try{return json(await mailbox(await userId()));}catch(error){return failure(error);}
}
