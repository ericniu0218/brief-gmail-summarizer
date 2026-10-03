'use client';
import { useState } from 'react';
import { ArrowUpRight, FilePenLine, Paperclip, RefreshCw, Reply, Trash2 } from 'lucide-react';
import type { DraftItem } from '@/server/drafts';
import type { DraftsState } from '@/hooks/use-drafts';

/** Opens a draft in Gmail itself, where reply threading and attachments are kept. */
export function gmailDraftUrl(draft:Pick<DraftItem,'accountEmail'|'messageId'>){
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(draft.accountEmail)}#drafts?compose=${encodeURIComponent(draft.messageId)}`;
}

/** Drafts written here can be finished here; replies and drafts with files open in Gmail. */
export function editableHere(draft:DraftItem){return !draft.reply&&draft.attachments===0&&draft.contentComplete!==false;}

const firstLine=(body:string)=>body.split('\n').map(line=>line.trim()).find(line=>line&&line!=='--')||'';
const when=(at:number,now:number|null)=>now===null||!at?'':new Date(at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

function DraftRow({draft,now,showAccount,onEdit,onDelete}:{draft:DraftItem;now:number|null;showAccount:boolean;onEdit:(draft:DraftItem)=>void;onDelete:(draft:DraftItem)=>Promise<void>}){
  const [confirming,setConfirming]=useState(false);
  const [deleting,setDeleting]=useState(false);
  const [problem,setProblem]=useState('');
  const recipients=[...draft.to,...draft.cc].join(', ');
  const here=editableHere(draft);
  const remove=async()=>{
    setDeleting(true);setProblem('');
    try{await onDelete(draft);}
    catch(failure){setProblem(failure instanceof Error?failure.message:'The draft could not be deleted. Try again.');setDeleting(false);setConfirming(false);}
  };
  return <article className={`draft-row${deleting?' deleting':''}`}>
    <span className="draft-icon" aria-hidden="true">{draft.reply?<Reply size={15}/>:<FilePenLine size={15}/>}</span>
    <button type="button" className="draft-copy" onClick={()=>here?onEdit(draft):window.open(gmailDraftUrl(draft),'_blank','noopener,noreferrer')}>
      <span className="draft-line">
        <span className="draft-draft-label">Draft</span>
        <strong className="draft-to">{recipients?`To ${recipients}`:'No recipients yet'}</strong>
      </span>
      <span className="draft-subject">{draft.subject||'(no subject)'}</span>
      <span className="draft-preview">{firstLine(draft.body)||'Nothing written yet'}</span>
      <span className="draft-meta">
        {draft.reply&&<span className="draft-chip">Reply</span>}
        {draft.attachments>0&&<span className="draft-chip"><Paperclip size={11}/>{draft.attachments} {draft.attachments===1?'file':'files'}</span>}
        {showAccount&&<span>{draft.accountEmail}</span>}
      </span>
    </button>
    <div className="draft-side">
      <time>{when(draft.updatedAt,now)}</time>
      {confirming
        ?<span className="draft-confirm">
          <button type="button" className="draft-delete-confirm" onClick={remove} disabled={deleting}>{deleting?'Deleting…':'Delete'}</button>
          <button type="button" className="draft-cancel" onClick={()=>setConfirming(false)} disabled={deleting}>Keep</button>
        </span>
        :<span className="draft-actions">
          {here
            ?<button type="button" className="draft-edit" onClick={()=>onEdit(draft)}><FilePenLine size={13}/>Edit</button>
            :<a className="draft-edit" href={gmailDraftUrl(draft)} target="_blank" rel="noopener noreferrer"><ArrowUpRight size={13}/>Open in Gmail</a>}
          <button type="button" className="draft-trash" aria-label={`Delete draft ${draft.subject||'with no subject'}`} title="Delete draft" onClick={()=>setConfirming(true)}><Trash2 size={14}/></button>
        </span>}
      {problem&&<span className="draft-problem" role="alert">{problem}</span>}
    </div>
  </article>;
}

/**
 * The Gmail Drafts folder inside Brief. Drafts started here open back in Compose; a reply
 * or a draft carrying files opens in Gmail, which keeps its thread and attachments.
 */
export function DraftsView({drafts,now,connected,showAccount,onEdit,onCompose}:{drafts:DraftsState&{reload:()=>Promise<void>;remove:(draft:DraftItem)=>Promise<void>};now:number|null;connected:boolean;showAccount:boolean;onEdit:(draft:DraftItem)=>void;onCompose:()=>void}){
  return <section className="inbox-section standalone-inbox drafts-view" aria-label="Drafts">
    <div className="section-title-row drafts-heading">
      <h2>Drafts <span>{drafts.items.length}</span></h2>
      {connected&&<button type="button" className="drafts-refresh" onClick={()=>{void drafts.reload();}} disabled={drafts.loading} aria-label="Reload drafts from Gmail"><RefreshCw size={14} className={drafts.loading?'spinning':''}/>{drafts.loading?'Loading':'Reload'}</button>}
    </div>
    <p className="drafts-note">Saved in your Gmail Drafts folder, so they stay in sync with Gmail on every device. Showing the newest 50 drafts per mailbox.</p>
    {drafts.error&&<p className="drafts-problem" role="alert">{drafts.error}</p>}
    {drafts.failures.map(failure=><p key={failure.accountId} className="drafts-problem" role="alert">Could not load drafts for {failure.email}: {failure.error}</p>)}
    <div className="email-list drafts-list">
      {!connected
        ?<div className="empty-state"><FilePenLine size={28}/><h3>Connect Gmail to see your drafts.</h3><p>Drafts you save from Compose go to your Gmail Drafts folder and show up here.</p></div>
        :!drafts.loaded&&drafts.loading
          ?<div className="empty-state"><FilePenLine size={28}/><h3>Loading your drafts…</h3><p>Reading your Gmail Drafts folder.</p></div>
          :drafts.items.length===0
            ?<div className="empty-state"><FilePenLine size={28}/><h3>No drafts.</h3><p>Use Save draft in Compose and it will appear here.</p><button type="button" className="button white" onClick={onCompose}>Write an email</button></div>
            :drafts.items.map(draft=><DraftRow key={`${draft.accountId}:${draft.id}`} draft={draft} now={now} showAccount={showAccount} onEdit={onEdit} onDelete={drafts.remove}/>)}
    </div>
  </section>;
}
