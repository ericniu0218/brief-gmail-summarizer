'use client';
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { reconcileInbox } from '@/lib/inbox-state';
import { demoEmails, type Email } from '@/lib/mail';
export type GmailAccount={id:string;email:string;lastSync:number|null;error:string|null;reconnectRequired?:boolean};
export type ConnectionStatus={accounts:GmailAccount[];defaultAccountId:string|null;connected:boolean;configured:boolean;aiConfigured:boolean;email:string|null;lastSync:number|null;error:string|null;schedulerActive:boolean;intervalMinutes:number};
export class ApiError extends Error {
  constructor(message:string, public signInUrl?:string) { super(message); }
}
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json().catch(()=>{throw new ApiError('The inbox service returned an unreadable response. Please try again.');}) as T & {error?:string;signInUrl?:string};
  if(!data||typeof data!=='object')throw new ApiError('The inbox service returned an unreadable response. Please try again.');
  if(!response.ok)throw new ApiError(data.error||'That request could not be completed. Please try again.',data.signInUrl==='/signin-with-chatgpt?return_to=%2F'?data.signInUrl:undefined);
  return data;
}
type Snapshot={emails:Email[];accounts:{accountId:string;updated:number|null;ai:boolean;hasMore:boolean;warning?:string}[];connection:ConnectionStatus;errors?:{email:string;message:string}[]};
export function useInbox(){
  const [allEmails,setMail]=useState(demoEmails);
  const [snapshots,setSnapshots]=useState<Snapshot['accounts']>([]);
  const [status,setStatus]=useState<ConnectionStatus|null>(null);
  const [activeAccountId,setActiveAccountId]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [signInUrl,setSignInUrl]=useState<string|undefined>();
  const version=useRef(0);
  const edits=useRef(0);
  const inFlight=useRef(false);
  const connected=!!status?.connected;
  const accounts=status?.accounts||[];
  const selectedAccountId=activeAccountId==='all'?'all':accounts.some(a=>a.id===activeAccountId)?activeAccountId:status?.defaultAccountId;
  const activeAccount=accounts.find(a=>a.id===selectedAccountId);
  const emails=connected&&selectedAccountId!=='all'?allEmails.filter(m=>m.accountId===selectedAccountId):allEmails;
  const currentSnapshots=snapshots.filter(s=>selectedAccountId==='all'||s.accountId===selectedAccountId);
  const synced=currentSnapshots.filter(s=>s.updated!==null);
  const updated=synced.length?Math.min(...synced.map(s=>s.updated!)):null;
  const ai=currentSnapshots.length>0&&currentSnapshots.every(s=>s.ai);
  const hasMore=currentSnapshots.some(s=>s.hasMore);
  const report=useCallback((error:unknown)=>{
    setNotice(error instanceof Error?error.message:'Could not load your inbox.');
    if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);
  },[]);
  const applyStatus=useCallback((result:ConnectionStatus)=>{
    setStatus(result);setSignInUrl(undefined);
    setActiveAccountId(previous=>reconcileInbox(result,[],[],previous).activeAccountId);
    setMail(previous=>reconcileInbox(result,previous,[]).emails);
    setSnapshots(previous=>reconcileInbox(result,[],previous).snapshots);
  },[]);
  const apply=useCallback((data:Snapshot,editVersion:number)=>{
    applyStatus(data.connection);
    if(editVersion!==edits.current)return;
    const state=reconcileInbox(data.connection,data.emails,data.accounts);
    setMail(state.emails);setSnapshots(state.snapshots);
  },[applyStatus]);
  const reload=useCallback(async(showBusy=true)=>{
    const request=++version.current;const editVersion=edits.current;inFlight.current=true;if(showBusy)setBusy(true);
    try{
      const data=await api<Snapshot>('/api/mailbox');
      if(request===version.current)apply(data,editVersion);
    }catch(error){if(request===version.current)report(error);}
    finally{if(request===version.current){inFlight.current=false;setBusy(false);}}
  },[apply,report]);
  const refresh=useCallback(async(silent=false)=>{
    if(inFlight.current)return;
    if(!connected){if(!silent)setNotice('Sample inbox refreshed. Connect Gmail to receive your own email updates.');return;}
    const request=++version.current;const editVersion=edits.current;inFlight.current=true;setBusy(true);
    try{
      const data=await api<Snapshot>('/api/sync',{accountId:'all'});
      if(request!==version.current)return;
      apply(data,editVersion);
      if(data.errors?.length)setNotice(data.errors.map(error=>`${error.email}: ${error.message}`).join(' '));
      else if(data.accounts.some(account=>account.warning))setNotice(data.accounts.filter(account=>account.warning).map(account=>account.warning).join(' '));
      else if(!silent)setNotice('All connected inboxes are up to date.');
    }catch(error){if(request===version.current)report(error);}
    finally{if(request===version.current){inFlight.current=false;setBusy(false);}}
  },[connected,apply,report]);
  const cancelPending=useCallback(()=>{version.current++;inFlight.current=false;},[]);
  useEffect(()=>{
    const error=new URLSearchParams(window.location.search).get('connection_error');
    const initial=window.setTimeout(()=>{if(error)setNotice(error);if(window.location.search)window.history.replaceState(null,'',window.location.pathname);void reload();},0);
    return()=>{window.clearTimeout(initial);cancelPending();};
  },[reload,cancelPending]);
  useEffect(()=>{
    if(!connected)return;
    const initial=window.setTimeout(()=>void refresh(true),0);
    const syncTimer=window.setInterval(()=>void refresh(true),30*60*1000);
    const pollTimer=window.setInterval(()=>{
      if(document.visibilityState!=='visible'||inFlight.current)return;
      void reload(false);
    },60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh(true);};
    document.addEventListener('visibilitychange',visible);
    return()=>{window.clearTimeout(initial);clearInterval(syncTimer);clearInterval(pollTimer);document.removeEventListener('visibilitychange',visible);};
  },[connected,refresh,reload]);
  async function updateSettings(path:string,accountId:string){
    const request=++version.current;inFlight.current=true;setBusy(true);
    try{
      const result=await api<ConnectionStatus & {revoked?:boolean}>(path,{accountId});
      if(request===version.current)applyStatus(result);
      return result;
    }catch(error){if(request===version.current)report(error);throw error;}
    finally{if(request===version.current){inFlight.current=false;setBusy(false);}}
  }
  async function setDefaultAccount(accountId:string){await updateSettings('/api/connection',accountId);}
  async function disconnectAccount(accountId:string){return await updateSettings('/api/disconnect',accountId);}
  function setEmails(value:SetStateAction<Email[]>){
    edits.current++;setMail(value);
  }
  return {emails,allEmails,setEmails,status,accounts,activeAccount,activeAccountId:selectedAccountId,setActiveAccountId,connected,busy,notice,setNotice,signInUrl,updated,ai,hasMore,refresh,reload,setDefaultAccount,disconnectAccount};
}
