'use client';
import { useState } from 'react';
import { Info, MessageSquareText, Quote, RotateCcw, ShieldQuestion } from 'lucide-react';
import { actionAccountId, type Email } from '@/lib/mail';
import { SECTIONS, sectionName, tagName, type Section, type Tag } from '@/lib/categories';
import { appliesToUser, isOverdue, isResolved, obligationCorrectionKey, reviewExplanation } from '@/lib/classification';
import { api, ApiError } from '@/hooks/use-inbox';
import { useSenderRule } from '@/hooks/use-sender-rule';
import type { FoldPreference } from '@/lib/folding';

/** The reply decision in a few words, from the message's actual state. */
function replyHeading(email:Email){
  const reply=email.classification?.reply;
  if(email.manualCorrection?.replyPreference==='answered')return 'Marked answered.';
  if(email.manualThreadAnswered)return 'Marked answered.';
  if(email.replied)return 'Replied.';
  if(email.needsReply)return reply?.urgency==='prompt'?'Needs a reply soon.':'Needs a reply.';
  if(reply?.status==='uncertain')return 'Reply unclear.';
  return 'No reply needed.';
}

const CORRECTABLE_TAGS:Tag[]=['deadlines','meetings','requests','actions','research','low-priority'];

/**
 * Full explanation for one message: why it landed where it did, the evidence behind each
 * obligation, and the controls to correct it. Row chips stay compact; detail lives here.
 */
export function ClassificationDetail({email,demo,onApplied,onRefresh,grouping,onGrouping}:{email:Email;demo:boolean;onApplied:(email:Email)=>void;onRefresh?:()=>Promise<boolean>;
  /** How this message folds in the inbox: by the automatic rules, always with its sender, or never. */
  grouping?:'automatic'|FoldPreference;onGrouping?:(value:FoldPreference|undefined)=>void}){
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const senderRule=useSenderRule({email,demo,onApplied,onRefresh});
  const [now]=useState(()=>Date.now());
  const classification=email.classification;
  const tags=email.tags||[];
  const manual=email.manualCorrection;

  async function correct(action:Record<string,unknown>){
    if(demo){setMessage('Corrections apply to a connected mailbox. This is the sample workspace.');return;}
    setBusy(true);
    try{
      const result=await api<{updated:boolean;email?:Email}>('/api/classification',{
        messageId:email.id,accountId:actionAccountId(email),expectedRevision:email.correctionRevision||0,
        expectedSenderRevision:email.senderRuleRevision||0,action,
      });
      if(result.email)onApplied(result.email);
      if((action.type==='set-reply-preference'||action.type==='clear-reply-preference'||action.type==='reset-all')&&onRefresh)
        await onRefresh();
      setMessage(action.type==='reset-all'?'Automatic classification restored.':'Saved. This correction survives future syncs.');
    }catch(error){
      // A conflict means another tab or refresh has newer state. Reload just this account
      // before asking the user to repeat the action, instead of overwriting that state.
      if(error instanceof ApiError&&error.status===409&&email.accountId){
        try{
          const latest=await api<{emails:Email[]}>(`/api/mailbox?accountId=${encodeURIComponent(email.accountId)}`);
          const match=latest.emails.find(item=>item.id===email.id&&item.accountId===email.accountId);
          if(match)onApplied(match);
        }catch{/* Keep the original conflict message when the reload also fails. */}
      }
      setMessage(error instanceof Error?error.message:'Could not save that correction.');
    }
    finally{setBusy(false);}
  }

  const obligations=classification?.obligations||[];
  const reply=classification?.reply;
  return <section className="classification-detail">
    {email.senderFamiliarity?.status==='previously-emailed'&&<div className="classification-summary"><Info size={15}/><p>You previously emailed this sender.</p></div>}
    <div className="classification-summary">
      <Info size={15}/>
      <p>{classification?.reason||'This message has not been classified yet.'}</p>
    </div>
    {reply&&<div className="classification-summary reply-decision">
      <MessageSquareText size={15}/>
      <p><strong>{replyHeading(email)}</strong> {email.replied?'This conversation has been answered.':email.manualThreadAnswered?'You marked this conversation as answered.':reply.explanation}
        {email.needsReply&&reply.due?<> Answer by {reply.due.date||reply.due.phrase}.</>:null}</p>
    </div>}
    {reply?.evidence&&!email.replied&&!email.manualThreadAnswered&&<blockquote className="reply-evidence"><Quote size={11}/> {reply.evidence}</blockquote>}
    {classification&&reviewExplanation(classification)&&<p className="classification-review"><ShieldQuestion size={14}/> {reviewExplanation(classification)}{classification.proposedDisposition==='junk'&&<span className="classification-proposed">Automatic prediction was Junk.</span>}</p>}
    {email.manuallyCorrected&&<p className="classification-proposed">Manual corrections are active for this message.</p>}
    {classification?.uncertainty&&classification.uncertainty!==classification.reviewReason&&<p className="classification-uncertain"><ShieldQuestion size={14}/> {classification.uncertainty}</p>}
    {email.incompleteReasons?.length?<p className="classification-uncertain"><ShieldQuestion size={14}/> Content was incomplete: {email.incompleteReasons.join(', ').replaceAll('-',' ')}.</p>:null}
    {obligations.length>0&&<ul className="obligation-list">
      {obligations.map(obligation=>{const overdue=isOverdue(obligation,now);return <li key={obligation.id} className={isResolved(obligation)?'resolved':undefined}>
        <div className="obligation-head">
          <strong>{tagName(({deadline:'deadlines',meeting:'meetings',request:'requests',action:'actions'} as const)[obligation.kind])}</strong>
          <span className="obligation-state">{overdue?'overdue':isResolved(obligation)?obligation.state:obligation.meetingState&&obligation.kind==='meeting'?obligation.meetingState:obligation.state}</span>
          {!appliesToUser(obligation)&&<span className="obligation-state">{obligation.owner}</span>}
          {obligation.ownerIsUser===null&&<span className="obligation-state">owner unclear</span>}
        </div>
        {obligation.due&&<span className="obligation-due">{obligation.due.date||'No supported date'}{obligation.due.ambiguous?` · from “${obligation.due.phrase}” (${obligation.due.reason||'ambiguous'})`:` · “${obligation.due.phrase}”`}</span>}
        <blockquote><Quote size={11}/> {obligation.evidence}</blockquote>
      </li>})}
    </ul>}
    <button type="button" className="text-button classification-toggle" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
      {open?'Hide correction options':'Change category'}
    </button>
    {open&&<div className="classification-controls">
      <div className="control-row"><span>Section</span><div>
        {SECTIONS.map(section=>{const selected=manual?.category===section.id;return <button key={section.id} type="button" disabled={busy} data-active={selected||undefined}
          title={selected?'Clear this section correction':`Always sort this message into ${sectionName(section.id)}`}
          onClick={()=>void correct(selected?{type:'clear-section'}:{type:'set-section',section:section.id as Section})}>{sectionName(section.id)}</button>})}
      </div></div>
      <div className="control-row"><span>Junk</span><div>
        <button type="button" disabled={busy} data-active={manual?.junkPreference==='not-junk'||undefined}
          onClick={()=>void correct(manual?.junkPreference==='not-junk'?{type:'clear-junk-preference'}:{type:'set-junk-preference',value:'not-junk'})}>Keep</button>
        <button type="button" disabled={busy} data-active={manual?.junkPreference==='junk'||undefined}
          onClick={()=>void correct(manual?.junkPreference==='junk'?{type:'clear-junk-preference'}:{type:'set-junk-preference',value:'junk'})}>Move to Junk</button>
      </div></div>
      <div className="control-row"><span>Reply</span><div>
        <button type="button" disabled={busy} data-active={manual?.replyPreference==='answered'||undefined}
          onClick={()=>void correct(manual?.replyPreference==='answered'?{type:'clear-reply-preference'}:{type:'set-reply-preference',value:'answered'})}>I already replied</button>
        <button type="button" disabled={busy} data-active={manual?.replyPreference==='not-needed'||undefined}
          onClick={()=>void correct(manual?.replyPreference==='not-needed'?{type:'clear-reply-preference'}:{type:'set-reply-preference',value:'not-needed'})}>No reply needed</button>
      </div></div>
      <div className="control-row"><span>This sender</span><div>
        <button type="button" disabled={busy||senderRule.pending!==null} data-active={email.senderJunkPreference==='not-junk'||undefined}
          onClick={()=>void senderRule.save('mark',email.senderJunkPreference==='not-junk'?undefined:'not-junk',{success:email.senderJunkPreference==='not-junk'?'Sender preference removed.':'This sender will always be kept.'})}>Always keep</button>
        <button type="button" disabled={busy||senderRule.pending!==null} data-active={email.senderJunkPreference==='junk'||undefined}
          onClick={()=>void (email.senderJunkPreference==='junk'?senderRule.clearRule():senderRule.markJunk())}>Always move to Junk</button>
      </div></div>
      {onGrouping&&<div className="control-row"><span>Grouping</span><div>
        {([['automatic','Automatic','Fold by conversation, topic and time'],['group','Always group this sender','Fold every message from this sender together'],['separate','Keep separate','Never fold messages from this sender']] as const).map(([value,label,title])=>
          <button key={value} type="button" title={title} data-active={grouping===value||undefined} aria-pressed={grouping===value}
            onClick={()=>onGrouping(value==='automatic'?undefined:value)}>{label}</button>)}
      </div></div>}
      <div className="control-row"><span>Tags</span><div>
        {CORRECTABLE_TAGS.map(tag=>{const added=manual?.addTags.includes(tag),removed=manual?.removeTags.includes(tag),corrected=added||removed;return <button key={tag} type="button" disabled={busy}
          data-active={corrected||undefined} title={removed?`Manually removed ${tagName(tag)}`:added?`Manually added ${tagName(tag)}`:undefined}
          onClick={()=>void correct(corrected?{type:'clear-tag-correction',tag}:{type:tags.includes(tag)?'remove-tag':'add-tag',tag})}>{removed?'Remove: ':added?'Add: ':''}{tagName(tag)}</button>})}
      </div></div>
      {obligations.map((obligation,index)=>{const key=obligationCorrectionKey(obligation),manualState=manual?.obligationStates[key];return <div className="control-row" key={`correction-${obligation.id}`}><span>Task {index+1}</span><div>
        {(['open','completed','cancelled'] as const).map(state=>{const selected=manualState===state;return <button key={state} type="button" disabled={busy}
          data-active={selected||undefined}
          onClick={()=>void correct(selected?{type:'clear-obligation-state',obligationKey:key}:{type:'set-obligation-state',obligationKey:key,state})}>{state}</button>})}
      </div></div>})}
      <button type="button" className="text-button" disabled={busy} onClick={()=>void correct({type:'reset-all'})}>
        <RotateCcw size={13}/> Return to automatic classification
      </button>
      <small>Removes your corrections for this message and uses automatic sorting again.</small>
    </div>}
    {message&&<output className="action-message">{message}</output>}
  </section>;
}
