'use client';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { ArrowUpRight, MessageSquareText, Info, ShieldCheck } from 'lucide-react';
import type { Email } from '@/lib/mail';
const rank={high:0,normal:1} as const;
export function InboxDigest({open,onOpenChange,emails,ai,connected,onSelect}:{open:boolean;onOpenChange:(open:boolean)=>void;emails:Email[];ai:boolean;connected:boolean;onSelect:(email:Email)=>void}){
  const mail=emails.filter(m=>m.category!=='noise');
  const sorted=[...mail].sort((a,b)=>rank[a.priority]-rank[b.priority]);
  const needsReply=sorted.filter(m=>m.needsReply);
  const informational=sorted.filter(m=>!m.needsReply);
  function open_(email:Email){onSelect(email);onOpenChange(false);}
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="digest-dialog">
    <DialogTitle>Your inbox, summarized</DialogTitle>
    <DialogDescription>{mail.length} emails ranked by importance — {needsReply.length} need a reply, {informational.length} are just for your information.</DialogDescription>
    {connected&&!ai&&<p className="digest-note"><Info size={13}/> AI analysis is unavailable. Reply detection is limited, and importance currently reflects Gmail&apos;s own Important label.</p>}
    {mail.length===0&&<div className="empty-state"><ShieldCheck size={26}/><h3>Nothing to summarize yet.</h3><p>New conversations will appear here after your next refresh.</p></div>}
    {!!needsReply.length&&<section className="digest-section"><h3><MessageSquareText size={15}/> Needs a reply <span>{needsReply.length}</span></h3><div className="digest-list">{needsReply.map(m=><button key={m.id} className="digest-row" onClick={()=>open_(m)}><span className={`digest-priority ${m.priority}`}/><div><strong>{m.sender}</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
    {!!informational.length&&<section className="digest-section"><h3><Info size={15}/> For your information <span>{informational.length}</span></h3><div className="digest-list">{informational.map(m=><button key={m.id} className="digest-row" onClick={()=>open_(m)}><span className={`digest-priority ${m.priority}`}/><div><strong>{m.sender}</strong><span className="digest-subject">{m.subject}</span><p>{m.summary}</p></div><ArrowUpRight size={15}/></button>)}</div></section>}
  </DialogContent></Dialog>;
}
