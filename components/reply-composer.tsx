'use client';
import { useState } from 'react';
import { Sparkles, Send, FilePenLine, RefreshCw, ExternalLink } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/hooks/use-inbox';
import type { Email } from '@/lib/mail';
export function ReplyComposer({email,demo,aiReady,onSent}:{email:Email;demo:boolean;aiReady:boolean;onSent:()=>void}){
  const [tone,setTone]=useState('Concise');
  const [text,setText]=useState('');
  const [busy,setBusy]=useState('');
  const [message,setMessage]=useState('');
  const [variation,setVariation]=useState(0);
  async function generate(){
    setBusy('generate');setMessage('');
    const attempt=text?variation+1:0;
    try{
      const result=demo
        ?await api<{reply:string}>('/api/suggest',{id:email.id,tone,variation:attempt})
        :await api<{reply:string}>('/api/reply',{id:email.id,action:'generate',tone,variation:attempt});
      setText(result.reply);setVariation(attempt);
      if(demo)setMessage('Written for the sample inbox. You can edit it before trying the reply flow.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not generate a reply.');}
    finally{setBusy('');}
  }
  async function complete(action:'send'|'draft'){
    setBusy(action);setMessage('');
    try{
      if(demo){setMessage(action==='send'?'Demo reply complete. No email was sent.':'Demo draft saved for this conversation.');if(action==='send')onSent();}
      else{await api('/api/reply',{id:email.id,action,body:text});setMessage(action==='send'?'Reply sent through Gmail.':'Draft saved in Gmail.');if(action==='send')onSent();}
    }catch(error){setMessage(error instanceof Error?error.message:'Could not complete your reply.');}
    finally{setBusy('');}
  }
  return <div className="reply-area"><span className="reply-label"><Sparkles size={16}/>{demo?'Try a suggested reply':'Reply with a little help'}</span><div className="reply-controls"><Tabs value={tone} onValueChange={v=>setTone(String(v))}><TabsList>{['Concise','Friendly','Professional'].map(t=><TabsTrigger key={t} value={t}>{t}</TabsTrigger>)}</TabsList></Tabs><button className="generate-button" disabled={!!busy||!aiReady} onClick={generate}>{busy==='generate'?<RefreshCw className="spinning" size={14}/>:<Sparkles size={14}/>} {text?'Regenerate':'Generate reply'}</button></div>{!aiReady&&<p>Suggested replies need the AI service connected in the Site settings. You can still write your own reply.</p>}<textarea aria-label="Reply message" placeholder="Generate a suggestion, or write a reply in your own words…" value={text} onChange={e=>setText(e.target.value)} maxLength={20000}/><div className="reply-footer"><button className="button white" onClick={()=>complete('draft')} disabled={!text.trim()||!!busy}><FilePenLine size={14}/>{busy==='draft'?'Saving…':'Save draft'}</button><button className="button blue" onClick={()=>complete('send')} disabled={!text.trim()||!!busy}><Send size={14}/>{busy==='send'?'Sending…':demo?'Try reply':'Send reply'}</button></div><p className="reply-disclaimer">{demo?'Demo mode · Replies are AI-generated drafts for the sample inbox. Nothing is sent to Gmail.':'Generated replies are drafts. Review the wording before sending.'}</p>{message&&<output className="action-message" aria-live="polite">{message}</output>}{!demo&&<a className="gmail-link" href={'https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(email.threadId||email.id)} target="_blank" rel="noreferrer">Open conversation in Gmail <ExternalLink size={12}/></a>}</div>;
}
