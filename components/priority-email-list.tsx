'use client';
import { useMemo, useState } from 'react';
import { Check, ChevronDown, Layers3, MessageSquareText, Sparkles } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { buildInboxRows, isImportantEmail, type SortMode } from '@/lib/inbox-priority';
import { rowLabels } from '@/lib/categories';

/** At most two compact labels per row; the conversation panel carries the full set. */
function rowChips(email:Email,important:boolean){
  const tags=rowLabels(email).map(text=>({text,important:false,review:false}));
  const chips=important?[{text:'Important',important:true,review:false},...tags]:tags.length?tags:[{text:email.label||'Mail',important:false,review:false}];
  // Awaiting review is a status, not urgency, so it never claims the Important slot.
  const review=email.classification?.processingStatus==='needs_review';
  return (review?[{text:'Needs review',important:false,review:true},...chips]:chips).slice(0,2);
}

function EmailRow({email,now,showAccount,onSelect}:{email:Email;now:number|null;showAccount?:boolean;onSelect:(email:Email)=>void}){
  const important=isImportantEmail(email,now);
  return <article className="email-row"><button className={`avatar ${email.color}`} aria-label={`Read ${email.sender}’s email`} onClick={()=>onSelect(email)}>{email.initials}</button><button className="email-text" onClick={()=>onSelect(email)}><div className="sender-line"><strong>{email.sender}</strong>{email.unread?<span className="unread-dot"/>:null}{rowChips(email,important).map(chip=><span key={chip.text} className={`mail-label${chip.important?' important':''}${chip.review?' review':''}`}>{chip.text}</span>)}</div><h3>{email.subject}</h3><p>{email.summary}</p>{showAccount&&email.accountEmail?<small className="email-account">{email.accountEmail}</small>:null}</button><div className="email-actions"><time>{email.time}</time>{email.needsReply?<button className="quick-reply" onClick={()=>onSelect(email)}><Sparkles size={13}/>Quick reply</button>:<span className="no-action">No reply needed</span>}</div></article>;
}

function FoldedEmailGroup({company,emails,lead,needsReplyCount,now,showAccount,onSelect}:{company:string;emails:Email[];lead:Email;needsReplyCount:number;now:number|null;showAccount?:boolean;onSelect:(email:Email)=>void}){
  const [expanded,setExpanded]=useState(false);
  const toggle=()=>setExpanded(value=>!value);
  return <article className={`email-fold${expanded?' expanded':''}`}><div className="email-fold-row"><button className={`avatar ${emails[0].color}`} onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`}><Layers3 size={16}/></button><button className="email-fold-summary" onClick={toggle} aria-expanded={expanded}><div className="sender-line"><strong>{company}</strong><span className="folded-label">Folded</span>{isImportantEmail(lead,now)?<span className="mail-label important">Important</span>:null}</div><h3>{lead.subject}</h3><p>{needsReplyCount?`${needsReplyCount} ${needsReplyCount===1?'needs':'need'} a reply · `:''}{emails.length} related messages</p></button><button className="fold-expand" onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`} aria-expanded={expanded}><span>{emails.length}</span><ChevronDown size={16}/></button></div>{expanded?<div className="folded-emails">{emails.map(email=><article className="folded-email" key={emailKey(email)}><button className="folded-email-copy" onClick={()=>onSelect(email)}><span className="folded-email-heading"><strong>{email.subject}</strong>{isImportantEmail(email,now)?<span className="mail-label important">Important</span>:null}{email.needsReply?<span className="reply-needed-label">Reply needed</span>:null}</span><span className="folded-email-summary">{email.summary}</span>{showAccount&&email.accountEmail?<small className="email-account">{email.accountEmail}</small>:null}</button><button className="folded-reply" onClick={()=>onSelect(email)}><MessageSquareText size={14}/>Reply</button></article>)}</div>:null}</article>;
}

/** Rows shown before the list is cut off, and how many each request adds. */
const PAGE_SIZE=25;

/**
 * `showAccount` labels each row with the mailbox that received it. It is set for the
 * combined view, where the same sender may appear under more than one account.
 *
 * Rows are keyed by the composite identity rather than the Gmail message id: two accounts
 * can hold the same id, and a duplicate React key would make one message replace the other.
 *
 * Long mailboxes are cut off rather than rendered whole, so opening a view never has to
 * lay out hundreds of rows before anything is readable. The cut is counted in rows, so a
 * folded group counts once rather than once per message inside it. Everything here is
 * already loaded: the control reveals more of it and never asks Gmail for anything, which
 * is why it reports a precise remainder instead of an open-ended "load more".
 *
 * Callers that change which messages are listed should pass a `key` that changes with
 * them, so a new view starts at the top instead of inheriting the previous view's extent.
 */
export function PriorityEmailList({emails,now,sortMode='importance',busy,emptyTitle,emptyBody,showAccount,onSelect}:{emails:Email[];now:number|null;sortMode?:SortMode;busy:boolean;emptyTitle:string;emptyBody:string;showAccount?:boolean;onSelect:(email:Email)=>void}){
  const rows=useMemo(()=>buildInboxRows(emails,now,sortMode),[emails,now,sortMode]);
  const [limit,setLimit]=useState(PAGE_SIZE);
  const visible=rows.slice(0,limit);
  const remaining=rows.length-visible.length;
  return <div className="email-list">{rows.length===0?<div className="empty-state"><Check size={28}/><h3>{busy?'Preparing your inbox…':emptyTitle}</h3><p>{busy?'Your first briefing is on its way.':emptyBody}</p></div>:<>
    {visible.map(row=>row.kind==='email'?<EmailRow key={emailKey(row.email)} email={row.email} now={now} showAccount={showAccount} onSelect={onSelect}/>:<FoldedEmailGroup key={row.id} company={row.company} emails={row.emails} lead={row.lead} needsReplyCount={row.needsReplyCount} now={now} showAccount={showAccount} onSelect={onSelect}/>)}
    {remaining>0&&<div className="email-list-more">
      <button type="button" onClick={()=>setLimit(count=>count+PAGE_SIZE)}>
        <span>Show additional conversations</span>
        <span className="email-list-remaining">{remaining} not shown</span>
      </button>
    </div>}
  </>}</div>;
}
