import { gmail } from './gmail';
import { parseParties, type NormalizedMessage } from './message';
import { asSenderFamiliarity, type SenderFamiliarity } from '@/lib/sender-familiarity';
import { normalizeAddress } from '@/lib/recipients';
import type { Runtime } from './runtime';

export const SENDER_CHECKS_PER_REFRESH=10;
const WEEK=7*86400000;

/** Only sent metadata is read. No sent body or contact permission is needed. */
export async function checkSenderFamiliarity(address:string,priorTo:number,token:string,now=Date.now()):Promise<SenderFamiliarity|undefined>{
  const normalized=normalizeAddress(address);
  if(!normalized||!Number.isSafeInteger(priorTo)||priorTo<=0)return undefined;
  const query=`in:sent to:"${normalized}" before:${Math.floor(priorTo/1000)}`;
  try{
    const list=await gmail<{messages?:{id:string}[]}>(`messages?labelIds=SENT&maxResults=3&q=${encodeURIComponent(query)}`,token);
    for(const ref of list.messages||[]){
      const sent=await gmail<{labelIds?:string[];internalDate?:string;payload?:{headers?:{name:string;value:string}[]}}>(
        `messages/${encodeURIComponent(ref.id)}?format=metadata&metadataHeaders=To`,token);
      const time=Number(sent.internalDate);
      const recipients=(sent.payload?.headers||[]).filter(header=>header.name.toLowerCase()==='to')
        .flatMap(header=>parseParties(header.value));
      if(sent.labelIds?.includes('SENT')&&time>0&&time<priorTo&&recipients.some(party=>party.address===normalized.toLowerCase()))
        return {status:'previously-emailed',checkedAt:now,priorTo};
    }
    return {status:'unknown',checkedAt:now,priorTo};
  }catch{return undefined;}// Unavailable history proves nothing and gets another chance next refresh.
}

/** Reuse mailbox-scoped evidence across messages; at most three senders are checked concurrently. */
export async function attachSenderFamiliarity(messages:NormalizedMessage[],user:string,accountId:string,token:string,e:Runtime,now=Date.now()){
  const senders=new Map<string,NormalizedMessage[]>();
  for(const message of messages){
    if(!Array.isArray(message.labels))continue;
    if(message.distribution?.bulkPrecedence||message.distribution?.listUnsubscribe||message.labels.includes('SPAM'))continue;
    const address=normalizeAddress(message.from.address)?.toLowerCase();
    if(address)(senders.get(address)??(senders.set(address,[]),senders.get(address)!)).push(message);
  }
  const entries=[...senders];
  const cached=new Map<string,SenderFamiliarity[]>();
  for(let i=0;i<entries.length;i+=60){
    const addresses=entries.slice(i,i+60).map(([address])=>address);
    const rows=await e.DB.prepare(`SELECT lower(json_extract(data,'$.address')) AS address,json_extract(data,'$.senderFamiliarity') AS signal FROM mailbox_messages
      WHERE user_id=? AND account_id=? AND lower(json_extract(data,'$.address')) IN (${addresses.map(()=>'?').join(',')})
      AND json_extract(data,'$.senderFamiliarity') IS NOT NULL`)
      .bind(user,accountId,...addresses).all<{address:string;signal:string}>();
    for(const row of rows.results||[]){
      let signal:SenderFamiliarity|undefined;
      try{signal=asSenderFamiliarity(JSON.parse(row.signal));}catch{continue;}
      if(signal)(cached.get(row.address)??(cached.set(row.address,[]),cached.get(row.address)!)).push(signal);
    }
  }
  let remaining=SENDER_CHECKS_PER_REFRESH;
  for(let i=0;i<entries.length;i+=3)await Promise.all(entries.slice(i,i+3).map(async([address,batch])=>{
    const priorTo=Math.min(...batch.map(message=>message.receivedAt));
    let signal:SenderFamiliarity|undefined=(cached.get(address)||[]).filter(item=>item.priorTo<=priorTo&&item.checkedAt<=now&&
      (item.status==='previously-emailed'||item.checkedAt>now-WEEK))
      .sort((a,b)=>Number(b.status==='previously-emailed')-Number(a.status==='previously-emailed')||b.checkedAt-a.checkedAt)[0];
    let attemptedAt=0;
    if(!signal&&remaining>0){remaining--;attemptedAt=now;signal=await checkSenderFamiliarity(address,priorTo,token,now);}
    for(const message of batch){message.senderFamiliarity=signal;message.senderFamiliarityDeferred=!signal;message.senderFamiliarityAttemptedAt=attemptedAt;}
  }));
}
