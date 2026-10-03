'use client';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowUpRight, MessageSquareText, Info, ShieldCheck } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { isImportantEmail, sortInboxEmails } from '@/lib/inbox-priority';

/**
 * Read-only summary: every pending reply first (soonest first, Important or not), then the
 * rest of the important mail. The reply count uses the same membership as the inbox tab.
 */
export function InboxDigest({open,onOpenChange,emails,now,ai,connected,onSelect}:{open:boolean;onOpenChange:(open:boolean)=>void;emails:Email[];now:number|null;ai:boolean;connected:boolean;onSelect:(email:Email)=>void}){
  // One instant, supplied by the caller, so the digest cannot list a message as important
  // and then rank it as routine — and so rendering stays pure.
  const important=sortInboxEmails(emails.filter(email=>isImportantEmail(email,now)),now);
  const needsReply=sortInboxEmails(emails.filter(m=>m.category!=='noise'&&m.needsReply),now,'reply');
  const informational=important.filter(m=>!m.needsReply);
  function open_(email:Email){onSelect(email);onOpenChange(false);}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="digest-dialog">
    <DialogTitle>Your important mail, summarized</DialogTitle>
    <DialogDescription>{needsReply.length} {needsReply.length===1?'email needs':'emails need'} a reply and {needsReply.length===1?'appears':'appear'} first; {informational.length} other important {informational.length===1?'email':'emails'} follow.</DialogDescription>
    {connected&&!ai&&<p className="digest-note"><Info size={13}/> AI analysis is unavailable. Reply detection is limited; importance still uses Gmail&apos;s Important label plus security and account-access signals.</p>}
    {important.length===0&&needsReply.length===0&&<div className="empty-state"><ShieldCheck size={26}/><h3>Nothing important right now.</h3><p>Routine mail stays in Inbox and out of this summary.</p></div>}
    {!!needsReply.length&&<section className="digest-section"><h3><MessageSquareText size={15}/> Needs a reply <span>{needsReply.length}</span></h3><div className="digest-list">{needsReply.map(m=><button key={`${m.accountId||''}:${m.id}`} className="digest-row" onClick={()=>open_(m)}><span className="digest-priority high"/><div><strong>{m.sender}{isImportantEmail(m,now)?' · Important':''}</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
    {!!informational.length&&<section className="digest-section"><h3><Info size={15}/> Other important mail <span>{informational.length}</span></h3><div className="digest-list">{informational.map(m=><button key={emailKey(m)} className="digest-row" onClick={()=>open_(m)}><span className="digest-priority high"/><div><strong>{m.sender} · Important</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
  </DialogContent></Dialog>;
}
