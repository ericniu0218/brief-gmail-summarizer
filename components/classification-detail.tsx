'use client';
import { useState } from 'react';
import { Info, Quote, RotateCcw, ShieldQuestion } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { SECTIONS, sectionName, tagName, type Section, type Tag } from '@/lib/categories';
import { appliesToUser, isOverdue, isResolved, reviewExplanation } from '@/lib/classification';
import { api } from '@/hooks/use-inbox';

const CORRECTABLE_TAGS:Tag[]=['deadlines','meetings','requests','actions','research','low-priority'];

/**
 * Full explanation for one message: why it landed where it did, the evidence behind each
 * obligation, and the controls to correct it. Row chips stay compact; detail lives here.
 */
export function ClassificationDetail({email,demo,onApplied}:{email:Email;demo:boolean;onApplied:(emails:Email[])=>void}){
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [now]=useState(()=>Date.now());
  const classification=email.classification;
  const tags=email.tags||[];

  async function correct(body:Record<string,unknown>){
    if(demo){setMessage('Corrections apply to a connected mailbox. This is the sample workspace.');return;}
    setBusy(true);
    try{
      const result=await api<{updated:boolean;emails?:Email[]}>('/api/classification',{messageId:email.id,...body});
      if(result.emails)onApplied(result.emails);
      setMessage('Saved. This correction survives future syncs.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not save that correction.');}
    finally{setBusy(false);}
  }

  const obligations=classification?.obligations||[];
  return <section className="classification-detail">
    <div className="classification-summary">
      <Info size={15}/>
      <p>{classification?.reason||'This message has not been classified yet.'}</p>
    </div>
    {classification&&reviewExplanation(classification)&&<p className="classification-review"><ShieldQuestion size={14}/> {reviewExplanation(classification)}{classification.proposedDisposition==='junk'&&<span className="classification-proposed">Automatic prediction was Junk.</span>}</p>}
    {classification?.uncertainty&&classification.uncertainty!==classification.reviewReason&&<p className="classification-uncertain"><ShieldQuestion size={14}/> {classification.uncertainty}</p>}
    {email.incompleteReasons?.length?<p className="classification-uncertain"><ShieldQuestion size={14}/> Content was incomplete: {email.incompleteReasons.join(', ').replaceAll('-',' ')}.</p>:null}
    {obligations.length>0&&<ul className="obligation-list">
      {obligations.map(obligation=>{const overdue=isOverdue(obligation,now);return <li key={obligation.id} className={isResolved(obligation)?'resolved':undefined}>
        <div className="obligation-head">
          <strong>{tagName(({deadline:'deadlines',meeting:'meetings',request:'requests',action:'actions'} as const)[obligation.kind])}</strong>
          <span className="obligation-state">{overdue?'overdue':obligation.meetingState&&obligation.kind==='meeting'?obligation.meetingState:obligation.state}</span>
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
        {SECTIONS.map(section=><button key={section.id} type="button" disabled={busy} data-active={email.category===section.id||undefined}
          onClick={()=>void correct({category:section.id as Section,notJunk:section.id!=='noise'})}>{sectionName(section.id)}</button>)}
      </div></div>
      <div className="control-row"><span>Tags</span><div>
        {CORRECTABLE_TAGS.map(tag=><button key={tag} type="button" disabled={busy} data-active={tags.includes(tag)||undefined}
          onClick={()=>void correct(tags.includes(tag)?{removeTags:[tag]}:{addTags:[tag]})}>{tagName(tag)}</button>)}
      </div></div>
      {obligations.length>0&&<div className="control-row"><span>Task status</span><div>
        {(['open','completed','cancelled'] as const).map(state=><button key={state} type="button" disabled={busy}
          onClick={()=>void correct({obligationState:state})}>{state}</button>)}
      </div></div>}
      <button type="button" className="text-button" disabled={busy} onClick={()=>void correct({reset:true})}>
        <RotateCcw size={13}/> Return to automatic classification
      </button>
    </div>}
    {message&&<output className="action-message">{message}</output>}
  </section>;
}
