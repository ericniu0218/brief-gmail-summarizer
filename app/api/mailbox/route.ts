import { failure, json, runtime, userId } from '@/server/runtime';
import { ALL_INBOXES } from '@/server/gmail';
import { readMailbox } from '@/server/mailbox';

/** Stored mail for one mailbox, or the combined feed across every connected mailbox. */
export async function GET(request:Request){
  try{
    const user=await userId();
    const requested=new URL(request.url).searchParams.get('accountId')||ALL_INBOXES;
    return json(await readMailbox(user,requested,runtime()));
  }catch(error){return failure(error);}
}
