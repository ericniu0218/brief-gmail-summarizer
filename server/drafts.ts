import { accessToken, ALL_INBOXES, getOwnedConnection, gmail, gmailDelete, ownedConnections } from './gmail';
import { hydrateDeferredBodies, normalizeMessage, parseParties, type GmailMessage } from './message';
import { decode, HttpError, type Runtime } from './runtime';

/**
 * The Gmail Drafts folder, read live from Gmail.
 *
 * Nothing is copied into the app's database: Gmail stays the one place a draft lives, so a
 * draft finished on a phone or deleted in Gmail is simply gone on the next look. Saving from
 * Compose already writes here (server/send.ts), and sending a saved draft deletes it.
 */
export type DraftItem={
  /** Gmail's draft id, which Compose updates in place and Send discards. */
  id:string;
  /** The draft's message id, for opening it in Gmail. */
  messageId:string;
  threadId:string;
  accountId:string;
  accountEmail:string;
  to:string[];cc:string[];bcc:string[];
  subject:string;
  /** The plain text as written, signature included, so editing it here loses nothing. */
  body:string;
  /** When Gmail last saved it. */
  updatedAt:number;
  /** A reply in an existing conversation: edited in Gmail, where the thread is kept. */
  reply:boolean;
  /** Attachments stay in Gmail; Compose here could not carry them over. */
  attachments:number;
  /** Incomplete or rich-only bodies must be edited in Gmail to avoid discarding content. */
  contentComplete?:boolean;
};

/** Drafts read per account per look; Gmail lists newest first. */
export const DRAFTS_PER_ACCOUNT=50;

type DraftResource={id:string;message:GmailMessage};
type Part=GmailMessage['payload'];

/** The first text/plain body in the MIME tree, exactly as written. */
function plainText(part:Part|undefined,depth=0):string|undefined{
  if(!part||typeof part!=='object'||depth>20)return undefined;
  if(part.mimeType?.toLowerCase()==='text/plain'&&!part.filename&&typeof part.body?.data==='string')
    return new TextDecoder().decode(decode(part.body.data));
  for(const child of Array.isArray(part.parts)?part.parts:[]){const found=plainText(child,depth+1);if(found!==undefined)return found;}
  return undefined;
}

const addresses=(value:string|undefined)=>parseParties(value||'').map(party=>party.address).filter(Boolean);

export function draftFrom(resource:DraftResource,account:{id:string;email:string}):DraftItem{
  const normalized=normalizeMessage(resource.message);
  const headers=normalized.headers;
  const plain=plainText(resource.message.payload);
  return {
    id:resource.id,messageId:resource.message.id,threadId:resource.message.threadId||resource.message.id,
    accountId:account.id,accountEmail:account.email,
    to:addresses(headers.to),cc:addresses(headers.cc),bcc:addresses(headers.bcc),
    subject:normalized.subject,
    body:(plain??[normalized.text,normalized.signature].filter(Boolean).join('\n\n')).replace(/\r\n/g,'\n'),
    updatedAt:Number(resource.message.internalDate)||0,
    reply:!!(headers['in-reply-to']||headers.references),
    attachments:normalized.attachments.length,
    contentComplete:normalized.contentComplete&&plain!==undefined&&plain.length<=20000,
  };
}

/** One account's drafts, newest first. */
async function accountDrafts(user:string,account:{id:string;email:string},e:Runtime,countOnly=false):Promise<{items:DraftItem[];count:number;unreadable:number}>{
  const token=await accessToken(user,account.id,e);
  const listed=await gmail<{drafts?:{id:string}[];resultSizeEstimate?:number}>(`drafts?maxResults=${DRAFTS_PER_ACCOUNT}`,token);
  if(countOnly)return {items:[],unreadable:0,count:Math.max(listed.drafts?.length||0,listed.resultSizeEstimate||0)};
  const ids=(listed.drafts||[]).map(draft=>draft.id).filter(id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(id));
  const items:DraftItem[]=[];
  let unreadable=0;
  for(let i=0;i<ids.length;i+=6){
    const chunk=await Promise.allSettled(ids.slice(i,i+6).map(async id=>{
      const resource=await gmail<DraftResource>(`drafts/${encodeURIComponent(id)}?format=full`,token);
      if(resource?.message)await hydrateDeferredBodies(resource.message,attachmentId=>gmail(`messages/${encodeURIComponent(resource.message.id)}/attachments/${encodeURIComponent(attachmentId)}`,token));
      return resource;
    }));
    // A draft deleted between the list and the read is simply gone.
    for(const result of chunk){
      if(result.status==='fulfilled'&&result.value?.message)items.push(draftFrom(result.value,account));
      else if(result.status!=='rejected'||!(result.reason instanceof HttpError&&result.reason.status===404))unreadable++;
    }
  }
  return {items,unreadable,count:Math.max(items.length,listed.resultSizeEstimate||0)};
}

/**
 * Drafts for one account, or for every connected account in the combined view. One account
 * failing (an expired connection, Gmail busy) reports its own error and never hides another's.
 */
export async function listDrafts(user:string,accountId:string,e:Runtime,countOnly=false){
  const accounts=accountId===ALL_INBOXES?await ownedConnections(user,e):[await getOwnedConnection(user,accountId,e)];
  const items:DraftItem[]=[];
  let count=0;
  const failures:{accountId:string;email:string;error:string}[]=[];
  for(const account of accounts){
    try{const result=await accountDrafts(user,{id:account.id,email:account.email},e,countOnly);items.push(...result.items);count+=result.count;if(result.unreadable)failures.push({accountId:account.id,email:account.email,error:`${result.unreadable} drafts could not be read. Reload or open Gmail to review them.`});}
    catch(error){failures.push({accountId:account.id,email:account.email,error:error instanceof HttpError?error.message:'Gmail drafts could not be loaded. Try again.'});}
  }
  items.sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
  return {items,failures,count};
}

/** Delete one draft from Gmail. A draft already gone counts as deleted. */
export async function deleteDraft(user:string,accountId:string,draftId:string,e:Runtime){
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(draftId))throw new HttpError(400,'Choose a draft to delete.');
  const account=await getOwnedConnection(user,accountId,e);
  await gmailDelete(`drafts/${encodeURIComponent(draftId)}`,await accessToken(user,account.id,e));
}
