'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Layers3, MessageSquareText, Sparkles, Undo2 } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { buildInboxRows, isImportantEmail, type InboxFoldRow, type SortMode } from '@/lib/inbox-priority';
import { foldSenderKey, type FoldPreference, type FoldPreferences } from '@/lib/folding';
import { rowLabels } from '@/lib/categories';
import { receivedLabel } from '@/lib/email-time';

/** At most two compact labels per row; the conversation panel carries the full set. */
function rowChips(email:Email,important:boolean){
  const tags=rowLabels(email).map(text=>({text,important:false,review:false}));
  const chips=important?[{text:'Important',important:true,review:false},...tags]:tags.length?tags:[{text:(email.label==='Important'?'Mail':email.label)||'Mail',important:false,review:false}];
  // Awaiting review is a status, not urgency, so it never claims the Important slot.
  const review=email.classification?.processingStatus==='needs_review';
  return (review?[{text:'Needs review',important:false,review:true},...chips]:chips).slice(0,2);
}

/** What the row says when no reply is pending. An unsettled decision is never shown as "none". */
function replyNote(email:Email){
  if(email.replied)return 'Replied';
  return email.classification?.reply?.status==='uncertain'?'Reply unclear':'No reply needed';
}

/** Persist Done before any visual transition or unmount can interrupt it. */
function useLeave(finish:()=>void){
  const [leaving,setLeaving]=useState(false);
  const clicked=useRef(false);
  const leave=()=>{
    if(clicked.current)return;
    clicked.current=true;
    finish();
    setLeaving(true);
  };
  return [leaving,leave] as const;
}

/** The round Done control at the end of a row; its check fills in as the row leaves. */
function DoneButton({label,onDone}:{label:string;onDone:()=>void}){
  return <button type="button" className="done-button" aria-label={`Mark ${label} as done`} title="Done" onClick={onDone}><span className="done-ring"><Check size={13} strokeWidth={2.75}/></span></button>;
}

/** Marks messages done; `text` names them in the confirmation. */
type DoneHandler=(emails:Email[],text:string)=>void;

function EmailRow({email,now,showAccount,onSelect,onDone}:{email:Email;now:number|null;showAccount?:boolean;onSelect:(email:Email)=>void;onDone?:DoneHandler}){
  const important=isImportantEmail(email,now);
  const [leaving,leave]=useLeave(()=>onDone?.([email],email.subject||'this email'));
  return <article className={`email-row${leaving?' leaving':''}`}><button className={`avatar ${email.color}`} aria-label={`Read ${email.sender}’s email`} onClick={()=>onSelect(email)}>{email.initials}</button><button className="email-text" onClick={()=>onSelect(email)}><div className="sender-line"><strong>{email.sender}</strong>{email.unread?<span className="unread-dot"/>:null}{rowChips(email,important).map(chip=><span key={chip.text} className={`mail-label${chip.important?' important':''}${chip.review?' review':''}`}>{chip.text}</span>)}</div><h3>{email.subject}</h3><p>{email.summary}</p>{showAccount&&email.accountEmail?<small className="email-account">{email.accountEmail}</small>:null}</button><div className="email-actions"><time>{receivedLabel(email,now)}</time>{email.needsReply?<button className="quick-reply" onClick={()=>onSelect(email)}><Sparkles size={13}/>Quick reply</button>:<span className="no-action">{replyNote(email)}</span>}</div>{onDone&&<DoneButton label={email.subject||'this email'} onDone={leave}/>}</article>;
}

/** What the reader can do with a folded group: split it apart, or stop grouping a sender. */
type FoldActions={onKeepSeparate?:(emails:Email[])=>void;onSenderPreference?:(email:Email,value:FoldPreference|undefined)=>void};

function FoldedEmailGroup({row,now,showAccount,onSelect,onKeepSeparate,onSenderPreference,onDone}:{row:InboxFoldRow;now:number|null;showAccount?:boolean;onSelect:(email:Email)=>void;onDone?:DoneHandler}&FoldActions){
  const {company,emails,lead,needsReplyCount}=row;
  const [expanded,setExpanded]=useState(false);
  const toggle=()=>setExpanded(value=>!value);
  // Done on a group covers every message in it.
  const [leaving,leave]=useLeave(()=>onDone?.(emails,`${emails.length} ${company} emails`));
  return <article className={`email-fold${expanded?' expanded':''}${leaving?' leaving':''}`}><div className="email-fold-row"><button className={`avatar ${emails[0].color}`} onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`}><Layers3 size={16}/></button><button className="email-fold-summary" onClick={toggle} aria-expanded={expanded}><div className="sender-line"><strong>{company}</strong><span className="folded-label">{row.label}</span>{isImportantEmail(lead,now)?<span className="mail-label important">Important</span>:null}</div><h3>{lead.subject}</h3><p>{needsReplyCount?`${needsReplyCount} ${needsReplyCount===1?'needs':'need'} a reply · `:''}{emails.length} {row.reason==='conversation'?'messages in this conversation':'related messages'}</p></button><button className="fold-expand" onClick={toggle} aria-label={`${expanded?'Collapse':'Expand'} ${company} emails`} aria-expanded={expanded}><span>{emails.length}</span><ChevronDown size={16}/></button>{onDone&&<DoneButton label={`all ${emails.length} ${company} emails`} onDone={leave}/>}</div>{expanded?<div className="folded-emails">{emails.map(email=><article className="folded-email" key={emailKey(email)}><button className="folded-email-copy" onClick={()=>onSelect(email)}><span className="folded-email-heading"><strong>{email.subject}</strong>{isImportantEmail(email,now)?<span className="mail-label important">Important</span>:null}{email.needsReply?<span className="reply-needed-label">Reply needed</span>:null}</span><span className="folded-email-summary">{email.summary}</span>{showAccount&&email.accountEmail?<small className="email-account">{email.accountEmail}</small>:null}</button><button className="folded-reply" onClick={()=>onSelect(email)}><MessageSquareText size={14}/>Reply</button></article>)}
    {(onKeepSeparate||onSenderPreference)&&<div className="fold-preferences">
      {row.reason==='sender'&&emails.every(email=>foldSenderKey(email)===foldSenderKey(lead))&&onSenderPreference
        ?<button type="button" className="text-button" onClick={()=>onSenderPreference(lead,undefined)}>Stop always grouping this sender</button>
        :onKeepSeparate&&<button type="button" className="text-button" onClick={()=>onKeepSeparate(emails)}>Keep these messages separate</button>}
    </div>}</div>:null}</article>;
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
 *
 * With `onDone`, each row and group carries a Done control: the row slides out, the caller
 * moves it to `doneEmails`, and an Undo bar names what moved. Done mail is listed in a
 * collapsed section below, each with Move back (see hooks/use-done-mail).
 */
export function PriorityEmailList({emails,doneEmails=[],now,sortMode='importance',conversationsOnly=false,busy,emptyTitle,emptyBody,showAccount,onSelect,onDone,onMoveBack,foldPreferences,onKeepSeparate,onSenderPreference}:{emails:Email[];doneEmails?:Email[];now:number|null;sortMode?:SortMode;conversationsOnly?:boolean;busy:boolean;emptyTitle:string;emptyBody:string;showAccount?:boolean;onSelect:(email:Email)=>void;onDone?:(emails:Email[])=>void;onMoveBack?:(emails:Email[])=>void;foldPreferences?:FoldPreferences}&FoldActions){
  const rows=useMemo(()=>buildInboxRows(emails,now,sortMode,foldPreferences,{conversationsOnly}),[emails,now,sortMode,foldPreferences,conversationsOnly]);
  const [limit,setLimit]=useState(PAGE_SIZE);
  const [showDone,setShowDone]=useState(false);
  const [doneLimit,setDoneLimit]=useState(PAGE_SIZE);
  const [toast,setToast]=useState<{emails:Email[];text:string}|null>(null);
  const toastTimer=useRef<number|undefined>(undefined);
  useEffect(()=>()=>window.clearTimeout(toastTimer.current),[]);
  const visible=rows.slice(0,limit);
  const remaining=rows.length-visible.length;
  const markDone:DoneHandler|undefined=onDone&&((marked,text)=>{
    onDone(marked);
    setToast({emails:marked,text});
    window.clearTimeout(toastTimer.current);
    toastTimer.current=window.setTimeout(()=>setToast(null),6000);
  });
  const undo=()=>{if(toast)onMoveBack?.(toast.emails);setToast(null);window.clearTimeout(toastTimer.current);};
  const caughtUp=rows.length===0&&doneEmails.length>0;
  return <>
  <div className="email-list">{rows.length===0?<div className={`empty-state${caughtUp?' caught-up':''}`}><Check size={28}/><h3>{busy?'Preparing your inbox…':caughtUp?'All caught up.':emptyTitle}</h3><p>{busy?'Your first briefing is on its way.':caughtUp?'Everything here is marked done. New mail will appear on top.':emptyBody}</p></div>:<>
    {visible.map(row=>row.kind==='email'?<EmailRow key={emailKey(row.email)} email={row.email} now={now} showAccount={showAccount} onSelect={onSelect} onDone={markDone}/>:<FoldedEmailGroup key={row.id} row={row} now={now} showAccount={showAccount} onSelect={onSelect} onKeepSeparate={onKeepSeparate} onSenderPreference={onSenderPreference} onDone={markDone}/>)}
    {remaining>0&&<div className="email-list-more">
      <button type="button" onClick={()=>setLimit(count=>count+PAGE_SIZE)}>
        <span>Show additional conversations</span>
        <span className="email-list-remaining">{remaining} not shown</span>
      </button>
    </div>}
  </>}</div>
  {doneEmails.length>0&&<section className={`done-section${showDone?' open':''}`} aria-label="Done">
    <button type="button" className="done-toggle" aria-expanded={showDone} onClick={()=>setShowDone(value=>!value)}>
      <ChevronRight size={16} className="done-chevron"/><span className="done-title">Done</span><span className="done-count">{doneEmails.length}</span>
      <span className="done-hint">{showDone?'Hide':'Show'}</span>
    </button>
    {showDone&&<div className="done-list">
      {doneEmails.slice(0,doneLimit).map(email=><article className="done-row" key={emailKey(email)}>
        <span className="done-badge" aria-hidden="true"><Check size={12} strokeWidth={3}/></span>
        <button type="button" className="done-copy" onClick={()=>onSelect(email)}><strong>{email.sender}</strong><span>{email.subject}</span></button>
        <time>{receivedLabel(email,now)}</time>
        {onMoveBack&&<button type="button" className="move-back" onClick={()=>onMoveBack([email])}><Undo2 size={14}/>Move back</button>}
      </article>)}
      {doneEmails.length>doneLimit&&<button type="button" className="done-more" onClick={()=>setDoneLimit(count=>count+PAGE_SIZE)}>Show {Math.min(PAGE_SIZE,doneEmails.length-doneLimit)} more</button>}
    </div>}
  </section>}
  {toast&&<output className="done-toast">
    <span className="done-toast-icon" aria-hidden="true"><Check size={13} strokeWidth={3}/></span>
    <span className="done-toast-text">Moved <strong>{toast.text}</strong> to Done</span>
    <button type="button" onClick={undo}><Undo2 size={14}/>Undo</button>
  </output>}
  </>;
}
