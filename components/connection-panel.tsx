'use client';
/* eslint-disable next/no-html-link-for-pages -- OAuth requires a full document navigation. */
import { ArrowRight, Check, Circle, Mail, ShieldCheck, Clock3, Sparkles, ExternalLink, Plus } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import type { ConnectionStatus } from '@/hooks/use-inbox';
import { useState } from 'react';

export function ConnectionPanel({open,onOpenChange,status,onDisconnect,onDefaultChange,signInUrl}:{open:boolean;onOpenChange:(open:boolean)=>void;status:ConnectionStatus|null;onDisconnect:(accountId:string)=>Promise<{revoked?:boolean}>;onDefaultChange:(id:string)=>Promise<void>;signInUrl?:string}){
  const [busy,setBusy]=useState('');const [message,setMessage]=useState('');
  async function disconnect(accountId:string){
    setBusy(accountId);setMessage('');
    try{
      const result=await onDisconnect(accountId);
      setMessage(result.revoked?'Account disconnected and its saved inbox removed.':'Account disconnected. Remove Brief’s access in that Google account to finish revoking access.');
    }catch(error){setMessage(error instanceof Error?error.message:'Could not disconnect.');}finally{setBusy('');}
  }
  async function changeDefault(id:string){
    setBusy('default');setMessage('');
    try{await onDefaultChange(id);setMessage('Default account saved. It will open on your next visit.');}
    catch(error){setMessage(error instanceof Error?error.message:'Could not save the default account.');}finally{setBusy('');}
  }
  if(signInUrl)return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="connection-dialog"><div className="connect-hero"><span className="brand-icon"><Mail size={26}/></span></div><DialogTitle>Sign in to your workspace</DialogTitle><DialogDescription>Sign in with ChatGPT first so Brief can keep your inbox private. You’ll then be able to connect your Google accounts.</DialogDescription><a className="button blue full" href={signInUrl} target="_top">Sign in with ChatGPT <ArrowRight size={15}/></a></DialogContent></Dialog>;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="connection-dialog">
    <div className="connect-hero"><span className="brand-icon"><Mail size={26}/></span></div>
    <DialogTitle>{status?.connected?'Your Gmail accounts':'Meet your calmer inbox.'}</DialogTitle>
    <DialogDescription>{status?.connected?'Switch between accounts or see them together in All inboxes.':'Connect Gmail for priority briefings, suggested replies, and a quieter inbox.'}</DialogDescription>
    {status?.connected&&<div className="account-settings">
      <label htmlFor="default-account">Default Gmail account</label>
      <select id="default-account" value={status.defaultAccountId||''} disabled={!!busy} onChange={event=>void changeDefault(event.target.value)}>{status.accounts.map(account=><option key={account.id} value={account.id}>{account.email}</option>)}</select>
      <p>The inbox you see when you open Brief.</p>
      <div className="connected-accounts">{status.accounts.map(account=><div key={account.id} className="connected-account"><div><strong>{account.email}</strong><small>{account.error|| (account.id===status.defaultAccountId?'Default account':'Connected')}</small>{account.reconnectRequired&&<a href="/api/auth/google" target="_top">Reconnect account <ArrowRight size={12}/></a>}</div><button className="button white" disabled={!!busy} onClick={()=>void disconnect(account.id)} aria-label={`Disconnect ${account.email}`}>{busy===account.id?'Removing…':'Disconnect'}</button></div>)}</div>
    </div>}
    <div className="connection-steps">{[{icon:Mail,title:'Gmail connection',ready:!!status?.connected,text:status?.connected?`${status.accounts.length} ${status.accounts.length===1?'account':'accounts'} connected`:status?.configured?'Ready for Google sign-in':'Google app setup required'},{icon:Sparkles,title:'AI summaries & replies',ready:!!status?.aiConfigured,text:status?.aiConfigured?'AI service connected':'AI service connection required'},{icon:Clock3,title:'Check every 30 minutes',ready:!!status?.schedulerActive,text:status?.schedulerActive?'Background agent is checking in':'Background schedule awaiting activation'}].map(step=><div className="connection-step" key={step.title}><step.icon size={18}/><div><strong>{step.title}</strong><span>{step.text}</span></div>{step.ready?<Check className="step-ready" size={17}/>:<Circle size={13}/>}</div>)}</div>
    {!status?.configured&&<div className="setup-note"><strong>One-time workspace setup</strong><p>The workspace owner needs to connect a Google app and the AI service. Once configured, users only need to sign in with Google; Brief handles token renewal automatically.</p><details><summary>Setup details</summary><p>Enable the Gmail API in Google Cloud, configure an OAuth web client, and add this site’s <code>/api/auth/google/callback</code> address. Add the Google client ID and secret plus an AI key to the site’s private settings. The background scheduler must also be enabled.</p><a href="https://console.cloud.google.com/apis/dashboard" target="_blank" rel="noreferrer">Open Google Cloud <ExternalLink size={12}/></a></details></div>}
    {status?.configured&&<><p className="connection-permissions"><ShieldCheck size={16}/> Google will ask for access to read mail, create drafts, and send replies you choose to send. Relevant email text is sent to the connected AI service to prepare summaries and replies.</p><a className="button blue full" href="/api/auth/google" target="_top"><Plus size={15}/>{status.connected?'Add another Gmail account':'Continue with Google'}<ArrowRight size={15}/></a></>}
    {!status?.configured&&<button className="button blue full" onClick={()=>onOpenChange(false)}>Back to your inbox <ArrowRight size={15}/></button>}
    {message&&<output className="action-message" aria-live="polite">{message}</output>}
    <span className="connection-footnote">Your inbox is private. Replies are only sent when you click Send.</span>
  </DialogContent></Dialog>;
}
