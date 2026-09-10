'use client';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowUpRight, MessageSquareText, Info, ShieldCheck } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { isImportantEmail, sortInboxEmails } from '@/lib/inbox-priority';
export function InboxDigest({open,onOpenChange,emails,ai,connected,onSelect}:{open:boolean;onOpenChange:(open:boolean)=>void;emails:Email[];ai:boolean;connected:boolean;onSelect:(email:Email)=>void}){
  const important=sortInboxEmails(emails.filter(isImportantEmail));
  const needsReply=important.filter(m=>m.needsReply);
  const informational=important.filter(m=>!m.needsReply);
  function open_(email:Email){onSelect(email);onOpenChange(false);}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="digest-dialog">
    <DialogTitle>Your important mail, summarized</DialogTitle>
    <DialogDescription>{important.length} important {important.length===1?'email':'emails'} — {needsReply.length} need a reply and appear first.</DialogDescription>
    {connected&&!ai&&<p className="digest-note"><Info size={13}/> AI analysis is unavailable. Reply detection is limited; importance still uses Gmail&apos;s Important label plus security and account-access signals.</p>}
    {important.length===0&&<div className="empty-state"><ShieldCheck size={26}/><h3>Nothing important right now.</h3><p>Routine mail stays in Inbox and out of this summary.</p></div>}
    {!!needsReply.length&&<section className="digest-section"><h3><MessageSquareText size={15}/> Needs a reply <span>{needsReply.length}</span></h3><div className="digest-list">{needsReply.map(m=><button key={m.id} className="digest-row" onClick={()=>open_(m)}><span className="digest-priority high"/><div><strong>{m.sender} · Important</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
    {!!informational.length&&<section className="digest-section"><h3><Info size={15}/> Other important mail <span>{informational.length}</span></h3><div className="digest-list">{informational.map(m=><button key={m.id} className="digest-row" onClick={()=>open_(m)}><span className="digest-priority high"/><div><strong>{m.sender} · Important</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
  </DialogContent></Dialog>;
}
