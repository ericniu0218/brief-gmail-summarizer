'use client';
import { useState } from 'react';
import { Sparkles, Send, FilePenLine, RefreshCw, ExternalLink, Wand2, Check, CheckCircle2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/hooks/use-inbox';
import { actionAccountId, gmailLink, type Email } from '@/lib/mail';

/**
 * Review-first reply workflow. Users may generate or polish text, edit it locally, then
 * explicitly save a Gmail draft or send the final wording.
 */
export function ReplyComposer({email,demo,aiReady,onSent}:{email:Email;demo:boolean;aiReady:boolean;onSent:()=>void}){
  const [tone,setTone]=useState('Concise');
  const [text,setText]=useState('');
  const [options,setOptions]=useState<string[]>([]);
  const [chosen,setChosen]=useState(-1);
  const [notes,setNotes]=useState('');
  const [describing,setDescribing]=useState(false);
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState(false);
  const [variation,setVariation]=useState(0);
  const [sent,setSent]=useState('');
  function endpoint(){return demo?'/api/suggest':'/api/reply';}
  async function generate(){
    // Regeneration increments a bounded variation number so the server can request a
    // meaningfully different batch while the current draft remains under user control.
    setBusy('options');setMessage('');setError(false);
    const attempt=options.length?variation+1:0;
    try{
      const result=await api<{options:string[]}>(endpoint(),{id:email.id,accountId:demo?undefined:actionAccountId(email),action:'options',tone,variation:attempt});
      setOptions(result.options);setChosen(-1);setVariation(attempt);
      if(demo)setMessage('Written for the sample inbox. Pick an option, then edit it before trying the reply flow.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not generate reply options.');setError(true);}
    finally{setBusy('');}
  }
  function choose(index:number){setChosen(index);setText(options[index]);setMessage('');setError(false);}
  async function polish(){
    if(!notes.trim())return;
    setBusy('polish');setMessage('');setError(false);
    try{
      const result=await api<{reply:string}>(endpoint(),{id:email.id,accountId:demo?undefined:actionAccountId(email),action:'polish',tone,notes});
      setText(result.reply);setOptions([]);setChosen(-1);
      if(demo)setMessage('Polished for the sample inbox. You can still edit it before trying the reply flow.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not polish your notes into a reply.');setError(true);}
    finally{setBusy('');}
  }
  async function complete(action:'send'|'draft'){
    // Demo mode exercises the interface locally. Connected mode is the only branch that
    // calls the Gmail-changing reply endpoint.
    setBusy(action);setMessage('');setError(false);
    try{
      if(demo){setMessage(action==='send'?'Demo reply complete. No email was sent.':'Demo draft saved for this conversation.');if(action==='send'){setSent(text);onSent();}}
      else{await api('/api/reply',{id:email.id,accountId:actionAccountId(email),action,body:text});setMessage(action==='send'?'Reply sent through Gmail.':'Draft saved in Gmail.');if(action==='send'){setSent(text);onSent();}}
    }catch(error){setMessage(error instanceof Error?error.message:'Could not complete your reply.');setError(true);}
    finally{setBusy('');}
  }
  function writeAnother(){setSent('');setText('');setOptions([]);setChosen(-1);setNotes('');setMessage('');setError(false);}
  if(sent)return <div className="reply-area">
    <div className="reply-sent"><CheckCircle2 size={18}/><strong>{demo?'Demo reply sent':'Reply sent through Gmail'}</strong></div>
    <div className="reply-sent-body"><span>To {email.sender}</span><p>{sent}</p></div>
    <p className="reply-disclaimer">{demo?'Demo mode · This reply was never sent to Gmail — it only updated the sample inbox.':'Delivered to Gmail. You can still send another reply to this conversation.'}</p>
    <button className="button white full" onClick={writeAnother}><FilePenLine size={14}/>Write another reply</button>
    {!demo&&<a className="gmail-link" href={gmailLink(email)} target="_blank" rel="noreferrer">Open conversation in Gmail <ExternalLink size={12}/></a>}
  </div>;
  return <div className="reply-area">
    <span className="reply-label"><Sparkles size={16}/>{demo?'Try a suggested reply':'Reply with a little help'}</span>
    {/* The sending mailbox is the one this message arrived in, shown so the address is
        never a surprise when several accounts are connected. */}
    {!demo&&email.accountEmail&&<span className="reply-sender">Sending as {email.accountEmail}</span>}
    <div className="reply-controls">
      <Tabs value={tone} onValueChange={v=>setTone(String(v))}><TabsList>{['Concise','Friendly','Professional'].map(t=><TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}</TabsList></Tabs>
      <button className="generate-button" disabled={!!busy||!aiReady} onClick={generate}>{busy==='options'?<RefreshCw className="spinning" size={14}/>:<Sparkles size={14}/>} {options.length?'Regenerate options':'Generate options'}</button>
    </div>
    {!aiReady&&<p>Suggested replies need the AI service connected in the Site settings. You can still write your own reply.</p>}
    {message&&<output className={`action-message${error?' error':''}`} aria-live="assertive">{message}</output>}
    {!!options.length&&<div className="reply-options">{options.map((option,index)=><button key={index} className="reply-option" data-active={chosen===index||undefined} disabled={!!busy} onClick={()=>choose(index)}><span className="reply-option-index">{chosen===index?<Check size={12}/>:index+1}</span><p>{option}</p></button>)}</div>}
    <div className="reply-describe">
      <button className="reply-describe-toggle" onClick={()=>setDescribing(v=>!v)} aria-expanded={describing}><Wand2 size={13}/>{describing?'Hide':'Or describe what you want to say, and let AI write it'}</button>
      {describing&&<div className="reply-describe-body"><textarea aria-label="Describe your reply" placeholder="e.g. tell them I'll have it reviewed by Friday and ask for two more days" value={notes} onChange={e=>setNotes(e.target.value)} maxLength={4000}/><button className="button white" disabled={!notes.trim()||!!busy||!aiReady} onClick={polish}>{busy==='polish'?<RefreshCw className="spinning" size={14}/>:<Wand2 size={14}/>}{busy==='polish'?'Polishing…':'Polish into a reply'}</button></div>}
    </div>
    <textarea aria-label="Reply message" placeholder="Generate options, describe what to say, or write a reply in your own words…" value={text} onChange={e=>{setText(e.target.value);setChosen(-1);}} maxLength={20000}/>
    <div className="reply-footer"><button className="button white" onClick={()=>complete('draft')} disabled={!text.trim()||!!busy}><FilePenLine size={14}/>{busy==='draft'?'Saving…':'Save draft'}</button><button className="button blue" onClick={()=>complete('send')} disabled={!text.trim()||!!busy}><Send size={14}/>{busy==='send'?'Sending…':demo?'Try reply':'Send reply'}</button></div>
    <p className="reply-disclaimer">{demo?'Demo mode · Replies are AI-generated drafts for the sample inbox. Nothing is sent to Gmail.':'Generated replies are drafts. Review the wording before sending.'}</p>
    {!demo&&<a className="gmail-link" href={gmailLink(email)} target="_blank" rel="noreferrer">Open conversation in Gmail <ExternalLink size={12}/></a>}
  </div>;
}
