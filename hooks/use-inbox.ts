'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Digest } from '@/lib/digest';
import { demoEmails } from '@/lib/mail';
import { api, ApiError, loadConnectedInbox, syncFailureMessage, type BlockedSender, type InboxSnapshot as Snapshot } from '@/lib/inbox-client';
export { api, ApiError } from '@/lib/inbox-client';
export type GmailAccount={id:string;email:string;lastSync:number|null;error:string|null;reconnectRequired?:boolean};
/** The person's own sending settings, shared by every connected mailbox. */
export type Profile={name:string;signature:string};
export type ConnectionStatus={userId?:string;profile?:Profile;accounts:GmailAccount[];defaultAccountId:string|null;connected:boolean;configured:boolean;missingSettings?:string[];callbackUrl?:string|null;aiConfigured:boolean;schedulerActive:boolean;intervalMinutes:number};

/** The reserved selection meaning "every connected mailbox". */
export const ALL_INBOXES='all';

/**
 * The last selected view is remembered per application user, so signing in as someone
 * else on the same browser never restores the previous person's mailbox. Storage may be
 * unavailable (private windows, blocked site data), which is treated as "no memory".
 */
function selectionKey(user:string){return `brief:selected-view:${user}`;}
function rememberedSelection(user:string){
  try{return window.localStorage.getItem(selectionKey(user))||null;}catch{return null;}
}
function rememberSelection(user:string,view:string){
  try{window.localStorage.setItem(selectionKey(user),view);}catch{/* storage is optional */}
}

/**
 * Chooses which view to open on, given what the browser remembered and which mailboxes
 * the user actually owns. A remembered selection is honoured only while it still names an
 * owned account, so a disconnected or foreign id can never be restored.
 */
export function resolveSelection(remembered:string|null,accounts:{id:string}[],defaultAccountId:string|null){
  const owned=new Set(accounts.map(a=>a.id));
  if(remembered===ALL_INBOXES)return ALL_INBOXES;
  if(remembered&&owned.has(remembered))return remembered;
  if(defaultAccountId&&owned.has(defaultAccountId))return defaultAccountId;
  return accounts[0]?.id??ALL_INBOXES;
}

/**
 * Guards asynchronous work against a selection that changed while it was running.
 *
 * Every load takes a ticket before it starts; only the newest ticket may write state. A
 * slow response for a mailbox the user has already switched away from is therefore
 * discarded instead of painting over the mailbox now on screen.
 */
export function requestGate(){
  let current=0;
  return {
    /** Start a new operation, invalidating every earlier one. */
    begin(){return ++current;},
    /** True only while `ticket` is still the newest operation. */
    isCurrent(ticket:number){return ticket===current;},
  };
}

/**
 * Owns the client-side mailbox lifecycle. The hook starts with demo data, discovers the
 * Gmail connection, loads cached and refreshed snapshots, and rejects stale async results
 * when the account state changes while a request is running.
 */
export function useInbox(){
  // Data displayed by the inbox and the small set of connection/sync status values the
  // surrounding UI needs. Demo messages provide a useful first render before boot finishes.
  const [emails,setEmails]=useState(demoEmails);
  const [status,setStatus]=useState<ConnectionStatus|null>(null);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [signInUrl,setSignInUrl]=useState<string|undefined>();
  const [updated,setUpdated]=useState<number|null>(null);
  const [ai,setAi]=useState(false);
  const [hasMore,setHasMore]=useState(false);
  const [skipped,setSkipped]=useState(0);
  const [selectedView,setSelectedView]=useState<string>(ALL_INBOXES);
  const [accountStates,setAccountStates]=useState<Snapshot['accounts']>([]);
  const [blocked,setBlocked]=useState<BlockedSender[]>([]);
  const [digest,setDigest]=useState<Digest|undefined>();
  // Preferences are keyed by the signed-in user so one person's selection never leaks
  // into another's session on a shared browser.
  const userKey=status?.userId||'';
  const connected=!!status?.connected;
  const accounts=status?.accounts||[];
  // A remembered or previously selected mailbox that no longer exists falls back to the
  // combined view rather than leaving the dashboard pointed at nothing.
  const activeAccountId=selectedView===ALL_INBOXES||accounts.some(a=>a.id===selectedView)?selectedView:ALL_INBOXES;
  const activeAccount=accounts.find(a=>a.id===activeAccountId);
  const inFlight=useRef(false);
  // Incrementing this value invalidates callbacks started by an older mailbox lifecycle.
  const generation=useRef(0);
  // Sync ownership is separate from response freshness. A cached reload may supersede
  // what a sync is allowed to paint, but the physical Gmail request still owns the mutex
  // until it settles.
  const syncGeneration=useRef(0);
  // A view chosen while a sync holds the mutex is served from the server's cache. The
  // mailbox itself still needs refreshing, so it is queued here and loaded the moment the
  // running sync frees the mutex, instead of staying stale until the next poll.
  const queuedAccount=useRef<string|null>(null);
  const release=useRef(()=>{});
  const apply=useCallback((data:Snapshot)=>{setEmails(data.emails);setUpdated(data.updated);setAi(data.ai);setHasMore(!!data.hasMore);setSkipped(data.skipped||0);setAccountStates(data.accounts||[]);setBlocked(data.blocked||[]);setDigest(data.digest);},[]);
  const resetToDemo=useCallback(()=>{
    // Invalidate connected-account work first, then replace it with the server's current
    // demo snapshot if that request still belongs to this generation.
    const request=++generation.current;
    // Discard a mailbox selection queued behind the connected sync. Otherwise releasing
    // that old sync could start Gmail work after the app has already entered demo mode.
    queuedAccount.current=null;
    setStatus(previous=>previous?{...previous,connected:false,email:null,accounts:[],defaultAccountId:null,lastSync:null,error:null}:null);
    apply({emails:demoEmails,updated:null,ai:false,hasMore:false});
    void api<Snapshot>('/api/demo').then(data=>{if(generation.current===request)apply(data);}).catch(()=>{});
  },[apply]);
  const refresh=useCallback(async(silent=false)=>{
    // Only one explicit sync may run at a time. Each response checks its generation before
    // changing state, which prevents a late sync from repopulating a disconnected inbox.
    if(inFlight.current)return;
    if(!connected){if(!silent)setNotice('Sample inbox refreshed. Connect Gmail to receive your own email updates.');return;}
    inFlight.current=true;setBusy(true);
    const syncRequest=++syncGeneration.current;
    const request=++generation.current;
    try{
      const data=await api<Snapshot>('/api/sync',activeAccountId===ALL_INBOXES?{explicit:!silent}:{accountId:activeAccountId,explicit:!silent});
      if(generation.current!==request)return;
      apply(data);
      const connection=await api<ConnectionStatus>('/api/connection');
      if(generation.current!==request)return;
      setStatus(connection);setSignInUrl(undefined);
      // The server answers 200 for a partial refresh, listing per-account failures. Saying
      // "up to date" without reading them hides a mailbox that did not refresh at all,
      // and the stale mail still on screen makes that easy to miss.
      const failure=syncFailureMessage(data);
      if(failure)setNotice(failure);
      else if(!silent)setNotice('Your inbox is up to date.');
    }
    catch(error){if(generation.current===request){setNotice(error instanceof Error?error.message:'Could not refresh your inbox.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}}
    finally{if(syncGeneration.current===syncRequest)release.current();}
  },[connected,apply,activeAccountId]);
  useEffect(()=>{
    // Initial boot resolves connection state once. Connected accounts stream cached data
    // followed by a refreshed snapshot; disconnected sessions load the shared demo inbox.
    let active=true;
    let syncRequest=0;
    const request=++generation.current;
    const controller=new AbortController();
    const current=()=>active&&generation.current===request;
    const error=new URLSearchParams(window.location.search).get('connection_error');
    const noticeTimer=error?window.setTimeout(()=>{if(active)setNotice(error);},0):null;
    if(window.location.search)window.history.replaceState(null,'',window.location.pathname);
    void api<ConnectionStatus>('/api/connection',undefined,controller.signal).then(async result=>{
      if(!current())return;setStatus(result);setSignInUrl(undefined);
      if(result.connected){
        // Restore the remembered view when it is still one of this user's accounts,
        // otherwise fall back to their default, then to any remaining mailbox.
        const restored=resolveSelection(
          result.userId?rememberedSelection(result.userId):null,
          result.accounts,
          result.defaultAccountId,
        );
        setSelectedView(restored);
        syncRequest=++syncGeneration.current;
        inFlight.current=true;setBusy(true);
        apply({emails:[],updated:null,ai:false});
        const fresh=await loadConnectedInbox(data=>{if(current())apply(data);},controller.signal,restored===ALL_INBOXES?undefined:restored);
        if(!current())return;
        const partialFailure=syncFailureMessage(fresh);
        if(partialFailure)setNotice(partialFailure);
        const connection=await api<ConnectionStatus>('/api/connection',undefined,controller.signal);
        if(current())setStatus(connection);
      }
      else{const data=await api<Snapshot>('/api/demo',undefined,controller.signal).catch(()=>null);if(current()&&data)apply(data);}
    }).catch(error=>{if(current()){setNotice(error instanceof Error?error.message:'Connection status is unavailable. Please refresh the page to try again.');if(error instanceof ApiError&&error.signInUrl)setSignInUrl(error.signInUrl);}})
      .finally(()=>{if(active&&syncRequest&&syncGeneration.current===syncRequest)release.current();});
    return()=>{active=false;controller.abort();if(noticeTimer!==null)window.clearTimeout(noticeTimer);};
  },[apply]);
  useEffect(()=>{
    // While connected, refresh periodically and after returning to the tab. The lighter
    // mailbox poll picks up scheduler-written snapshots without starting another sync.
    if(!connected)return;
    const syncTimer=window.setInterval(()=>void refresh(true),30*60*1000);
    const pollTimer=window.setInterval(()=>{
      const request=generation.current;
      if(document.visibilityState==='visible'&&!inFlight.current)void api<Snapshot>(activeAccountId===ALL_INBOXES?'/api/mailbox':`/api/mailbox?accountId=${encodeURIComponent(activeAccountId)}`).then(data=>{if(generation.current===request&&!inFlight.current)apply(data);}).catch(()=>{});
    },60000);
    const visible=()=>{if(document.visibilityState==='visible')void refresh(true);};
    document.addEventListener('visibilitychange',visible);
    return()=>{clearInterval(syncTimer);clearInterval(pollTimer);document.removeEventListener('visibilitychange',visible);};
  },[connected,refresh,apply,activeAccountId]);
  /**
   * Switching mailboxes invalidates any in-flight work first, so a slow response for the
   * previous account can never paint over the newly selected one.
   */
  const loadAccount=useCallback((accountId:string|undefined)=>{
    const request=++generation.current;
    inFlight.current=true;setBusy(true);
    const syncRequest=++syncGeneration.current;
    void loadConnectedInbox(data=>{if(generation.current===request)apply(data);},undefined,accountId)
      .then(async fresh=>{
        if(generation.current!==request)return;
        const partialFailure=syncFailureMessage(fresh);
        if(partialFailure)setNotice(partialFailure);
        const connection=await api<ConnectionStatus>('/api/connection');
        if(generation.current===request)setStatus(connection);
      })
      .catch(error=>{if(generation.current===request)setNotice(error instanceof Error?error.message:'Could not load that mailbox.');})
      .finally(()=>{if(syncGeneration.current===syncRequest)release.current();});
  },[apply]);

  useEffect(()=>{
    release.current=()=>{
      inFlight.current=false;setBusy(false);
      const next=queuedAccount.current;
      queuedAccount.current=null;
      // Only the view still selected is worth loading; an older queued choice was already
      // replaced by this one, and the generation check discards anything it started.
      if(next!==null)loadAccount(next===ALL_INBOXES?undefined:next);
    };
  },[loadAccount]);

  const selectAccount=useCallback((view:string)=>{
    const request=++generation.current;
    setSelectedView(view);
    if(userKey)rememberSelection(userKey,view);
    setEmails([]);setUpdated(null);setAi(false);setHasMore(false);setSkipped(0);setAccountStates([]);setBlocked([]);setDigest(undefined);
    const accountId=view===ALL_INBOXES?undefined:view;
    const cached=accountId?`/api/mailbox?accountId=${encodeURIComponent(accountId)}`:'/api/mailbox';
    // If another Gmail request is still running, switch views from the server's cache and
    // leave that request holding the mutex. Starting a second sync would only hit the
    // server lease and show a false failure for an otherwise healthy mailbox.
    if(inFlight.current){
      queuedAccount.current=view;
      void api<Snapshot>(cached).then(data=>{if(generation.current===request)apply(data);})
        .catch(error=>{if(generation.current===request)setNotice(error instanceof Error?error.message:'Could not load that mailbox.');});
      return;
    }
    loadAccount(accountId);
  },[apply,userKey,loadAccount]);

  /**
   * Re-read the mailbox already stored on the server, without contacting Gmail or the
   * model. Used after a correction or sender rule changes what messages mean, so counts,
   * Overview, the brief and the calendar all move together.
   *
   * Starting a new generation discards any poll or sync that began before the change:
   * an older response must never paint the pre-change state back over it. Returns whether
   * the refresh actually landed, so a caller can tell "saved but not refreshed" from
   * "not saved" and offer the right retry.
   */
  const reloadCached=useCallback(async()=>{
    if(!connected)return false;
    // Supersede what the older response may paint, while leaving the sync mutex with the
    // physical Gmail request until that request actually settles.
    const request=++generation.current;
    try{
      const data=await api<Snapshot>(activeAccountId===ALL_INBOXES?'/api/mailbox':`/api/mailbox?accountId=${encodeURIComponent(activeAccountId)}`);
      // The list stays visible throughout; it is replaced only if this is still the newest
      // request and nothing has switched account underneath it.
      if(generation.current!==request)return false;
      apply(data);
      return true;
    }catch{return false;}
  },[connected,activeAccountId,apply]);

  const setDefaultAccount=useCallback(async(accountId:string)=>{
    await api('/api/default-account',{accountId});
    setStatus(await api<ConnectionStatus>('/api/connection'));
  },[]);

  const disconnectAccount=useCallback(async(accountId:string)=>{
    const result=await api<{revoked:boolean;remaining:number;defaultAccountId:string|null}>('/api/disconnect',{accountId});
    const connection=await api<ConnectionStatus>('/api/connection');
    setStatus(connection);
    // With nothing left the app returns to demo mode; otherwise move to a mailbox the
    // user still owns rather than leaving the view pointed at a removed account.
    if(!connection.connected)resetToDemo();
    else if(activeAccountId===accountId)selectAccount(connection.defaultAccountId||ALL_INBOXES);
    return result;
  },[activeAccountId,resetToDemo,selectAccount]);

  return {emails,setEmails,status,setStatus,accounts,accountStates,blocked,activeAccount,activeAccountId,
    setActiveAccountId:selectAccount,
    defaultAccountId:status?.defaultAccountId||null,
    connected,busy,notice,setNotice,signInUrl,updated,ai,hasMore,skipped,digest,refresh,resetToDemo,
    reload:async()=>{await refresh(true)},reloadCached,setDefaultAccount,disconnectAccount};
}
