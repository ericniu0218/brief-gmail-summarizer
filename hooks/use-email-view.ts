'use client';
import { useCallback, useEffect, useState } from 'react';
import type { EmailView } from '@/components/email-body';

/** Like appearance settings, the default reader view is remembered in this browser. */
export function useEmailView(user:string){
  const key=`brief:default-email-view:${user||'demo'}`;
  const [defaultEmailView,setView]=useState<EmailView>('reading');
  useEffect(()=>{
    let stored:EmailView='reading';
    try{if(localStorage.getItem(key)==='original')stored='original';}catch{/* Browser storage is optional. */}
    const timer=window.setTimeout(()=>setView(stored),0);
    return()=>window.clearTimeout(timer);
  },[key]);
  const setDefaultEmailView=useCallback((view:EmailView)=>{
    setView(view);
    try{localStorage.setItem(key,view);}catch{/* The preference still applies during this visit. */}
  },[key]);
  return {defaultEmailView,setDefaultEmailView};
}
