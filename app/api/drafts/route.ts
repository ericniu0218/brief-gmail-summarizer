import { deleteDraft, listDrafts } from '@/server/drafts';
import { ALL_INBOXES } from '@/server/gmail';
import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';

/** The Gmail Drafts folder for one account, or every account in the combined view. */
export async function GET(request:Request){
  try{
    const requested=new URL(request.url).searchParams.get('accountId')||ALL_INBOXES;
    return json(await listDrafts(await userId(),requested,runtime(),new URL(request.url).searchParams.get('countOnly')==='true'));
  }catch(error){return failure(error);}
}

/** Delete a draft from Gmail. */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();
    const input=await inputObject(request);
    if(input.action!=='delete'||typeof input.accountId!=='string'||typeof input.id!=='string')throw new HttpError(400,'Choose a draft to delete.');
    await deleteDraft(user,input.accountId,input.id,runtime());
    return json({deleted:true});
  }catch(error){return failure(error);}
}
