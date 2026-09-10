'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { demoEmails, type Email } from '@/lib/mail';
export type ConnectionStatus={connected:boolean;configured:boolean;aiConfigured:boolean;email:string|null;lastSync:number|null;error:string|null;schedulerActive:boolean;intervalMinutes:number};
export class ApiError extends Error {
  constructor(message:string, public signInUrl?:string) { super(message); }
}
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json() as T & {error?:string;signInUrl?:string};
  if(!response.ok)throw new ApiError(data.error||'That request could not be completed. Please try again.',data.signInUrl==='/signin-with-chatgpt?return_to=%2F'?data.signInUrl:undefined);
  return data;
}
type Snapshot={emails:Email[];updated:number|null;ai:boolean;hasMore?:boolean};
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
  const inFlight=useRef(false);
  const apply=useCallback((data:Snapshot)=>{setEmails(data.emails);setUpdated(data.updated);setAi(data.ai);setHasMore(!!data.hasMore);},[]);
  const refresh=useCallback(async(silent=false)=>{
    if(inFlight.current)return;
    if(!connected){if(!silent)setNotice('Sample inbox refreshed. Connect Gmail to receive your own email updates.');return;}
    inFlight.current=true;setBusy(true);
    try{apply(await api<Snapshot>('/api/sync',{}));setStatus(await api<ConnectionStatus>('/api/connection'));if(!silent)setNotice('Your inbox is up to date.');}
    catch(error){setNotice(error instanceof Error?error.message:'Could not refresh your inbox.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}
    finally{inFlight.current=false;setBusy(false);}
  },[connected,apply]);
  useEffect(()=>{
    let active=true;
    const error=new URLSearchParams(window.location.search).get('connection_error');
    if(error)setNotice(error);
    if(window.location.search)window.history.replaceState(null,'',window.location.pathname);
    void api<ConnectionStatus>('/api/connection').then(async result=>{
      if(!active)return;setStatus(result);
      if(result.connected){setEmails([]);const data=await api<Snapshot>('/api/mailbox');if(active)apply(data);}
    }).catch(error=>{if(active){setNotice(error instanceof Error?error.message:'Connection status is unavailable. The sample inbox is still available.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}});
    return()=>{active=false;};
  },[apply]);
  useEffect(()=>{
    if(!connected)return;
    void refresh(true);
    const syncTimer=window.setInterval(()=>void refresh(true),30*60*1000);
    const pollTimer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!inFlight.current)void api<Snapshot>('/api/mailbox').then(apply).catch(()=>{});},60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh(true);};
    document.addEventListener('visibilitychange',visible);
    return()=>{clearInterval(syncTimer);clearInterval(pollTimer);document.removeEventListener('visibilitychange',visible);};
  },[connected,refresh,apply]);
  return {emails,setEmails,status,setStatus,connected,busy,notice,setNotice,signInUrl,updated,ai,hasMore,refresh};
}
