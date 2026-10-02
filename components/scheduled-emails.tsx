'use client';
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Pencil, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/hooks/use-inbox';
import type { ComposeFields } from '@/components/compose-dialog';

type Item={id:string;accountId:string;accountEmail:string|null;sendAt:number;status:'scheduled'|'sending'|'failed';error:string|null;payload:{to:string[];cc:string[];bcc:string[];subject:string;body:string}};
const stamp=(time:number)=>new Date(time).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});

/**
 * Emails waiting to go out. `onEdit` loads one into the compose window and returns false if the
 * user chose to keep what they were already writing; the scheduled copy is only cancelled once it
 * is loaded.
 */
export function ScheduledEmails({connected,version,showAccount,onEdit}:{connected:boolean;version:number;showAccount:boolean;onEdit:(fields:ComposeFields)=>boolean}){
  const [items,setItems]=useState<Item[]>([]);
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const load=useCallback(async()=>{
    try{setItems((await api<{items:Item[]}>('/api/scheduled')).items);}
    catch{/* The list is a convenience; failing quietly keeps the rest of the dashboard usable. */}
  },[]);
  useEffect(()=>{
    if(!connected)return;
    let active=true;
    api<{items:Item[]}>('/api/scheduled').then(result=>{if(active)setItems(result.items);}).catch(()=>{});
    return()=>{active=false;};
  },[connected,version]);
  async function cancel(item:Item,edit:boolean){
    setBusy(item.id);setError('');
    try{
      if(edit&&!onEdit({to:item.payload.to.join(', '),cc:item.payload.cc.join(', '),bcc:item.payload.bcc.join(', '),subject:item.payload.subject,body:item.payload.body,accountId:item.accountId}))return;
      await api('/api/scheduled',{action:'cancel',id:item.id});
      if(edit)setOpen(false);
      await load();
    }catch(failure){setError(failure instanceof Error?failure.message:'Could not change that email.');await load();}
    finally{setBusy('');}
  }
  if(!connected||(!items.length&&!open))return null;
  return <>
    <button className="button white" onClick={()=>setOpen(true)}><CalendarClock size={15}/>Scheduled ({items.length})</button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="compose-dialog sm:max-w-xl">
      <DialogTitle>Scheduled emails</DialogTitle>
      <DialogDescription>These go out within about 30 minutes after their time. Edit one to change it, or cancel it.</DialogDescription>
      {!items.length&&<p className="compose-note">Nothing is scheduled.</p>}
      <ul className="scheduled-list">{items.map(item=><li key={item.id} className="scheduled-item" data-status={item.status}>
        <div><strong>{item.payload.subject}</strong><span>To {item.payload.to.join(', ')}{showAccount&&item.accountEmail?` · from ${item.accountEmail}`:''}</span>
          <small>{item.status==='failed'?item.error:item.status==='sending'?'Sending now…':`Goes out around ${stamp(item.sendAt)}`}</small></div>
        <div className="scheduled-actions">
          <button className="button white" onClick={()=>void cancel(item,true)} disabled={item.status==='sending'||!!busy}><Pencil size={13}/>Edit</button>
          <button className="button white" onClick={()=>void cancel(item,false)} disabled={item.status==='sending'||!!busy}><X size={13}/>{item.status==='failed'?'Dismiss':'Cancel'}</button>
        </div>
      </li>)}</ul>
      {error&&<output className="action-message error" aria-live="assertive">{error}</output>}
    </DialogContent></Dialog>
  </>;
}
