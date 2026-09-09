'use client';
import { useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Layers3, MailMinus, Sparkles } from 'lucide-react';
import { api } from '@/hooks/use-inbox';
import type { Email } from '@/lib/mail';
export function NoiseList({emails,demo,onRemoved,onSelect}:{emails:Email[];demo:boolean;onRemoved:(address:string)=>void;onSelect:(email:Email)=>void}){
  const [expanded,setExpanded]=useState<string|null>(null);const [busy,setBusy]=useState('');const [message,setMessage]=useState('');
  const groups=Array.from(emails.reduce((map,m)=>{map.set(m.address,[...(map.get(m.address)||[]),m]);return map;},new Map<string,Email[]>()));
  async function unsubscribe(email:Email){
    setBusy(email.address);setMessage('');
    try{
      if(demo){onRemoved(email.address);setMessage(`Demo: ${email.sender} is unsubscribed. Your real subscriptions are unchanged.`);}
      else{const result=await api<{manual?:boolean;url?:string}>('/api/unsubscribe',{id:email.id});if(result.manual){setMessage('This sender requires you to finish unsubscribing in Gmail.');}else{onRemoved(email.address);setMessage(`Unsubscribed from ${email.sender}. It may take a few days for their mail to stop.`);}}
    }catch(error){setMessage(error instanceof Error?error.message:'Could not unsubscribe.');}finally{setBusy('');}
  }
  return <section className="noise-view"><div className="noise-view-heading"><span className="section-icon"><Layers3 size={22}/></span><div><h2>Your quiet corner</h2><p>{emails.length} emails from {groups.length} senders. Keep what you love. Let the rest go.</p></div></div><div className="noise-tip"><Sparkles size={16}/><span>Newsletters and promotions are grouped by sender. Unsubscribing leaves existing emails in Gmail.</span></div>{groups.length===0?<div className="empty-state"><Check size={30}/><h3>Nothing to clear.</h3><p>Your quiet corner is all caught up.</p></div>:<div className="sender-groups">{groups.map(([address,items])=>{const first=items[0];return <article className="sender-group" key={address}><div className="sender-group-row"><button className={`avatar ${first.color}`} onClick={()=>setExpanded(expanded===address?null:address)} aria-label={`Show emails from ${first.sender}`}>{first.initials}</button><button className="group-name" onClick={()=>setExpanded(expanded===address?null:address)} aria-expanded={expanded===address}><strong>{first.sender}</strong><span>{items.length} {items.length===1?'email':'emails'} · {first.subject}</span></button><button className="expand-group" aria-label={`Expand ${first.sender}`} aria-expanded={expanded===address} onClick={()=>setExpanded(expanded===address?null:address)}><ChevronDown size={15}/></button>{!demo&&!first.oneClick?<a className="unsubscribe-button" target="_blank" rel="noreferrer" href={'https://mail.google.com/mail/u/0/#all/'+encodeURIComponent(first.threadId||first.id)}>Review in Gmail <ArrowUpRight size={13}/></a>:<button className="unsubscribe-button" disabled={!!busy} onClick={()=>unsubscribe(first)}><MailMinus size={14}/>{busy===address?'Unsubscribing…':'Unsubscribe'}</button>}</div>{expanded===address&&<div className="group-emails">{items.map(m=><button key={m.id} onClick={()=>onSelect(m)}><span>{m.subject}</span><ArrowUpRight size={14}/></button>)}</div>}</article>;})}</div>}{message&&<output className="action-message" aria-live="polite">{message}</output>}<p className="noise-footnote"><ShieldIcon/> One-click unsubscribe is available for senders with a supported unsubscribe endpoint.</p></section>;
}
function ShieldIcon(){return <Check size={13}/>;}
