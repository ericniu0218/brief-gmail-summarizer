'use client';
import { useMemo, useState } from 'react';
import { Check, ChevronDown, Layers3, MessageSquareText, Sparkles } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { buildInboxRows, isImportantEmail } from '@/lib/inbox-priority';
import { rowLabels } from '@/lib/categories';

/** At most two compact labels per row; the conversation panel carries the full set. */
function rowChips(email:Email,important:boolean){
  const tags=rowLabels(email).map(text=>({text,important:false,review:false}));
  const chips=important?[{text:'Important',important:true,review:false},...tags]:tags.length?tags:[{text:email.label||'Mail',important:false,review:false}];
  // Awaiting review is a status, not urgency, so it never claims the Important slot.
  const review=email.classification?.processingStatus==='needs_review';
  return (review?[{text:'Needs review',important:false,review:true},...chips]:chips).slice(0,2);
}

function EmailRow({email,onSelect}:{email:Email;onSelect:(email:Email)=>void}){
  const important=isImportantEmail(email);
  return <article className="email-row"><button className={`avatar ${email.color}`} aria-label={`Read ${email.sender}’s email`} onClick={()=>onSelect(email)}>{email.initials}</button><button className="email-text" onClick={()=>onSelect(email)}><div className="sender-line"><strong>{email.sender}</strong>{email.unread?<span className="unread-dot"/>:null}{rowChips(email,important).map(chip=><span key={chip.text} className={`mail-label${chip.important?' important':''}${chip.review?' review':''}`}>{chip.text}</span>)}</div><h3>{email.subject}</h3><p>{email.summary}</p></button><div className="email-actions"><time>{email.time}</time>{email.needsReply?<button className="quick-reply" onClick={()=>onSelect(email)}><Sparkles size={13}/>Quick reply</button>:<span className="no-action">No reply needed</span>}</div></article>;
}

function FoldedEmailGroup({company,emails,needsReplyCount,onSelect}:{company:string;emails:Email[];needsReplyCount:number;onSelect:(email:Email)=>void}){
  const [expanded,setExpanded]=useState(false);
  const toggle=()=>setExpanded(value=>!value);
  return <article className={`email-fold${expanded?' expanded':''}`}><div className="email-fold-row"><button className={`avatar ${emails[0].color}`} onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`}><Layers3 size={16}/></button><button className="email-fold-summary" onClick={toggle} aria-expanded={expanded}><div className="sender-line"><strong>{company}</strong><span className="folded-label">Folded</span><span className="mail-label important">Important</span></div><h3>{emails.length} related account messages</h3><p>{needsReplyCount?`${needsReplyCount} ${needsReplyCount===1?'needs':'need'} a reply · `:''}Open to review each important email</p></button><button className="fold-expand" onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`} aria-expanded={expanded}><span>{emails.length}</span><ChevronDown size={16}/></button></div>{expanded?<div className="folded-emails">{emails.map(email=><article className="folded-email" key={email.id}><button className="folded-email-copy" onClick={()=>onSelect(email)}><span className="folded-email-heading"><strong>{email.subject}</strong><span className="mail-label important">Important</span>{email.needsReply?<span className="reply-needed-label">Reply needed</span>:null}</span><span className="folded-email-summary">{email.summary}</span></button><button className="folded-reply" onClick={()=>onSelect(email)}><MessageSquareText size={14}/>Reply</button></article>)}</div>:null}</article>;
}

export function PriorityEmailList({emails,busy,emptyTitle,emptyBody,onSelect}:{emails:Email[];busy:boolean;emptyTitle:string;emptyBody:string;onSelect:(email:Email)=>void}){
  const rows=useMemo(()=>buildInboxRows(emails),[emails]);
  return <div className="email-list">{rows.length===0?<div className="empty-state"><Check size={28}/><h3>{busy?'Preparing your inbox…':emptyTitle}</h3><p>{busy?'Your first briefing is on its way.':emptyBody}</p></div>:rows.map(row=>row.kind==='email'?<EmailRow key={row.email.id} email={row.email} onSelect={onSelect}/>:<FoldedEmailGroup key={row.id} company={row.company} emails={row.emails} needsReplyCount={row.needsReplyCount} onSelect={onSelect}/>)}</div>;
}
