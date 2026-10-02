'use client';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { CalendarClock, CheckCircle2, ExternalLink, FilePenLine, Paperclip, Send, Undo2, Wand2, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RecipientField, type Contact } from '@/components/recipient-field';
import { api, ApiError } from '@/hooks/use-inbox';
import { attachmentProblem, formatBytes, MAX_ATTACHMENTS } from '@/lib/attachments';
import { gmailThreadUrl } from '@/lib/mail';

type Receipt={id:string;status:'sent'|'drafted';threadId?:string};
/** `accountId` is the mailbox the email leaves from; empty means the preferred one. */
export type ComposeFields={to:string;cc:string;bcc:string;subject:string;body:string;accountId:string};
export const emptyCompose:ComposeFields={to:'',cc:'',bcc:'',subject:'',body:'',accountId:''};
export const UNDO_SECONDS=10;
const TONES=['Concise','Friendly','Professional'];
const stamp=(time:number)=>new Date(time).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
// datetime-local inputs read and write local time without a zone.
const localValue=(date:Date)=>new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
function schedulePresets():[string,Date][] {
  const now=new Date();
  const tomorrow=new Date(now);tomorrow.setDate(now.getDate()+1);tomorrow.setHours(8,0,0,0);
  const monday=new Date(now);monday.setDate(now.getDate()+(((8-now.getDay())%7)||7));monday.setHours(8,0,0,0);
  return [['In 1 hour',new Date(now.getTime()+3600000)],['Tomorrow, 8:00 AM',tomorrow],['Monday, 8:00 AM',monday]];
}
type Sent={to:string;cc:string;from:string;threadId?:string;scheduledFor?:number};
type Mailbox={id:string;email:string};

/**
 * Writes a brand-new email. Nothing leaves until the person clicks Send, and every send waits a
 * few seconds with an Undo. The AI can draft text here but cannot send.
 */
export function ComposeDialog({open,onOpenChange,demo,aiReady,fields,onFields,blank,contacts,mailboxes,preferredAccountId,onScheduled}:{open:boolean;onOpenChange:(open:boolean)=>void;demo:boolean;aiReady:boolean;fields:ComposeFields;onFields:Dispatch<SetStateAction<ComposeFields>>;blank:ComposeFields;contacts:Contact[];mailboxes:Mailbox[];preferredAccountId:string|null;onScheduled:()=>void}){
  const {to,cc,bcc,subject,body}=fields;
  const [busy,setBusy]=useState<''|'send'|'draft'|'write'|'schedule'>('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState(false);
  const [unconfirmed,setUnconfirmed]=useState<'send'|'draft'|null>(null);
  const [sent,setSent]=useState<Sent|null>(null);
  const [showCc,setShowCc]=useState(false);
  const [describing,setDescribing]=useState(false);
  const [notes,setNotes]=useState('');
  const [tone,setTone]=useState('Concise');
  const [countdown,setCountdown]=useState(0);
  const [files,setFiles]=useState<File[]>([]);
  const [scheduling,setScheduling]=useState(false);
  const [presets,setPresets]=useState<[string,Date][]>([]);
  const [when,setWhen]=useState('');
  const [earliest,setEarliest]=useState('');
  // One key per email being written. The server uses it so a retried click can never send twice.
  const key=useRef('');
  const timers=useRef<{tick:number;fire:number}|null>(null);
  const aiSubject=useRef('');
  // The mailbox the email leaves from: the one chosen here, else the one being viewed, else the default.
  const fromId=mailboxes.find(box=>box.id===fields.accountId)?.id||mailboxes.find(box=>box.id===preferredAccountId)?.id||mailboxes[0]?.id||'';
  const fromEmail=mailboxes.find(box=>box.id===fromId)?.email||'';
  // A saved signature is pre-filled into the body, so a body that is only the signature is still empty.
  const ready=!!to.trim()&&!!subject.trim()&&!!body.trim()&&body.trim()!==blank.body.trim()&&(demo||!!fromId);
  const locked=countdown>0;
  const set=(field:keyof ComposeFields)=>(value:string)=>onFields(previous=>({...previous,[field]:value}));
  const tidy=(list:string)=>list.replace(/[\s,;]+$/,'');
  function stopTimers(){if(timers.current){window.clearInterval(timers.current.tick);window.clearTimeout(timers.current.fire);timers.current=null;}setCountdown(0);}
  useEffect(()=>()=>{if(timers.current){window.clearInterval(timers.current.tick);window.clearTimeout(timers.current.fire);}},[]);
  function reset(){stopTimers();onFields(blank);setMessage('');setError(false);setUnconfirmed(null);setSent(null);setShowCc(false);setNotes('');setDescribing(false);setFiles([]);setScheduling(false);aiSubject.current='';key.current='';}
  function change(next:boolean){
    // Closing the window during the undo countdown cancels the send, so nothing leaves unexpectedly.
    if(!next&&locked){stopTimers();setMessage('Send cancelled. Your email was not sent.');setError(false);}
    if(!next&&sent)reset();
    onOpenChange(next);
  }
  function addFiles(list:FileList|null){
    if(!list)return;
    const next=[...files];
    for(const file of Array.from(list))if(!next.some(known=>known.name===file.name&&known.size===file.size&&known.lastModified===file.lastModified))next.push(file);
    const problem=attachmentProblem(next);
    if(problem){setMessage(problem);setError(true);return;}
    setFiles(next);setMessage('');setError(false);setScheduling(false);
  }
  async function submit(action:'send'|'draft',confirmUnsent=false){
    if(busy||!ready)return;
    setBusy(action);setMessage('');setError(false);setUnconfirmed(null);
    if(!key.current)key.current=crypto.randomUUID();
    try{
      if(demo){
        if(action==='send')setSent({to:tidy(to),cc:tidy(cc),from:''});
        else setMessage('Demo draft kept in this window. Nothing was saved to Gmail.');
      }else{
        const payload:Record<string,string>={action,accountId:fromId,to,cc,bcc,subject,body,key:key.current,...(confirmUnsent?{confirmUnsent:'true'}:{})};
        let request:unknown={...payload,confirmUnsent};
        if(files.length){const form=new FormData();for(const [name,value] of Object.entries(payload))form.append(name,value);for(const file of files)form.append('files',file);request=form;}
        const receipt=await api<Receipt>('/api/compose',request);
        if(action==='send')setSent({to:tidy(to),cc:tidy(cc),from:fromEmail,threadId:receipt.threadId});
        else setMessage(files.length?'Draft saved in Gmail with its attachments.':'Draft saved in Gmail.');
      }
    }catch(failure){
      setMessage(failure instanceof Error?failure.message:'Could not complete that. Please try again.');setError(true);
      // An uncertain earlier attempt may only be repeated once the person has checked Gmail.
      if(failure instanceof ApiError&&failure.status===409&&failure.message.includes('still unconfirmed'))setUnconfirmed(action);
    }
    finally{setBusy('');}
  }
  function startSend(){
    if(busy||locked||!ready)return;
    setMessage('');setError(false);setUnconfirmed(null);setScheduling(false);setCountdown(UNDO_SECONDS);
    const tick=window.setInterval(()=>setCountdown(left=>Math.max(1,left-1)),1000);
    const fire=window.setTimeout(()=>{stopTimers();void submit('send');},UNDO_SECONDS*1000);
    timers.current={tick,fire};
  }
  function undo(){stopTimers();setMessage('Send cancelled. Your email was not sent.');setError(false);}
  function openScheduling(){const options=schedulePresets();setPresets(options);setWhen(localValue(options[1][1]));setEarliest(localValue(new Date(Date.now()+5*60000)));setScheduling(true);setMessage('');setError(false);}
  async function scheduleIt(){
    if(busy||!ready)return;
    const sendAt=new Date(when).getTime();
    if(!Number.isFinite(sendAt)||sendAt<Date.now()+60000){setMessage('Choose a time in the future.');setError(true);return;}
    setBusy('schedule');setMessage('');setError(false);
    if(!key.current)key.current=crypto.randomUUID();
    try{
      if(!demo){await api('/api/compose',{action:'schedule',accountId:fromId,to,cc,bcc,subject,body,key:key.current,sendAt});onScheduled();}
      setScheduling(false);setSent({to:tidy(to),cc:tidy(cc),from:fromEmail,scheduledFor:sendAt});
    }catch(failure){setMessage(failure instanceof Error?failure.message:'Could not schedule that. Please try again.');setError(true);}
    finally{setBusy('');}
  }
  async function writeIt(){
    if(busy||!notes.trim())return;
    setBusy('write');setMessage('');setError(false);
    try{
      const draft=await api<{subject:string;body:string}>('/api/compose',{action:'assist',accountId:fromId,notes,tone});
      onFields(previous=>{
        const keepSubject=previous.subject.trim()&&previous.subject!==aiSubject.current;
        return {...previous,subject:keepSubject?previous.subject:draft.subject,body:draft.body};
      });
      aiSubject.current=draft.subject;
      setMessage('Draft written. Read it over and edit it before you send.');
    }catch(failure){setMessage(failure instanceof Error?failure.message:'Could not write a draft.');setError(true);}
    finally{setBusy('');}
  }
  const title=sent?(sent.scheduledFor?(demo?'Demo email scheduled':'Email scheduled'):demo?'Demo email sent':'Email sent'):'New email';
  const openInGmail=sent&&!demo&&!sent.scheduledFor?(sent.threadId?gmailThreadUrl(sent.from,sent.threadId):`https://mail.google.com/mail/u/?authuser=${encodeURIComponent(sent.from)}#sent`):'';
  return <Dialog open={open} onOpenChange={change}><DialogContent className="compose-dialog sm:max-w-xl">
    <DialogTitle>{title}</DialogTitle>
    <DialogDescription>{sent?`To ${sent.to}${sent.cc.trim()?` · Cc ${sent.cc}`:''}`:demo?'Demo mode: nothing you write here is sent to Gmail.':fromEmail?`Sent from ${fromEmail}. Nothing goes out until you click Send.`:'Nothing goes out until you click Send.'}</DialogDescription>
    {sent?<div className="compose-sent">
      <div className="compose-sent-title">{sent.scheduledFor?<CalendarClock size={18}/>:<CheckCircle2 size={18}/>}<strong>{sent.scheduledFor?`Scheduled for ${stamp(sent.scheduledFor)}`:demo?'Demo email complete':'Delivered through Gmail'}</strong></div>
      <div className="compose-sent-body"><span>{subject}</span><p>{body}</p>{files.length>0&&<small>{files.length} attached {files.length===1?'file':'files'}</small>}</div>
      <p className="compose-note">{sent.scheduledFor?(demo?'Demo mode · This email was never scheduled with Gmail.':'It goes out within about 30 minutes after that time. Review or cancel it under Scheduled.'):demo?'Demo mode · This email was never sent to Gmail.':'A copy is in your Gmail Sent folder.'}</p>
      <div className="compose-actions"><button className="button white" onClick={reset}><FilePenLine size={14}/>Write another email</button><button className="button blue" onClick={()=>change(false)}>Done</button></div>
      {openInGmail&&<a className="gmail-link" href={openInGmail} target="_blank" rel="noreferrer">Open in Gmail <ExternalLink size={12}/></a>}
    </div>:<div className="compose-form">
      <fieldset className="compose-fields" disabled={locked}>
        {!demo&&mailboxes.length>1&&<div className="compose-field"><label htmlFor="compose-from">From</label><select id="compose-from" value={fromId} onChange={event=>set('accountId')(event.target.value)}>{mailboxes.map(box=><option key={box.id} value={box.id}>{box.email}</option>)}</select></div>}
        <RecipientField label="To" value={to} onChange={set('to')} contacts={contacts} placeholder="name@example.com, another@example.com"/>
        {showCc||!!cc||!!bcc?<>
          <RecipientField label="Cc" value={cc} onChange={set('cc')} contacts={contacts}/>
          <RecipientField label="Bcc" value={bcc} onChange={set('bcc')} contacts={contacts}/>
        </>:<button type="button" className="compose-link" onClick={()=>setShowCc(true)}>Add Cc or Bcc</button>}
        <div className="compose-field"><label htmlFor="compose-subject">Subject</label><input id="compose-subject" type="text" maxLength={200} value={subject} onChange={event=>set('subject')(event.target.value)}/></div>
        {demo?<p className="compose-note">AI drafting is available once Gmail is connected.</p>
        :!aiReady?<p className="compose-note">AI drafting needs the AI service connected in the Site settings. You can still write your own email.</p>
        :<div className="compose-assist">
          <button type="button" className="compose-link" onClick={()=>setDescribing(value=>!value)} aria-expanded={describing}><Wand2 size={13}/>{describing?'Hide AI drafting':'Describe what you want to say, and let AI write it'}</button>
          {describing&&<div className="compose-assist-body">
            <textarea aria-label="Describe your email" placeholder="e.g. ask Sam if they are free for lunch on Friday and suggest the new place on Main Street" value={notes} maxLength={4000} onChange={event=>setNotes(event.target.value)}/>
            <div className="compose-assist-row"><select aria-label="Tone" value={tone} onChange={event=>setTone(event.target.value)}>{TONES.map(option=><option key={option}>{option}</option>)}</select><button type="button" className="button white" onClick={()=>void writeIt()} disabled={!notes.trim()||!!busy}><Wand2 size={14}/>{busy==='write'?'Writing…':'Write it'}</button></div>
          </div>}
        </div>}
        <div className="compose-field"><label htmlFor="compose-body">Message</label><textarea id="compose-body" maxLength={20000} placeholder="Write your message…" value={body} onChange={event=>set('body')(event.target.value)}/></div>
        <div className="compose-attach">
          {files.length<MAX_ATTACHMENTS&&<label className="compose-link"><Paperclip size={13}/>Attach files<input type="file" multiple hidden onChange={event=>{addFiles(event.target.files);event.target.value='';}}/></label>}
          {files.map(file=><span className="compose-chip" key={`${file.name}-${file.size}-${file.lastModified}`}><span className="compose-chip-name">{file.name}</span><small>{formatBytes(file.size)}</small><button type="button" aria-label={`Remove ${file.name}`} onClick={()=>setFiles(previous=>previous.filter(known=>known!==file))}><X size={12}/></button></span>)}
          {demo&&files.length>0&&<small className="compose-note">Demo mode: attachments are not uploaded.</small>}
        </div>
      </fieldset>
      {message&&<output className={`action-message${error?' error':''}`} aria-live="assertive">{message}{unconfirmed&&<button type="button" className="button white" disabled={!!busy} onClick={()=>void submit(unconfirmed,true)}>I checked Gmail, {unconfirmed==='send'?'send it':'save it'} again</button>}</output>}
      {locked?<div className="compose-undo"><output aria-live="polite">Sending in {countdown}s…</output><button className="button white" onClick={undo}><Undo2 size={14}/>Undo</button></div>
      :scheduling?<div className="compose-schedule">
        <strong>Send later</strong>
        <div className="compose-presets">{presets.map(([label,date])=><button type="button" key={label} className="compose-preset" aria-pressed={when===localValue(date)} onClick={()=>setWhen(localValue(date))}>{label}</button>)}</div>
        <input type="datetime-local" aria-label="Send time" value={when} min={earliest} onChange={event=>setWhen(event.target.value)}/>
        <small>Scheduled emails go out within about 30 minutes after the time you choose.</small>
        <div className="compose-actions"><button className="button white" onClick={()=>setScheduling(false)}>Back</button><button className="button blue" onClick={()=>void scheduleIt()} disabled={!when||!!busy}><CalendarClock size={14}/>{busy==='schedule'?'Scheduling…':'Schedule send'}</button></div>
      </div>
      :<div className="compose-actions">
        <button className="button white" onClick={()=>void submit('draft')} disabled={!ready||!!busy}><FilePenLine size={14}/>{busy==='draft'?'Saving…':'Save draft'}</button>
        <div className="compose-actions-right">
          <button className="button white" onClick={openScheduling} disabled={!ready||!!busy||files.length>0} title={files.length>0?'Emails with attachments cannot be scheduled yet':undefined}><CalendarClock size={14}/>Schedule</button>
          <button className="button blue" onClick={startSend} disabled={!ready||!!busy}><Send size={14}/>{busy==='send'?'Sending…':'Send email'}</button>
        </div>
      </div>}
    </div>}
  </DialogContent></Dialog>;
}
