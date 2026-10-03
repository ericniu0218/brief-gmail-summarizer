import { failure, HttpError, inputBytes, json, mutation, runtime, userId } from '@/server/runtime';
import {
  activeJunkPreference,
  applyCorrection,
  automaticBaseline,
  composeClassification,
  CORRECTABLE_STATES,
  CORRECTABLE_TAGS,
  loadOverride,
  loadSenderRules,
  manualCorrectionView,
  normalizeSenderAddress,
  saveSenderRule,
  senderRuleFor,
  withSenderRule,
  type CorrectionAction,
  type JunkPreference,
} from '@/server/overrides';
import { getOwnedConnection } from '@/server/gmail';
import { obligationCorrectionKey } from '@/lib/classification';
import type { Section, Tag } from '@/lib/categories';
import type { Snapshot, StoredEmail } from '@/server/sync';
import { parseSnapshot } from '@/server/snapshots';
import { loadMessage } from '@/server/messages';

const SECTIONS:Section[]=['work','personal','noise'];
const MAX_MESSAGE_ID=1024;
const MAX_OBLIGATION_KEY=2048;
const MAX_BODY_BYTES=16384;

/** Strictly decode one command. Omitted fields never double as “clear this value”. */
function correctionAction(value:unknown):CorrectionAction{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Choose one correction action.');
  const action=value as Record<string,unknown>;
  const exact=(allowed:string[])=>{
    if(Object.keys(action).some(key=>!allowed.includes(key)))throw new HttpError(400,'A correction must contain only the fields used by its action.');
  };
  switch(action.type){
    case 'set-section':
      exact(['type','section']);
      if(!SECTIONS.includes(action.section as Section))break;
      return {type:'set-section',section:action.section as Section};
    case 'clear-section':exact(['type']);return {type:'clear-section'};
    case 'set-junk-preference':
      exact(['type','value']);
      if(action.value!=='junk'&&action.value!=='not-junk')break;
      return {type:'set-junk-preference',value:action.value};
    case 'clear-junk-preference':exact(['type']);return {type:'clear-junk-preference'};
    case 'add-tag':case 'remove-tag':case 'clear-tag-correction':
      exact(['type','tag']);
      if(!CORRECTABLE_TAGS.includes(action.tag as Tag))break;
      return {type:action.type,tag:action.tag as Tag};
    case 'set-obligation-state':
      exact(['type','obligationKey','state']);
      if(typeof action.obligationKey!=='string'||!action.obligationKey||action.obligationKey.length>MAX_OBLIGATION_KEY||
        !CORRECTABLE_STATES.includes(action.state as typeof CORRECTABLE_STATES[number]))break;
      return {type:'set-obligation-state',obligationKey:action.obligationKey,state:action.state as typeof CORRECTABLE_STATES[number]};
    case 'clear-obligation-state':
      exact(['type','obligationKey']);
      if(typeof action.obligationKey!=='string'||!action.obligationKey||action.obligationKey.length>MAX_OBLIGATION_KEY)break;
      return {type:'clear-obligation-state',obligationKey:action.obligationKey};
    case 'set-reply-preference':
      exact(['type','value']);
      if(action.value!=='answered'&&action.value!=='not-needed')break;
      return {type:'set-reply-preference',value:action.value};
    case 'clear-reply-preference':exact(['type']);return {type:'clear-reply-preference'};
    case 'reset-all':exact(['type']);return {type:'reset-all'};
  }
  throw new HttpError(400,'That correction action is not supported.');
}

async function correctionBody(request:Request):Promise<Record<string,unknown>>{
  const text=new TextDecoder().decode(await inputBytes(request,MAX_BODY_BYTES));
  try{
    const value:unknown=JSON.parse(text);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('bad body');
    return value as Record<string,unknown>;
  }catch{throw new HttpError(400,'Send a valid correction request.');}
}

/** Whether an "I already replied" mark on this or a later message in its conversation covers it. */
async function answeredInThread(user:string,accountId:string,email:StoredEmail,e:ReturnType<typeof runtime>){
  if(!email.threadId||!email.receivedAt)return false;
  const mark=await e.DB.prepare(`SELECT 1 AS found FROM mailbox_messages m JOIN overrides o ON o.account_id=m.account_id AND o.user_id=m.user_id AND o.message_id=m.message_id
    WHERE m.account_id=? AND m.user_id=? AND json_extract(m.data,'$.threadId')=? AND m.received_at>=? AND o.active=1 AND o.reply_preference='answered' LIMIT 1`)
    .bind(accountId,user,email.threadId,email.receivedAt).first();
  return !!mark;
}

function findMessage(snapshot:Snapshot,messageId:string):StoredEmail{
  const matches=snapshot.emails.filter(email=>email?.id===messageId);
  if(matches.length!==1)throw new HttpError(404,'That message is not available in this mailbox. Refresh and try again.');
  return matches[0];
}

export async function POST(request:Request){
  try{
    mutation(request);
    const user=await userId(),e=runtime(),body=await correctionBody(request);
    const messageId=typeof body.messageId==='string'?body.messageId:'';
    if(!messageId||messageId.length>MAX_MESSAGE_ID)throw new HttpError(400,'Tell us which message to correct.');
    const expectedRevision=body.expectedRevision;
    if(!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0)throw new HttpError(400,'Reload this message before saving a correction.');
    const rawAction=body.action;
    const senderAction=rawAction&&typeof rawAction==='object'&&!Array.isArray(rawAction)&&
      ((rawAction as {type?:unknown}).type==='set-sender-junk-preference'||(rawAction as {type?:unknown}).type==='clear-sender-junk-preference');
    const action=senderAction?undefined:correctionAction(rawAction);

    // Ownership is checked before both the snapshot read and correction write. Message
    // ids are only meaningful together with their account id.
    const owned=await getOwnedConnection(user,typeof body.accountId==='string'?body.accountId:'',e);
    const rowSource=await loadMessage(user,owned.id,messageId,e);
    const stored=rowSource?undefined:await e.DB.prepare('SELECT data FROM snapshots WHERE account_id = ? AND user_id = ?').bind(owned.id,user).first<{data:string}>();
    const parsed=stored?parseSnapshot(stored.data):undefined;
    const source=rowSource||(parsed?findMessage(parsed,messageId):undefined);
    if(!source)throw new HttpError(404,'Refresh this mailbox before correcting a message.');
    const automatic=automaticBaseline(source.automaticClassification)??automaticBaseline(source.classification);
    // A manually altered legacy snapshot cannot reveal what the classifier originally
    // chose. Reset fails without clearing anything; the next sync creates a clean baseline.
    if(!automatic)throw new HttpError(409,action?.type==='reset-all'
      ?'Refresh this mailbox before returning the message to automatic classification.'
      :'Refresh this mailbox before saving a correction.');

    if(action?.type==='set-obligation-state'||action?.type==='clear-obligation-state'){
      const matches=automatic.obligations.filter(item=>obligationCorrectionKey(item)===action.obligationKey);
      if(matches.length!==1)throw new HttpError(409,'That task changed during classification. Refresh and review it again.');
    }

    let manual=await loadOverride(user,owned.id,messageId,e);
    const senderAddress=normalizeSenderAddress(source.address);
    let senderRule=senderAddress?senderRuleFor(await loadSenderRules(user,owned.id,e),senderAddress):undefined;
    if(senderAction){
      const sender=rawAction as Record<string,unknown>;
      const setting=sender.type==='set-sender-junk-preference';
      const allowed=setting?['type','value']:['type'];
      if(Object.keys(sender).some(key=>!allowed.includes(key)))throw new HttpError(400,'A sender preference contains unsupported fields.');
      if(!senderAddress)throw new HttpError(409,'This message does not have a usable sender address.');
      const expectedSenderRevision=body.expectedSenderRevision;
      if(!Number.isSafeInteger(expectedSenderRevision)||Number(expectedSenderRevision)<0)throw new HttpError(400,'Reload this message before saving a sender preference.');
      let value:JunkPreference|undefined;
      if(setting){
        if(sender.value!=='junk'&&sender.value!=='not-junk')throw new HttpError(400,'Choose whether to keep this sender or move it to Junk.');
        value=sender.value;
      }
      senderRule=await saveSenderRule(user,owned.id,senderAddress,Number(expectedSenderRevision),value,e);
    }else manual=await applyCorrection(user,owned.id,messageId,Number(expectedRevision),action!,e);
    // A sync may have published newer source content while the correction was being
    // saved. Re-read the snapshot and compose against its automatic baseline so the
    // response cannot paint an older message body or classifier result over the UI.
    const latestRow=await loadMessage(user,owned.id,messageId,e);
    const latestStored=latestRow?undefined:await e.DB.prepare('SELECT data FROM snapshots WHERE account_id = ? AND user_id = ?').bind(owned.id,user).first<{data:string}>();
    // The correction is already durable. A concurrently replaced or corrupt snapshot
    // must not turn that successful write into an error response that invites a retry.
    const latestSnapshot=latestStored?parseSnapshot(latestStored.data):undefined;
    const latestSource=latestRow??latestSnapshot?.emails.find(item=>item?.id===messageId)??source;
    const latestAutomatic=automaticBaseline(latestSource.automaticClassification)??automaticBaseline(latestSource.classification)??automatic;
    const effective=withSenderRule(manual,senderRule,messageId);
    const {classification,category,tags,priority,label}=composeClassification(latestAutomatic,effective,Date.now());
    // The same conversation-wide "I already replied" rule the mailbox read applies, so a
    // correction to an earlier message cannot bring its reply badge back.
    const manualThreadAnswered=await answeredInThread(user,owned.id,latestSource,e);
    const email:StoredEmail={...latestSource,accountId:owned.id,accountEmail:owned.email,
      automaticClassification:latestAutomatic,classification,category,tags,priority,label,manualThreadAnswered,
      needsReply:!latestSource.replied&&!manualThreadAnswered&&classification.replyRequired,
      correctionRevision:manual?.revision??0,manuallyCorrected:manual?.active!==false&&!!manual,
      manualCorrection:manualCorrectionView(manual),
      senderJunkPreference:activeJunkPreference(senderRule),senderRuleRevision:senderRule?.revision??0,
      automaticClassificationAvailable:true};
    // Return only the affected record. Replacing a whole inbox from this response could
    // overwrite a newer background refresh or the mailbox currently visible in the UI.
    return json({updated:true,email,revision:manual?.revision??0,senderRuleRevision:senderRule?.revision??0,
      senderJunkPreference:activeJunkPreference(senderRule)??null});
  }catch(error){return failure(error);}
}
