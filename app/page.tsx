'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Inbox, Sparkles, BriefcaseBusiness, Layers3, Settings2, ChevronDown, ArrowUpRight, ArrowRight, RefreshCw, Check, Clock3, ShieldCheck, Mail, Sun, X, ListChecks } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import type { Email } from '@/lib/mail';
import { useInbox } from '@/hooks/use-inbox';
import { useMailTools } from '@/hooks/use-mail-tools';
import { ReplyComposer } from '@/components/reply-composer';
import { ConnectionPanel } from '@/components/connection-panel';
import { NoiseList } from '@/components/noise-list';
import { InboxDigest } from '@/components/inbox-digest';
import { PriorityEmailList } from '@/components/priority-email-list';
import { isImportantEmail, sortInboxEmails } from '@/lib/inbox-priority';

export default function Dashboard() {
  const [view,setView]=useState('Overview');
  const [filter,setFilter]=useState('all');
  const [selected,setSelected]=useState<Email|null>(null);
  const [connect,setConnect]=useState(false);
  const [digest,setDigest]=useState(false);
  const [briefRead,setBriefRead]=useState(false);
  const inbox=useInbox();
  const {emails,connected,status,busy,notice}=inbox;
  const [date,setDate]=useState('YOUR DAILY OVERVIEW');
  useEffect(()=>{const timer=window.setTimeout(()=>setDate(new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase()),0);return()=>window.clearTimeout(timer);},[]);
  const mail=sortInboxEmails(emails.filter(m=>m.category!=='noise'));
  const noise=emails.filter(m=>m.category==='noise');
  const work=mail.filter(m=>m.category==='work');
  const attention=mail.filter(isImportantEmail);
  const sources=Array.from(new Map(noise.map(m=>[m.address,m])).values());
  const base=view==='Overview'?attention:view==='Work'?work:mail;
  const messages=base.filter(m=>filter!=='reply'||m.needsReply);
  const highlights=attention.slice(0,3);
  useMailTools(emails,setSelected,!connected);
  const lastSync=connected&&inbox.updated?new Date(inbox.updated).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):null;
  const agentActive=connected&&!!status?.schedulerActive;
  function markReplied(){if(selected)inbox.setEmails(previous=>previous.map(m=>m.id===selected.id?{...m,needsReply:false,unread:false}:m));}

  return <SidebarProvider style={{'--sidebar-width':'238px'} as React.CSSProperties}>
    <Sidebar className="brief-sidebar">
      <SidebarHeader className="brand-block"><Link className="brand" href="/"><span className="brand-icon"><Layers3 size={23}/></span>brief<span className="brand-dot">.</span></Link><span className="brand-caption">Bedrock Systems 2026</span></SidebarHeader>
      <SidebarContent>
        <div className="workspace-label">WORKSPACE</div>
        <SidebarMenu className="main-navigation">{[{name:'Overview',icon:Sparkles,count:null},{name:'Inbox',icon:Inbox,count:mail.length},{name:'Work',icon:BriefcaseBusiness,count:work.length},{name:'Noise',icon:Layers3,count:noise.length}].map(item=><SidebarMenuItem key={item.name}><SidebarMenuButton isActive={view===item.name} onClick={()=>setView(item.name)} className="nav-button"><item.icon size={18}/><span>{item.name}</span>{item.count!==null&&<span className="nav-count">{item.count}</span>}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
        <div className="sidebar-note"><span className="tiny-spark"><Sparkles size={14}/></span><span>A quieter inbox.<br/><strong>A clearer head.</strong></span></div>
      </SidebarContent>
      <SidebarFooter className="sidebar-bottom"><div className="agent-mini"><span className="agent-orb"><Sparkles size={18}/></span><div><strong>Your inbox agent</strong><span>{agentActive?'Checking every 30 min':connected?'Schedule pending':'Ready when you are'}</span></div><span className={`status-dot ${agentActive?'':'muted'}`}/></div><button className="settings-button" onClick={()=>setConnect(true)}><Settings2 size={17}/>Settings & connections</button><button className="account-button" onClick={()=>setConnect(true)}><span className="avatar gray">A</span><span><strong>{connected?status?.email?.split('@')[0]:'Your workspace'}</strong><small>{connected?'Gmail connected':'Personal account'}</small></span><ChevronDown size={15}/></button></SidebarFooter>
    </Sidebar>
    <div className="app-main">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-toggle"/><span>Workspace</span><span className="slash">/</span><strong>{view}</strong></div><div className="topbar-right"><span className="demo-pill">{connected?'Gmail workspace':'Demo workspace'}</span><button className="connect-button" onClick={()=>setConnect(true)}><Mail size={15}/> {connected?'Connected':'Connect Gmail'} <ArrowUpRight size={14}/></button></div></header>
      <main className="dashboard-content">
        <div className="heading-row"><div><div className="eyebrow"><Sun size={14}/> {date}</div><h1>{view==='Noise'?'A little less noise':view==='Work'?'Room for what matters':'Your inbox, in focus'}<span>.</span></h1><p>{view==='Noise'?'Your subscriptions, neatly in one place.':'Less catching up. More moving forward.'}</p></div><div className="heading-actions"><button className="button white" onClick={()=>setDigest(true)} aria-label="Summarize inbox"><ListChecks size={15}/>Summarize inbox</button><button className="button white" disabled={busy} onClick={()=>void inbox.refresh()} aria-label="Refresh inbox"><RefreshCw size={15} className={busy?'spinning':''}/>{busy?'Refreshing…':'Refresh inbox'}</button></div></div>
        <div className="stats-grid"><div className="stat"><span><Inbox/>In your inbox</span><div>{emails.length}<small>{inbox.hasMore?'most recent emails':'emails to catch up on'}</small></div></div><div className="stat"><span><span className="small-dot blue-dot"/>Needs attention</span><div>{attention.length}<small>important conversations</small></div></div><div className="stat"><span><Layers3/>Noise, sorted</span><div>{noise.length}<small>emails kept out of your way</small></div></div><div className="stat"><span><Clock3/>Time back</span><div>~{Math.round(emails.length*.85)}<small>minutes of reading saved</small></div></div></div>
        {notice&&<div className="inbox-notice" aria-live="polite"><span>{notice}</span>{inbox.signInUrl&&<Link className="button white" href={inbox.signInUrl} target="_top">Sign in</Link>}<button aria-label="Dismiss notification" onClick={()=>inbox.setNotice('')}><X size={14}/></button></div>}
        <div className="content-columns"><div className="primary-column">
          {view==='Overview'&&<section className={`briefing-card ${briefRead?'briefing-collapsed':''}`}><div className="card-heading"><span className="section-icon"><Sparkles size={18}/></span><h2>Your daily brief</h2><span className="ai-label">{inbox.ai?'AI SUMMARY':'INBOX HIGHLIGHTS'}</span><span className="brief-time">{lastSync?'Updated '+lastSync:'Just for you'}</span></div>{!briefRead&&<><p className="brief-intro">{!inbox.ai?(status?.aiConfigured?'The AI summary is unavailable right now. Important mail is still ranked below.':'Connect the AI service for richer summaries. Important mail is still ranked below.'):highlights.length?`${attention.length} important conversation${attention.length===1?'':'s'} could use your attention.`:'You’re all caught up on important mail.'}</p><div className="brief-points">{highlights.map(m=><button key={m.id} onClick={()=>setSelected(m)}><span className="point-dot urgent"/><p><strong>{m.subject}.</strong> {m.summary}</p><ArrowUpRight size={16}/></button>)}</div></>}<div className="brief-footer"><span><ShieldCheck size={14}/> {briefRead?'You’re all caught up on the highlights.':'Only important mail makes the overview.'}</span><button onClick={()=>setBriefRead(!briefRead)}>{briefRead?'Show summary':'I’m caught up'}<Check size={15}/></button></div></section>}
          {view==='Noise'?<NoiseList emails={noise} demo={!connected} onRemoved={address=>inbox.setEmails(previous=>previous.filter(m=>m.address!==address))} onSelect={setSelected}/>:<section className={`inbox-section ${view!=='Overview'?'standalone-inbox':''}`}><div className="section-title-row"><h2>{view==='Overview'?'Important now':view==='Work'?'Work conversations':'Your inbox'} <span>{base.length}</span></h2><span className="secondary-label">Replies first</span></div><div className="inbox-toolbar"><Tabs value={filter} onValueChange={v=>setFilter(String(v))}><TabsList><TabsTrigger value="all">{view==='Overview'?'Important':'All mail'}</TabsTrigger><TabsTrigger value="reply">Needs a reply <span className="tab-count">{base.filter(m=>m.needsReply).length}</span></TabsTrigger></TabsList></Tabs><span className="sort-label">Priority order <ChevronDown size={13}/></span></div><PriorityEmailList emails={messages} busy={busy} emptyTitle={view==='Overview'?'Nothing important right now.':'All clear.'} emptyBody={filter==='reply'?'No conversations need a reply right now.':view==='Overview'?'Routine mail stays in Inbox, out of your overview.':'New conversations will appear after your next refresh.'} onSelect={setSelected}/><div className="inbox-end"><Check size={14}/> {view==='Overview'?'Only important messages appear here. Routine mail stays in Inbox.':inbox.hasMore?'Showing your 60 most recent inbox emails.':'Replies and important mail are ranked first.'}</div></section>}
        </div><aside className="secondary-column"><section className="agent-card"><div className="aside-title"><span className="agent-orb large"><Sparkles size={21}/></span><span className={`pill ${agentActive?'':'neutral'}`}>{agentActive?'AGENT ACTIVE':'SETUP NEEDED'}</span></div><h2>A little help,<br/>in the background.</h2><p>Your agent checks Gmail, finds what matters, and keeps your brief up to date.</p><div className="agent-schedule"><Clock3 size={16}/><span>Every 30 minutes</span></div><button className="button blue full" onClick={()=>setConnect(true)}>{connected?'Manage your agent':'Connect your Gmail'} <ArrowRight size={15}/></button><span className="private-note"><ShieldCheck size={12}/> Your inbox stays yours.</span></section><section className="noise-card"><div className="aside-title"><h2><Layers3 size={18}/> Quiet corner</h2><span className="soft-count">{noise.length}</span></div><p>Newsletters and promotions,<br/>neatly out of your way.</p><div className="noise-stack">{sources.slice(0,4).map(m=><span key={m.address} className={`mini-logo ${m.color}`}>{m.initials.toLowerCase()}</span>)}<span className="senders-label">{sources.length} senders</span></div><div className="noise-rule"/><button className="text-button" onClick={()=>setView('Noise')}>Review & unsubscribe <ArrowRight size={15}/></button></section><div className="calm-note"><span className="calm-line"/><Sparkles size={15}/><span className="calm-line"/><p>A clear inbox is a fresh start.</p></div></aside></div>
        <footer className="page-footer"><span><span className="small-dot"/> {connected?(lastSync?`Last synced ${lastSync} · Refreshes every 30 minutes while open`:'Gmail connected · Preparing your first brief'):'Sample emails · Connect Gmail to make it yours'}</span><span>Made for a little more headspace.</span></footer>
      </main>
    </div>
    <ConnectionPanel signInUrl={inbox.signInUrl} open={connect} onOpenChange={setConnect} status={status} onDisconnect={()=>{inbox.setStatus(previous=>previous?{...previous,connected:false,email:null}:null);inbox.resetToDemo();inbox.setNotice('Gmail disconnected. You’re now viewing the sample inbox.');}}/>
    <InboxDigest open={digest} onOpenChange={setDigest} emails={emails} ai={inbox.ai} connected={connected} onSelect={setSelected}/>
    <Sheet open={!!selected} onOpenChange={o=>!o&&setSelected(null)}><SheetContent className="email-sheet"><SheetHeader><span className="eyebrow">CONVERSATION</span><SheetTitle>{selected?.subject}</SheetTitle><SheetDescription>{selected?.sender} · {selected?.address}</SheetDescription></SheetHeader><div className="message-body">{selected?.body}</div>{selected&&<ReplyComposer key={selected?.id||'none'} email={selected!} demo={!connected} aiReady={!!status?.aiConfigured} onSent={markReplied}/>}</SheetContent></Sheet>
  </SidebarProvider>;
}
