import { effectiveClassification, type Classification } from './classification';
import { assessPurpose } from './purpose';

/** Sent-mail evidence, scoped to the receiving mailbox. Unknown never means stranger. */
export type SenderFamiliarity={status:'previously-emailed'|'unknown';checkedAt:number;priorTo:number};

export function asSenderFamiliarity(value:unknown):SenderFamiliarity|undefined{
  if(!value||typeof value!=='object')return undefined;
  const signal=value as SenderFamiliarity;
  if(!['previously-emailed','unknown'].includes(signal.status)||!Number.isSafeInteger(signal.checkedAt)||!Number.isSafeInteger(signal.priorTo)||signal.checkedAt<=0||signal.priorTo<=0)return undefined;
  return {status:signal.status,checkedAt:signal.checkedAt,priorTo:signal.priorTo};
}

/** Familiarity prevents burying ambiguous direct mail, not legitimate spam detection. */
export function withSenderFamiliarity(classification:Classification,message:{
  subject:string;text:string;from:{address:string};labels:string[];
  receivedAt:number;distribution?:{listUnsubscribe:boolean;bulkPrecedence:boolean};senderFamiliarity?:SenderFamiliarity;
}):Classification{
  const base={...classification,priorCorrespondence:undefined};
  const signal=asSenderFamiliarity(message.senderFamiliarity);
  if(signal?.status!=='previously-emailed'||signal.priorTo>message.receivedAt)return base;
  if(message.labels.includes('SPAM')||message.distribution?.bulkPrecedence||message.distribution?.listUnsubscribe)return base;
  if(assessPurpose(message).promotion!=='absent')return base;
  const junk=(classification.proposedDisposition??classification.disposition)==='junk';
  return effectiveClassification({...base,priorCorrespondence:true,
    reason:junk?'You previously emailed this sender; this direct message was kept for review.':base.reason});
}
