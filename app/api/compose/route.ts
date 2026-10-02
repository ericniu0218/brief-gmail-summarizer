import { attachmentProblem, cleanFileName, cleanMediaType, MAX_ATTACHMENT_BYTES } from '@/lib/attachments';
import { accessToken, buildMime, buildRawMessage, getOwnedConnection, parseRecipientGroups } from '@/server/gmail';
import { composeDraft } from '@/server/ai';
import { signatureBlock, userProfile } from '@/server/profile';
import { scheduleEmail } from '@/server/scheduled';
import { deliverOnce, fingerprintOf } from '@/server/send';
import { encode, failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';

const TONES=['Concise','Friendly','Professional'];
/** Room for a 20,000-character message in any script, plus the other fields. */
const JSON_LIMIT=131072;
// JSON for ordinary emails; multipart form data when files are attached.
async function readInput(request:Request):Promise<{input:Record<string,unknown>;files:File[]}> {
  if(!(request.headers.get('content-type')||'').startsWith('multipart/form-data'))return {input:await inputObject(request,JSON_LIMIT),files:[]};
  const length=Number(request.headers.get('content-length'));
  if(Number.isFinite(length)&&length>MAX_ATTACHMENT_BYTES+1048576)throw new HttpError(413,'Attachments are too large. Keep the total under 10.0 MB.');
  let form:FormData;
  try{form=await request.formData();}catch{throw new HttpError(400,'Provide a valid form submission.');}
  const input:Record<string,unknown>={};const files:File[]=[];
  for(const [name,value] of form.entries()){
    if(typeof value==='string')input[name]=value;
    else if(name==='files')files.push(value);
  }
  return {input,files};
}
/**
 * Sends a brand-new email (or saves it as a draft or schedules it) from one of the user's
 * connected mailboxes, or asks the AI to write a draft for the user to review. Nothing here is
 * automatic: the dashboard calls it only when the user clicks Send, Save draft, Schedule, or
 * Write it. The AI never sends.
 */
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const {input,files}=await readInput(request);
    // The mailbox is named by the request and verified here: an email only ever leaves from
    // an account this user owns.
    const owned=await getOwnedConnection(user,typeof input.accountId==='string'?input.accountId:'',e);
    if(input.action==='assist'){
      if(typeof input.notes!=='string'||!input.notes.trim())throw new HttpError(400,'Describe what you want to say first.');
      if(input.notes.length>4000)throw new HttpError(400,'Keep your notes under 4,000 characters.');
      const tone=typeof input.tone==='string'&&TONES.includes(input.tone)?input.tone:'Concise';
      // A saved signature replaces the AI's sign-off name, and is added by the server, never by the AI.
      const profile=await userProfile(user,e);
      const draft=await composeDraft(input.notes,tone,e,profile.signature?undefined:profile.name||undefined);
      const body=profile.signature?`${draft.body.trim()}\n\n${signatureBlock(profile.signature)}`:draft.body.trim();
      return json({subject:draft.subject.replace(/[\r\n]+/g,' ').trim().slice(0,200),body:body.slice(0,20000)});
    }
    const action=input.action;
    if(action!=='send'&&action!=='draft'&&action!=='schedule')throw new HttpError(400,'Choose whether to send, schedule, or save a draft.');
    const {to,cc,bcc}=parseRecipientGroups(input);
    if(typeof input.subject!=='string'||!input.subject.trim())throw new HttpError(400,'Add a subject.');
    if(input.subject.length>200||/[\r\n]/.test(input.subject))throw new HttpError(400,'Keep the subject to one line of up to 200 characters.');
    if(typeof input.body!=='string'||!input.body.trim()||input.body.length>20000)throw new HttpError(400,'Write a message of up to 20,000 characters.');
    if(typeof input.key!=='string'||!/^[a-zA-Z0-9-]{8,64}$/.test(input.key))throw new HttpError(400,'Reload the dashboard and try again.');
    const subject=input.subject.trim();
    if(action==='schedule'){
      if(files.length)throw new HttpError(400,'Emails with attachments cannot be scheduled yet. Send it now, or remove the attachments.');
      const sendAt=typeof input.sendAt==='number'?input.sendAt:Number(input.sendAt);
      const id='sch_'+await fingerprintOf([user,owned.id,'schedule',input.key,to,cc,bcc,subject,input.body,sendAt]);
      return json(await scheduleEmail(user,owned.id,e,id,{to,cc,bcc,subject,body:input.body},sendAt));
    }
    const problem=attachmentProblem(files.map(file=>({name:file.name,size:file.size})));
    if(problem)throw new HttpError(400,problem);
    const confirmUnsent=input.confirmUnsent===true||input.confirmUnsent==='true';
    const token=await accessToken(user,owned.id,e);
    const sendAs:'send'|'draft'=action;
    const send={user,accountId:owned.id,token,e,action:sendAs,noun:'email' as const,reportThread:true,confirmUnsent};
    if(!files.length)return json(await deliverOnce({...send,parts:['compose',input.key,sendAs,to,cc,bcc,subject,input.body],raw:buildRawMessage({to,cc,bcc,subject,body:input.body})}));
    const attachments=await Promise.all(files.map(async file=>({name:cleanFileName(file.name),type:cleanMediaType(file.type),bytes:new Uint8Array(await file.arrayBuffer())})));
    // The file contents are part of the fingerprint, so a retry of the same email is recognised.
    const digests=await Promise.all(attachments.map(async file=>[file.name,file.bytes.length,encode(new Uint8Array(await crypto.subtle.digest('SHA-256',file.bytes)))]));
    return json(await deliverOnce({...send,parts:['compose',input.key,sendAs,to,cc,bcc,subject,input.body,digests],mime:buildMime({to,cc,bcc,subject,body:input.body,attachments})}));
  }catch(error){return failure(error);}
}
