'use client';
import { useEffect, useRef } from 'react';
import type { Email } from '@/lib/mail';
type MailTool = {name:string;description:string;inputSchema:object;annotations:{readOnlyHint:boolean;untrustedContentHint:boolean};execute:(input:unknown)=>unknown};
type MailContext = {registerTool:(tool:MailTool,options:{signal:AbortSignal})=>void|Promise<void>};
export function useMailTools(emails:Email[],open:(email:Email)=>void,demo:boolean){
  const current=useRef({emails,open,demo});
  useEffect(()=>{current.current={emails,open,demo};},[emails,open,demo]);
  useEffect(()=>{
    const context=(document as Document & {modelContext?:MailContext}).modelContext;
    if(!context?.registerTool)return;
    const lifecycle=new AbortController();
    const register=(tool:MailTool)=>{try{void Promise.resolve(context.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{/* Optional browser capability. */}};
    register({name:'read_inbox_brief',description:'Read the currently visible inbox summaries and priority flags. Returns whether the inbox is demo data.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('Expected an empty object.');return {demo:current.current.demo,emails:current.current.emails.map(({id,sender,subject,summary,category,priority,needsReply})=>({id,sender,subject,summary,category,priority,needsReply}))};}});
    register({name:'open_email_conversation',description:'Open an existing email in the review panel. This only opens the conversation; it does not draft, send, or modify Gmail.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='id')||!('id' in input)||typeof input.id!=='string')throw new Error('A valid email id is required.');const email=current.current.emails.find(m=>m.id===input.id);if(!email)throw new Error('Email not found in this inbox.');current.current.open(email);return {opened:email.id,demo:current.current.demo};}});
    return()=>lifecycle.abort();
  },[]);
}
