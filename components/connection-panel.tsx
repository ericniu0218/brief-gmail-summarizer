'use client';
/* oxlint-disable next/no-html-link-for-pages -- OAuth and platform sign-in require full navigation without prefetch. */
import { ArrowRight, Check, Circle, Mail, ShieldCheck, Clock3, Sparkles, ExternalLink, Moon } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';

import { type ConnectionStatus, type GmailAccount } from '@/hooks/use-inbox';
import { useState } from 'react';
export function ConnectionPanel({open,onOpenChange,status,onDisconnect:_onDisconnect,signInUrl,darkMode,onDarkModeChange,defaultAccountId,onSetDefault,onDisconnectAccount}:{open:boolean;onOpenChange:(open:boolean)=>void;status:ConnectionStatus|null;onDisconnect:()=>void;signInUrl?:string;darkMode:boolean;onDarkModeChange:(enabled:boolean)=>void;defaultAccountId?:string|null;onSetDefault?:(id:string)=>Promise<void>;onDisconnectAccount?:(id:string)=>Promise<unknown>}){
  // Busy state is tracked per account id, so acting on one mailbox never makes the other
  // rows look like they are working.
  const [pending,setPending]=useState('');
  async function runFor(id:string,action:()=>Promise<unknown>,done:string){
    setPending(id);setError('');
    try{await action();setError(done);}
    catch(e){setError(e instanceof Error?e.message:'That account action could not be completed.');}
    finally{setPending('');}
  }
  const [error,setError]=useState('');
  const appearance=<section className="appearance-settings" aria-labelledby="appearance-heading"><h3 id="appearance-heading">Appearance</h3><label htmlFor="dark-mode-switch"><span className="appearance-icon"><Moon size={17}/></span><span><strong>Dark mode</strong><small>Use charcoal surfaces and softer contrast.</small></span><Switch id="dark-mode-switch" checked={darkMode} onCheckedChange={onDarkModeChange} aria-label="Dark mode"/></label></section>;
  if(signInUrl)return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="connection-dialog"><div className="connect-hero"><span className="brand-icon"><Mail size={26}/></span></div><DialogTitle>Sign in to your workspace</DialogTitle><DialogDescription>Sign in with ChatGPT first so Brief can keep your inbox private. You’ll then be able to connect your Google account.</DialogDescription><a className="button blue full" href="/signin-with-chatgpt?return_to=%2Fapi%2Fauth%2Fgoogle" target="_top">Sign in with ChatGPT <ArrowRight size={15}/></a>{appearance}</DialogContent></Dialog>;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="connection-dialog"><div className="connect-hero"><span className="brand-icon"><Mail size={26}/></span></div><DialogTitle>{status?.connected?'Your connected workspace':'Meet your calmer inbox.'}</DialogTitle><DialogDescription>{status?.connected?(status.accounts[0]?.email||'Connected'):'Connect Gmail for priority briefings, suggested replies, and a quieter inbox.'}</DialogDescription>{status?.connected&&status.accounts.length>0&&<AccountList accounts={status.accounts} defaultAccountId={defaultAccountId} pending={pending} onSetDefault={onSetDefault} onDisconnectAccount={onDisconnectAccount} onRun={runFor}/>}<div className="connection-steps">{[{icon:Mail,title:'Gmail connection',ready:!!status?.connected,text:status?.connected?'Connected securely':status?.configured?'Ready for Google sign-in':'Google app setup required'},{icon:Sparkles,title:'AI summaries & replies',ready:!!status?.aiConfigured,text:status?.aiConfigured?'Gemini key connected':'Gemini key required'},{icon:Clock3,title:'Check every 30 minutes',ready:!!status?.schedulerActive,text:status?.schedulerActive?'Background agent is checking in':'Background schedule awaiting activation'}].map(step=><div className="connection-step" key={step.title}><step.icon size={18}/><div><strong>{step.title}</strong><span>{step.text}</span></div>{step.ready?<Check className="step-ready" size={17}/>:<Circle size={13}/>}</div>)}</div>{status&&!status.configured&&<GmailSetupNote status={status}/>}{status?.configured&&!status.connected&&<p className="connection-permissions"><ShieldCheck size={16}/> Google will ask for access to read mail, create drafts, and send replies you choose to send. Relevant email text is sent to Gemini to prepare summaries and replies.</p>}{status?.connected?null:status?.configured?<a className="button blue full" href="/api/auth/google" target="_top">Connect Gmail <ArrowRight size={15}/></a>:<div><button className="button blue full" disabled>Connect Gmail</button><p className="connection-permissions">{status?"Gmail connection is awaiting the one-time setup above.":"Checking connection status. If this does not finish, close this dialog and refresh the page."}</p></div>}{error&&<output className="action-message">{error}</output>}{appearance}<span className="connection-footnote">Your inbox is private. Replies are only sent when you click Send.</span></DialogContent></Dialog>;
}
/**
 * The connected mailboxes, each with its own status and actions. Busy state is per row,
 * so reconnecting one account never makes the others look like they are working.
 */
export function AccountList({accounts,defaultAccountId,pending,onSetDefault,onDisconnectAccount,onRun}:{accounts:GmailAccount[];defaultAccountId?:string|null;pending?:string;onSetDefault?:(id:string)=>Promise<void>;onDisconnectAccount?:(id:string)=>Promise<unknown>;onRun?:(id:string,action:()=>Promise<unknown>,done:string)=>void}){
  return <section className="account-list" aria-label="Connected Gmail accounts">
    {accounts.map(account=><div className="account-row" key={account.id}>
      <div className="account-identity">
        <strong>{account.email}</strong>
        <small>
          {account.reconnectRequired?'Needs reconnection'
            :account.error?account.error
            :account.lastSync?`Last refreshed ${new Date(account.lastSync).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}`
            :'Waiting for its first refresh'}
        </small>
      </div>
      {account.id===defaultAccountId&&<span className="account-default">Default</span>}
      <div className="account-actions">
        {/* Reconnect is aimed at this specific mailbox, so the callback renews the
            account the user clicked rather than whichever one is selected. */}
        {(account.reconnectRequired||account.error)&&<a className="account-action" href={`/api/auth/google?action=reconnect&accountId=${encodeURIComponent(account.id)}`} target="_top">Reconnect</a>}
        {account.id!==defaultAccountId&&onSetDefault&&<button type="button" className="account-action" disabled={!!pending} onClick={()=>onRun?.(account.id,()=>onSetDefault(account.id),`${account.email} is now your default mailbox.`)}>{pending===account.id?'Saving…':'Set as default'}</button>}
        {onDisconnectAccount&&<button type="button" className="account-action danger" disabled={!!pending} onClick={()=>onRun?.(account.id,()=>onDisconnectAccount(account.id),`${account.email} was disconnected.`)}>{pending===account.id?'Disconnecting…':'Disconnect'}</button>}
      </div>
    </div>)}
    <a className="button white full" href="/api/auth/google?action=add" target="_top">Add Gmail account <ArrowRight size={15}/></a>
  </section>;
}

/** Names the exact hosting settings that block Google sign-in, so setup is not guesswork. */
export function GmailSetupNote({status}:{status:ConnectionStatus}){
  return <div className="setup-note"><strong>One-time workspace setup</strong><p>This site is missing {status.missingSettings?.length?<>these private settings: {status.missingSettings.map((name,i)=><span key={name}>{i?', ':''}<code>{name}</code></span>)}</>:'some private settings'}. Add them to the site’s hosting settings and redeploy. A local <code>.env</code> file does not reach the hosted site.</p><details><summary>Setup details</summary><p>In Google Cloud, enable the Gmail API and create a Web application OAuth client with the authorized redirect URI <code>{status.callbackUrl||'https://<your-site>/api/auth/google/callback'}</code>. While the consent screen is in testing, add your Gmail address as a test user.</p><p>Copy the client ID and secret into <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>. Set <code>APP_URL</code> to this site’s address and <code>TOKEN_ENCRYPTION_KEY</code> to a random 32-byte base64 value, for example from <code>openssl rand -base64 32</code>. Keep that key unchanged afterwards. A Gemini key adds summaries but is not needed to connect.</p><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud credentials <ExternalLink size={12}/></a></details></div>;
}
