import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { ALL_INBOXES } from '@/server/gmail';
import { readMailbox } from '@/server/mailbox';
import { buildDigest, mergeWording } from '@/server/digest';
import { parseSnapshot } from '@/server/snapshots';
import type { FoldPreferences } from '@/lib/folding';

/** Write digest text for the grouping this browser is actually displaying. */
export async function POST(request:Request){
  try{
    mutation(request);
    const user=await userId(),e=runtime();
    if(!e.GEMINI_API_KEY)throw new HttpError(503,'AI wording is unavailable right now.');
    const input=await inputObject(request,2_000_000);
    const accountId=typeof input.accountId==='string'?input.accountId:'';
    if(!accountId)throw new HttpError(400,'Choose a mailbox for this brief.');
    const raw=input.preferences;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'Grouping choices are invalid.');
    const entries=Object.entries(raw);
    if(entries.length>20000||entries.some(([key,value])=>key.length>1024||value!=='group'&&value!=='separate'))
      throw new HttpError(400,'Grouping choices are invalid.');
    // readMailbox verifies ownership for a single mailbox; the combined view contains
    // only accounts owned by this signed-in user. Email text is always loaded server-side.
    const view=await readMailbox(user,accountId===ALL_INBOXES?ALL_INBOXES:accountId,e);
    const digest=await buildDigest(view.emails,e,view.digest,Date.now(),Object.fromEntries(entries) as FoldPreferences);
    // Save newly written wording with the mailbox each message belongs to, so the next page
    // load or refresh reuses it instead of asking the AI again. Saving is best effort: the
    // wording is returned either way.
    const known=new Set((view.digest?.items||[]).map(item=>`${item.id}\n${item.fp}`));
    const byAccount=new Map<string,NonNullable<typeof digest>['items']>();
    for(const item of digest?.items||[]){
      if(known.has(`${item.id}\n${item.fp}`))continue;
      let owner='';
      try{const first:unknown=(JSON.parse(item.id) as unknown[])[0];owner=typeof first==='string'?first:'';}catch{continue;}
      if(!view.accounts.some(account=>account.id===owner))continue;
      byAccount.set(owner,[...(byAccount.get(owner)||[]),item]);
    }
    for(const [owner,written] of byAccount){
      try{
        const row=await e.DB.prepare('SELECT data, revision FROM snapshots WHERE account_id=? AND user_id=?').bind(owner,user).first<{data:string;revision:number}>();
        const snapshot=row?parseSnapshot(row.data):undefined;
        if(!row||!snapshot)continue;
        // Only the digest field changes and the revision is left alone, so a refresh running
        // at the same time is never made to fail. If one has just published, this is skipped.
        await e.DB.prepare("UPDATE snapshots SET data=json_set(data,'$.digest',json(?)) WHERE account_id=? AND user_id=? AND revision=?")
          .bind(JSON.stringify(mergeWording(snapshot.digest,written)),owner,user,row.revision).run();
      }catch{console.error('Digest wording was written but could not be saved.');}
    }
    return json(digest||{generated:Date.now(),items:[]});
  }catch(error){return failure(error);}
}
