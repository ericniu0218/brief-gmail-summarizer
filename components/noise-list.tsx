'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Ban, Check, ChevronDown, Layers3, MailMinus, Sparkles, X } from 'lucide-react';
import { api } from '@/hooks/use-inbox';
import { actionAccountId, emailKey, senderKey, gmailLink, type Email } from '@/lib/mail';
import type { BlockedSender } from '@/lib/inbox-client';
import { BlockConfirm, setSkipsBlockConfirm, skipsBlockConfirm } from '@/components/block-confirm';
import { normalizeSenderAddress } from '@/lib/addresses';
import { notice, type UnsubscribeAction, type UnsubscribeCapability, type UnsubscribeOutcome } from '@/lib/unsubscribe';

/**
 * Noise, grouped by sender, with an unsubscribe control attached to a **newsletter** rather
 * than to a sender.
 *
 * A publisher can send several lists from one address. Where a sender group holds more than
 * one, no single control appears on the group row, because one click there would imply it
 * covered all of them; the controls move onto the individual messages instead. Where the
 * group is one newsletter, the control stays on the group row exactly as before.
 *
 * A newsletter with a verified one-click unsubscribe gets that button. Every other sender
 * gets "Block sender" instead, which hides that sender's mail in this app. Unsubscribing
 * never hides anything; blocking never contacts the sender and never deletes mail, so
 * unblocking from the list at the bottom brings every message back.
 */

type UnsubscribeResult = {
  capability: UnsubscribeCapability; outcome: UnsubscribeOutcome;
  reason?: string; page?: string; gmailUrl?: string;
  scope?: string; scopeDetail?: string; detail?: string;
};

/** What a finished attempt left behind, kept per newsletter so controls never share one. */
type Result = { text: string; action: UnsubscribeAction; page?: string; email: Email; detail?: string;
  /** The unsubscribe did not go through, so blocking the sender is offered alongside. */
  confirmRetry?: boolean; offerBlock?: boolean };

/** Outcomes where the unsubscribe worked or is still under way, so no fallback is offered. */
const SETTLED = new Set(['accepted', 'in-progress', 'record-not-saved', 'account-disconnected']);

/** A newsletter within a sender group: its List-ID when it named one, else the message. */
function listKey(email: Email) {
  return email.listId ? `list:${email.accountId||''}:${email.listId}` : `message:${emailKey(email)}`;
}

/** A sender within one account, which is what blocking applies to. */
function blockKey(email: Email) {
  return `sender:${senderKey(email)}`;
}

/** The unblock control for one blocked sender. */
function unblockKey(sender: BlockedSender) {
  return `unblock:${sender.accountId}:${sender.address}`;
}

/** Only a real address can be blocked; a synthetic identity would be refused by the server. */
function blockable(email: Email) {
  return !!normalizeSenderAddress(email.address);
}

/** Only a verified, supported one-click newsletter gets an Unsubscribe button. */
function automatic(email: Email) {
  return !!email.oneClick;
}

export function NoiseList(props:Parameters<typeof NoiseListForUser>[0]){
  return <NoiseListForUser key={props.user||''} {...props}/>;
}

function NoiseListForUser({emails,demo,blocked=[],user='',onSelect,onBlockChanged}:{emails:Email[];demo:boolean;blocked?:BlockedSender[];
  /** The signed-in user, so "don't ask again" is remembered for that person only. */
  user?:string;
  onSelect:(email:Email)=>void;
  /** Re-read the mailbox after a block or unblock. Resolves false if that re-read failed. */
  onBlockChanged?:()=>Promise<boolean>}){
  const [expanded,setExpanded]=useState<string|null>(null);
  // Which controls have a request running, keyed by what each acts on — a newsletter, a
  // sender, or a blocked sender. Progress wording belongs to the control that started it;
  // an unrelated button in the same account neither changes its label nor stops working.
  const [busy,setBusy]=useState<Set<string>>(()=>new Set());
  const [results,setResults]=useState<Record<string,Result>>({});
  const [explained,setExplained]=useState<string|null>(null);
  const [unblockError,setUnblockError]=useState('');
  // Confirms a block that just happened, with Undo. It sits above the list rather than on
  // the row, because the blocked sender's row leaves the list once the mailbox is re-read.
  const [blockNotice,setBlockNotice]=useState<{sender:BlockedSender;reloaded:boolean}|null>(null);
  // The sender waiting on the "Block this sender?" question, if it is open.
  const [confirming,setConfirming]=useState<Email|null>(null);
  const [skipping,setSkipping]=useState(()=>skipsBlockConfirm(user));
  // A synchronous guard as well as the rendered `disabled`: React applies state after the
  // event, so two fast clicks can both pass a check that has not re-rendered yet.
  const running=useRef(new Set<string>());

  // Grouping keeps a frequent sender from taking over the page.
  const groups=Array.from(emails.reduce((map,m)=>{
    map.set(senderKey(m),[...(map.get(senderKey(m))||[]),m]);return map;
  },new Map<string,Email[]>()));
  const shown=new Set([...emails.map(listKey),...emails.map(blockKey)]);
  // A late answer is checked against the list on screen *when it arrives*. The set above
  // belongs to the render in which the button was pressed, which would always contain it.
  const onScreen=useRef(shown);
  useEffect(()=>{onScreen.current=shown;});

  function start(key:string){
    if(running.current.has(key))return false;
    running.current.add(key);
    setBusy(current=>new Set(current).add(key));
    return true;
  }
  function finish(key:string){
    running.current.delete(key);
    setBusy(current=>{const next=new Set(current);next.delete(key);return next;});
  }

  async function unsubscribe(email:Email,confirmRetry=false){
    const key=listKey(email);
    if(!start(key))return;
    setResults(current=>{const next={...current};delete next[key];return next;});
    try{
      if(demo){
        record(key,{text:'Demo only — no request was sent. Your real subscriptions are unchanged.',
          action:'none',email});
        return;
      }
      const result=await api<UnsubscribeResult>('/api/unsubscribe',{id:email.id,accountId:actionAccountId(email),confirmRetry});
      // The server names the situation; the wording lives in one place so no button can
      // claim "Unsubscribed" for a page that was merely opened.
      const {text,action}=notice(result.reason);
      record(key,{text,action,page:result.page,email,detail:result.scopeDetail,
        confirmRetry:result.outcome==='unknown',offerBlock:!SETTLED.has(String(result.reason))});
    }
    catch(error){record(key,{text:error instanceof Error?error.message:'Could not unsubscribe.',action:'gmail',email,offerBlock:true});}
    finally{finish(key);}
  }

  /**
   * Hide every email from this sender in this account. Nothing is sent to the sender and
   * nothing is deleted; the group simply leaves the list once the mailbox is re-read.
   */
  async function block(email:Email){
    const key=blockKey(email);
    if(!start(key))return;
    try{
      if(demo){
        record(key,{text:'Demo only — nothing was blocked. With Gmail connected, blocking hides a sender’s emails here without deleting them.',action:'none',email});
        return;
      }
      const accountId=actionAccountId(email);
      await api('/api/block',{accountId,address:email.address,name:email.sender,blocked:true});
      const sender={accountId,accountEmail:email.accountEmail||'',address:email.address,name:email.sender||null,created:0};
      setBlockNotice({sender,reloaded:!onBlockChanged||await onBlockChanged()});
    }
    catch(error){record(key,{text:error instanceof Error?error.message:'Could not block this sender.',action:'none',email});}
    finally{finish(key);}
  }

  /** Ask first, unless this person chose not to be asked again. */
  function requestBlock(email:Email){
    if(!blockable(email)||running.current.has(blockKey(email)))return;
    if(skipsBlockConfirm(user))void block(email);
    else setConfirming(email);
  }

  function confirmBlock(dontAsk:boolean){
    const email=confirming;
    setConfirming(null);
    if(dontAsk){setSkipsBlockConfirm(user,true);setSkipping(true);}
    if(email)void block(email);
  }

  function askAgain(){
    setSkipsBlockConfirm(user,false);
    setSkipping(false);
  }

  async function unblock(sender:BlockedSender){
    const key=unblockKey(sender);
    if(!start(key))return;
    setUnblockError('');
    try{
      await api('/api/block',{accountId:sender.accountId,address:sender.address,blocked:false});
      setBlockNotice(current=>current&&current.sender.accountId===sender.accountId&&current.sender.address===sender.address?null:current);
      if(onBlockChanged&&!await onBlockChanged())
        setUnblockError(`Unblocked ${sender.name||sender.address}. Their emails will return the next time your inbox loads.`);
    }
    catch(error){setUnblockError(error instanceof Error?error.message:'Could not unblock this sender.');}
    finally{finish(key);}
  }

  function blockControl(email:Email){
    // A sender with no real address (an unattributed message) cannot be blocked.
    if(!blockable(email))return null;
    const key=blockKey(email);
    const result=results[key];
    const working=busy.has(key);
    return <div className="unsubscribe-control">
      <button className="unsubscribe-button" disabled={working} aria-busy={working||undefined}
        onClick={event=>{event.stopPropagation();requestBlock(email);}}>
        <Ban size={14}/>{working?'Blocking…':'Block sender'}
      </button>
      {result&&<output className="unsubscribe-notice" aria-live="polite"><span>{result.text}</span></output>}
    </div>;
  }

  /**
   * Keep a finished attempt only while its newsletter is still on screen. Switching account
   * or view replaces the list, and a late answer for something no longer shown would attach
   * itself to whatever now sits in that position. The server-side record is already written
   * either way, so nothing is lost by dropping the message.
   */
  function record(key:string,result:Result){
    if(!onScreen.current.has(key))return;
    setResults(current=>({...current,[key]:result}));
  }

  function control(email:Email,label:string){
    const key=listKey(email);
    const result=results[key];
    const working=busy.has(key);
    return <div className="unsubscribe-control">
      <button className="unsubscribe-button" disabled={working} aria-busy={working||undefined}
        onClick={event=>{event.stopPropagation();void unsubscribe(email,result?.confirmRetry);}}>
        <MailMinus size={14}/>{working?'Unsubscribing…':result?.confirmRetry?'I checked — retry unsubscribe':result?'Unsubscribe again':label}
      </button>
      {result&&<output className="unsubscribe-notice" aria-live="polite">
        <span>{result.text}</span>
        {result.action==='page'&&result.page&&<a href={result.page} target="_blank" rel="noreferrer">Open unsubscribe page <ArrowUpRight size={12}/></a>}
        {result.action==='gmail'&&<a href={gmailLink(result.email)} target="_blank" rel="noreferrer">Open in Gmail <ArrowUpRight size={12}/></a>}
        {result.detail&&<button type="button" className="text-button" aria-expanded={explained===key}
          onClick={()=>setExplained(explained===key?null:key)}>{explained===key?'Hide detail':'What does this cover?'}</button>}
        {explained===key&&result.detail&&<small>{result.detail}</small>}
        {result.offerBlock&&!demo&&blockable(result.email)&&<button type="button" className="text-button" disabled={busy.has(blockKey(result.email))}
          onClick={event=>{event.stopPropagation();requestBlock(result.email);}}>Block sender instead</button>}
      </output>}
    </div>;
  }

  return <section className="noise-view">
    <div className="noise-view-heading"><span className="section-icon"><Layers3 size={22}/></span>
      <div><h2>Your quiet corner</h2>
        <p>{emails.length} emails from {groups.length} senders. Keep what you love. Let the rest go.</p></div>
    </div>
    {blockNotice&&<output className="block-notice" aria-live="polite">
      <Ban size={16}/>
      <span><strong>Blocked {blockNotice.sender.name||blockNotice.sender.address}.</strong>
        {blockNotice.reloaded?'':' Their emails will disappear the next time your inbox loads.'}</span>
      <button type="button" className="text-button" disabled={busy.has(unblockKey(blockNotice.sender))} onClick={()=>void unblock(blockNotice.sender)}>Undo</button>
      <button type="button" className="block-notice-close" aria-label="Dismiss" onClick={()=>setBlockNotice(null)}><X size={14}/></button>
    </output>}
    <div className="noise-tip"><Sparkles size={16}/><span>Newsletters and promotions are grouped by sender. Unsubscribing asks the sender to stop; your existing emails stay here.</span></div>
    {groups.length===0
      ?<div className="empty-state"><Check size={30}/><h3>Nothing to clear.</h3><p>Your quiet corner is all caught up.</p></div>
      :<div className="sender-groups">{groups.map(([address,items])=>{
        const first=items[0];
        const open=expanded===address;
        // One control per newsletter. A sender with two lists gets none on its group row.
        const newsletters=new Set(items.map(listKey));
        const single=newsletters.size===1;
        // A verified one-click newsletter gets Unsubscribe; any other sender gets Block.
        const verified=items.filter(automatic);
        const toggle=()=>setExpanded(open?null:address);
        return <article className="sender-group" key={address}>
          <div className="sender-group-row">
            <button className={`avatar ${first.color}`} onClick={toggle} aria-label={`Show emails from ${first.sender}`}>{first.initials}</button>
            <button className="group-name" onClick={toggle} aria-expanded={open}>
              <strong>{first.sender}</strong>
              {first.accountEmail&&<small className="email-account">{first.accountEmail}</small>}
              <span>{items.length} {items.length===1?'email':'emails'} · {first.subject}</span>
            </button>
            <button className="expand-group" aria-label={`Expand ${first.sender}`} aria-expanded={open} onClick={toggle}><ChevronDown size={15}/></button>
            {single&&verified.length?control(verified[0],'Unsubscribe'):blockControl(first)}
          </div>
          {!single&&verified.length>0&&<p className="group-multiple">This sender sends {newsletters.size} separate newsletters. Open the group to unsubscribe from one of them.</p>}
          {open&&<div className="group-emails">{items.map(m=><div className="group-email" key={emailKey(m)}>
            <button className="group-email-open" onClick={()=>onSelect(m)}><span>{m.subject}</span><ArrowUpRight size={14}/></button>
            {!single&&automatic(m)&&control(m,'Unsubscribe from this newsletter')}
          </div>)}</div>}
        </article>;
      })}</div>}
    {blocked.length>0&&<section className="blocked-senders" aria-label="Blocked senders">
      <h3>Blocked senders <span>{blocked.length}</span></h3>
      <p>Their emails are hidden here, not deleted. Unblock a sender to see their emails again.</p>
      {unblockError&&<output className="unsubscribe-notice" aria-live="polite">{unblockError}</output>}
      <ul>{blocked.map(sender=>{
        const key=unblockKey(sender);
        return <li key={key}>
          <span><strong>{sender.name||sender.address}</strong><small>{sender.address} · {sender.accountEmail}</small></span>
          <button className="unsubscribe-button" disabled={busy.has(key)} aria-busy={busy.has(key)||undefined}
            aria-label={`Unblock ${sender.name||sender.address}`}
            onClick={()=>void unblock(sender)}>{busy.has(key)?'Unblocking…':'Unblock'}</button>
        </li>;
      })}</ul>
    </section>}
    {skipping&&<p className="block-skip-note">You chose not to be asked before blocking a sender.
      <button type="button" className="text-button" onClick={askAgain}>Ask me again</button></p>}
    <BlockConfirm name={confirming?(confirming.sender||confirming.address):null}
      onConfirm={confirmBlock} onCancel={()=>setConfirming(null)}/>
    <p className="noise-footnote"><Check size={13}/> One-click unsubscribe is offered only for verified newsletters. Any other sender can be blocked: their emails are hidden in this app, never deleted.</p>
  </section>;
}
