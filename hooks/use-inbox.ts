'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { demoEmails } from '@/lib/mail';
import { api, ApiError, loadConnectedInbox, type InboxSnapshot as Snapshot } from '@/lib/inbox-client';
export { api, ApiError } from '@/lib/inbox-client';
export type GmailAccount={id:string;email:string;lastSync:number|null;error:string|null;reconnectRequired?:boolean};
export type ConnectionStatus={accounts:GmailAccount[];defaultAccountId:string|null;connected:boolean;configured:boolean;missingSettings?:string[];callbackUrl?:string|null;aiConfigured:boolean;email:string|null;lastSync:number|null;error:string|null;schedulerActive:boolean;intervalMinutes:number};
export function useInbox(){
  const [emails,setEmails]=useState(demoEmails);
  const [status,setStatus]=useState<ConnectionStatus|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [signInUrl,setSignInUrl]=useState<string|undefined>();
  const [updated,setUpdated]=useState<number|null>(null);
  const [ai,setAi]=useState(false);
  const [hasMore,setHasMore]=useState(false);
  const connected=!!status?.connected;
  const accounts=status?.accounts|| (status?.email?[{id:'default',email:status.email,lastSync:status.lastSync,error:status.error}]:[]);
  const activeAccountId='default';
  const activeAccount=accounts[0];
  const inFlight=useRef(false);
  const generation=useRef(0);
  const apply=useCallback((data:Snapshot)=>{setEmails(data.emails);setUpdated(data.updated);setAi(data.ai);setHasMore(!!data.hasMore);},[]);
  const resetToDemo=useCallback(()=>{
    const request=++generation.current;
    inFlight.current=false;setBusy(false);
    setStatus(previous=>previous?{...previous,connected:false,email:null,accounts:[],defaultAccountId:null,lastSync:null,error:null}:null);
    apply({emails:demoEmails,updated:null,ai:false,hasMore:false});
    void api<Snapshot>('/api/demo').then(data=>{if(generation.current===request)apply(data);}).catch(()=>{});
  },[apply]);
  const refresh=useCallback(async(silent=false)=>{
    if(inFlight.current)return;
    if(!connected){if(!silent)setNotice('Sample inbox refreshed. Connect Gmail to receive your own email updates.');return;}
    inFlight.current=true;setBusy(true);
    const request=++generation.current;
    try{
      const data=await api<Snapshot>('/api/sync',{});
      if(generation.current!==request)return;
      apply(data);
      const connection=await api<ConnectionStatus>('/api/connection');
      if(generation.current!==request)return;
      setStatus(connection);setSignInUrl(undefined);
      if(!silent)setNotice('Your inbox is up to date.');
    }
    catch(error){if(generation.current===request){setNotice(error instanceof Error?error.message:'Could not refresh your inbox.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}}
    finally{if(generation.current===request){inFlight.current=false;setBusy(false);}}
  },[connected,apply]);
  useEffect(()=>{
    let active=true;
    const request=++generation.current;
    const controller=new AbortController();
    const current=()=>active&&generation.current===request;
    const error=new URLSearchParams(window.location.search).get('connection_error');
    const noticeTimer=error?window.setTimeout(()=>{if(active)setNotice(error);},0):null;
    if(window.location.search)window.history.replaceState(null,'',window.location.pathname);
    void api<ConnectionStatus>('/api/connection',undefined,controller.signal).then(async result=>{
      if(!current())return;setStatus(result);setSignInUrl(undefined);
      if(result.connected){
        inFlight.current=true;setBusy(true);
        apply({emails:[],updated:null,ai:false});
        await loadConnectedInbox(data=>{if(current())apply(data);},controller.signal);
        if(!current())return;
        const connection=await api<ConnectionStatus>('/api/connection',undefined,controller.signal);
        if(current())setStatus(connection);
      }
      else{const data=await api<Snapshot>('/api/demo',undefined,controller.signal).catch(()=>null);if(current()&&data)apply(data);}
    }).catch(error=>{if(current()){setNotice(error instanceof Error?error.message:'Connection status is unavailable. Please refresh the page to try again.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}})
      .finally(()=>{if(current()){inFlight.current=false;setBusy(false);}});
    return()=>{active=false;controller.abort();if(noticeTimer!==null)window.clearTimeout(noticeTimer);};
  },[apply]);
  useEffect(()=>{
    if(!connected)return;
    const syncTimer=window.setInterval(()=>void refresh(true),30*60*1000);
    const pollTimer=window.setInterval(()=>{
      const request=generation.current;
      if(document.visibilityState==='visible'&&!inFlight.current)void api<Snapshot>('/api/mailbox').then(data=>{if(generation.current===request&&!inFlight.current)apply(data);}).catch(()=>{});
    },60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh(true);};
    document.addEventListener('visibilitychange',visible);
    return()=>{clearInterval(syncTimer);clearInterval(pollTimer);document.removeEventListener('visibilitychange',visible);};
  },[connected,refresh,apply]);
  return {emails,setEmails,status,setStatus,accounts,activeAccount,activeAccountId,setActiveAccountId:(_id:string)=>{},defaultAccountId:status?.defaultAccountId||accounts[0]?.id||null,connected,busy,notice,setNotice,signInUrl,updated,ai,hasMore,refresh,resetToDemo,reload:async()=>{await refresh(true)},setDefaultAccount:async(_id:string)=>{},disconnectAccount:async()=>{await api('/api/disconnect',{});resetToDemo();return {revoked:false}}};
}
