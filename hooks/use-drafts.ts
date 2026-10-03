'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/inbox-client';
import type { DraftItem } from '@/server/drafts';

export type DraftsState={count:number;items:DraftItem[];failures:{accountId:string;email:string;error:string}[];loading:boolean;error:string;loaded:boolean};

/**
 * The Gmail Drafts folder for the current account scope (one mailbox, or "all"). It loads
 * once connected, again when the scope changes, and whenever `reload` is called — after
 * Compose closes, for example, since saving or sending changes the folder. A newer load
 * always wins over an older one still in flight.
 */
export function useDrafts(accountId:string,connected:boolean,expanded=true){
  const scope=JSON.stringify([accountId,connected,expanded]);
  const empty:DraftsState={count:0,items:[],failures:[],loading:false,error:'',loaded:false};
  const [record,setState]=useState<DraftsState&{scope:string}>({...empty,scope});
  const state=record.scope===scope?record:empty;
  const generation=useRef(0);
  const reload=useCallback(async()=>{
    const mine=++generation.current;
    if(!connected){setState({scope,count:0,items:[],failures:[],loading:false,error:'',loaded:false});return;}
    setState(previous=>({...previous,scope,...(previous.scope===scope?{}:{items:[],count:0,failures:[],loaded:false}),loading:true,error:''}));
    try{
      // The combined view names no account, like the mailbox request; the server reads them all.
      const params=new URLSearchParams();
      if(accountId&&accountId!=='all')params.set('accountId',accountId);
      if(!expanded)params.set('countOnly','true');
      const result=await api<{items:DraftItem[];failures:DraftsState['failures'];count?:number}>(`/api/drafts${params.size?'?'+params:''}`);
      if(mine===generation.current)setState({scope,count:result.count??result.items.length,items:result.items,failures:result.failures,loading:false,error:'',loaded:true});
    }catch(failure){
      if(mine===generation.current)setState(previous=>({...previous,loading:false,loaded:true,error:failure instanceof Error?failure.message:'Drafts could not be loaded. Try again.'}));
    }
  },[accountId,connected,expanded,scope]);
  const invalidate=useCallback(()=>{generation.current++;},[]);
  useEffect(()=>{const timer=window.setTimeout(()=>{void reload();},0);return()=>{window.clearTimeout(timer);invalidate();};},[reload,invalidate]);
  const remove=useCallback(async(draft:DraftItem)=>{
    await api('/api/drafts',{action:'delete',accountId:draft.accountId,id:draft.id});
    setState(previous=>{
      if(previous.scope!==scope||!previous.items.some(item=>item.id===draft.id&&item.accountId===draft.accountId))return previous;
      return {...previous,count:Math.max(0,previous.count-1),items:previous.items.filter(item=>!(item.id===draft.id&&item.accountId===draft.accountId))};
    });
  },[scope]);
  return {...state,reload,remove};
}
