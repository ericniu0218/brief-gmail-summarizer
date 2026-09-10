'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Inbox, Sparkles, BriefcaseBusiness, UserRound, Layers3, Settings2, ChevronDown, ArrowUpRight, ArrowRight, RefreshCw, Check, ShieldCheck, Sun, X } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { demoEmails, emailKey, senderKey, type Email } from '@/lib/mail';
import { useInbox } from '@/hooks/use-inbox';
import { useMailTools } from '@/hooks/use-mail-tools';
import { ReplyComposer } from '@/components/reply-composer';
import { ConnectionPanel } from '@/components/connection-panel';
import { AccountSwitcher } from '@/components/account-switcher';
import { NextEvent } from '@/components/next-event';
import { WeekCalendar } from '@/components/week-calendar';
import { NoiseList } from '@/components/noise-list';
import { PriorityEmailList } from '@/components/priority-email-list';
import { isImportantEmail } from '@/lib/inbox-priority';

export default function Dashboard() {
  const [view,setView]=useState('Overview');
  const [filter,setFilter]=useState('all');
  const [selected,setSelected]=useState<Email|null>(null);
  const [connect,setConnect]=useState(false);
  const [briefRead,setBriefRead]=useState(false);
  const inbox=useInbox();
  const {emails,connected,status,busy,notice}=inbox;
  const selectedEmail=selected?emails.find(email=>emailKey(email)===emailKey(selected))||null:null;
  const [date,setDate]=useState('YOUR DAILY OVERVIEW');
  const [greeting,setGreeting]=useState('Welcome back');
  useEffect(()=>{
    const update=()=>{
      const now=new Date();
      setDate(now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase());
      const hour=now.getHours();
      setGreeting(hour>=5&&hour<12?'Good morning, let’s start fresh':hour>=12&&hour<18?'Good afternoon, take a breather':'Good evening, time to unwind');
    };
    const initial=window.setTimeout(update,0);
    const timer=window.setInterval(update,60000);
    return()=>{window.clearTimeout(initial);window.clearInterval(timer);};
  },[]);
  const allInboxes=inbox.activeAccountId==='all';
  const mail=emails.filter(m=>m.category!=='noise');
  const noise=emails.filter(m=>m.category==='noise');
  const work=mail.filter(m=>m.category==='work');
  const personal=mail.filter(m=>m.category==='personal');
  const attention=work.filter(m=>m.needsReply||m.priority==='high');
  const personalAttention=personal.filter(m=>m.needsReply||m.priority==='high');
  const sources=Array.from(new Map(noise.map(m=>[senderKey(m),m])).values());
  const base=view==='All inboxes'?emails:view==='Work'?work:view==='Personal'?personal:view==='Overview'?mail.filter(isImportantEmail):mail;
  const messages=base.filter(m=>filter!=='reply'||m.needsReply);
  const highlights=[...attention].sort((a,b)=>Number(b.priority==='high')-Number(a.priority==='high')).slice(0,3);
  useMailTools(emails,setSelected,!connected);
  const lastSync=connected&&inbox.updated?new Date(inbox.updated).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):null;
  const agentActive=connected&&!!status?.schedulerActive;
  function markReplied(){if(selected)inbox.setEmails(previous=>previous.map(m=>emailKey(m)===emailKey(selected)?{...m,needsReply:false}:m));}

  function switchAccount(id:string){inbox.setActiveAccountId(id);setSelected(null);setFilter('all');setBriefRead(false);setView(id==='all'?'All inboxes':'Overview');}

  return <SidebarProvider style={{'--sidebar-width':'238px'} as React.CSSProperties}>
    <Sidebar className="brief-sidebar">
      <SidebarHeader className="brand-block"><Link className="brand" href="/"><span className="brand-icon"><Layers3 size={23}/></span>brief<span className="brand-dot">.</span></Link><span className="brand-caption">Bedrock Systems 2026</span></SidebarHeader>
      <SidebarContent>
        <div className="workspace-label">WORKSPACE</div>
        <SidebarMenu className="main-navigation">{[{name:'Overview',icon:Sparkles,count:null},{name:'Inbox',icon:Inbox,count:mail.length},{name:'Work',icon:BriefcaseBusiness,count:work.length},{name:'Personal',icon:UserRound,count:personal.length},{name:'Noise',icon:Layers3,count:noise.length}].map(item=><SidebarMenuItem key={item.name}><SidebarMenuButton isActive={view===item.name||(view==='All inboxes'&&item.name==='Overview')} onClick={()=>setView(item.name==='Overview'&&allInboxes?'All inboxes':item.name)} className="nav-button"><item.icon size={18}/><span>{item.name}</span>{item.count!==null&&<span className="nav-count">{item.count}</span>}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
        <div className="sidebar-note"><span className="tiny-spark"><Sparkles size={14}/></span><span>A quieter inbox.<br/><strong>A clearer head.</strong></span></div>
      </SidebarContent>
      <SidebarFooter className="sidebar-bottom"><div className="agent-mini"><span className="agent-orb"><Sparkles size={18}/></span><div><strong>Your inbox agent</strong><span>{agentActive?'Checking every 30 min':connected?'Schedule pending':'Ready when you are'}</span></div><span className={`status-dot ${agentActive?'':'muted'}`}/></div><button className="settings-button" onClick={()=>setConnect(true)}><Settings2 size={17}/>Settings & connections</button><button className="account-button" onClick={()=>setConnect(true)}><span className="avatar gray">A</span><span><strong>{connected?(allInboxes?'All inboxes':inbox.activeAccount?.email?.split('@')[0]):'Your workspace'}</strong><small>{connected?'Gmail connected':'Personal account'}</small></span><ChevronDown size={15}/></button></SidebarFooter>
    </Sidebar>
    <div className="app-main">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-toggle"/><span>Workspace</span><span className="slash">/</span><strong>{view}</strong></div><div className="topbar-right"><span className="demo-pill">{connected?'Gmail workspace':'Demo workspace'}</span><AccountSwitcher accounts={inbox.accounts} activeAccountId={inbox.activeAccountId} onSelect={switchAccount} onSettings={()=>setConnect(true)}/></div></header>
      <main className="dashboard-content">
        <div className="heading-row"><div><div className="eyebrow"><Sun size={14}/> {date}</div><h1>{greeting}<span>.</span></h1>{view==='Noise'&&<p>Your subscriptions, neatly in one place.</p>}</div><button className="button white" disabled={busy} onClick={()=>void inbox.refresh()} aria-label="Refresh inbox"><RefreshCw size={15} className={busy?'spinning':''}/>{busy?'Refreshing…':'Refresh inbox'}</button></div>
        {notice&&<output className="inbox-notice"><span>{notice}</span>{inbox.signInUrl&&<a className="button white" href={inbox.signInUrl} target="_top">Sign in</a>}<button aria-label="Dismiss notification" onClick={()=>inbox.setNotice('')}><X size={14}/></button></output>}
        <div className="content-columns"><div className="primary-column">
          {(view==='Overview'||view==='All inboxes')&&<section className={`briefing-card ${briefRead?'briefing-collapsed':''}`}><div className="card-heading"><span className="section-icon"><Sparkles size={18}/></span><h2>Your daily brief</h2><span className="ai-label">{connected?(inbox.ai?'AI SUMMARY':'INBOX HIGHLIGHTS'):'SAMPLE BRIEF'}</span><span className="brief-time">{lastSync?'Updated '+lastSync:'Just for you'}</span></div>{!briefRead&&<><p className="brief-intro">{connected?(!inbox.ai?(status?.aiConfigured?'Showing your latest mail while AI summaries are unavailable.':'Connect the AI service to highlight the work that needs you.'):attention.length?`${attention.length} work conversations could use your attention.`:'You’re all caught up on urgent work.'):'A few things need you. Everything else can wait.'}</p><div className="brief-points">{connected?highlights.map(m=><button key={emailKey(m)} onClick={()=>setSelected(m)}><span className={`point-dot ${m.priority==='high'?'urgent':''}`}/><p><strong>{m.subject}.</strong> {m.summary}</p><ArrowUpRight size={16}/></button>):<><button onClick={()=>setSelected(demoEmails[0])}><span className="point-dot urgent"/><p><strong>The website launch is ready for your sign-off.</strong> Sarah needs your approval by <b>2 PM today</b> to keep Thursday’s launch on track.</p><ArrowUpRight size={16}/></button><button onClick={()=>setSelected(demoEmails[1])}><span className="point-dot"/><p><strong>Two budget items need a second look.</strong> James has shared the revised Q3 budget ahead of tomorrow’s review.</p><ArrowUpRight size={16}/></button><button onClick={()=>setSelected(demoEmails[2])}><span className="point-dot"/><p><strong>A quick yes or no for Emily.</strong> She’s checking if Thursday at 10 AM works for a project catch-up.</p><ArrowUpRight size={16}/></button></>}</div></>}<div className="brief-footer"><span><ShieldCheck size={14}/> {briefRead?'You’re all caught up on the highlights.':'The important bits, without the inbox dive.'}</span><button onClick={()=>setBriefRead(!briefRead)}>{briefRead?'Show summary':'I’m caught up'}<Check size={15}/></button></div></section>}
          {view==='Noise'?<NoiseList emails={noise} demo={!connected} onRemoved={email=>inbox.setEmails(previous=>previous.filter(m=>senderKey(m)!==senderKey(email)))} onSelect={setSelected}/>:<section className={`inbox-section ${view!=='Overview'&&view!=='All inboxes'?'standalone-inbox':''}`}><div className="section-title-row"><h2>{view==='All inboxes'?'All inboxes':view==='Work'?'Work conversations':view==='Personal'?'Personal conversations':view==='Overview'?'Important now':'Your inbox'} <span>{base.length}</span></h2></div><div className="inbox-toolbar"><Tabs value={filter} onValueChange={v=>setFilter(String(v))}><TabsList><TabsTrigger value="all">All mail</TabsTrigger><TabsTrigger value="reply">Needs a reply <span className="tab-count">{base.filter(m=>m.needsReply).length}</span></TabsTrigger></TabsList></Tabs><span className="sort-label">Newest first <ChevronDown size={13}/></span></div><PriorityEmailList emails={messages} busy={busy} emptyTitle="All clear." emptyBody={filter==='reply'?'No conversations need a reply right now.':'New conversations will appear after your next refresh.'} onSelect={setSelected}/><div className="inbox-end"><Check size={14}/> {inbox.hasMore?(allInboxes?'Showing up to 60 recent inbox emails per account.':'Showing your 60 most recent inbox emails.'):'You’re seeing what matters. A little more headspace.'}</div></section>}
        </div><aside className="secondary-column"><WeekCalendar emails={emails} demo={!connected} onSelect={setSelected}/><div className="stats-grid"><div className="stat"><span><Inbox/>In your inbox</span><div>{emails.length}<small>new emails</small></div></div><div className="stat"><span><span className="small-dot blue-dot"/>Important</span><div className="attention-counts"><div>{attention.length}<small>work { attention.length === 1 ? 'conversation' : 'conversations' }</small></div><div>{personalAttention.length}<small>personal { personalAttention.length === 1 ? 'conversation' : 'conversations' }</small></div></div></div><NextEvent emails={emails} demo={!connected} onSelect={setSelected}/></div><section className="noise-card"><div className="aside-title"><h2><Layers3 size={18}/> Quiet corner</h2><span className="soft-count">{noise.length}</span></div><p>Newsletters and promotions,<br/>neatly out of your way.</p><div className="noise-stack">{sources.slice(0,4).map(m=><span key={senderKey(m)} className={`mini-logo ${m.color}`}>{m.initials.toLowerCase()}</span>)}<span className="senders-label">{sources.length} senders</span></div><div className="noise-rule"/><button className="text-button" onClick={()=>setView('Noise')}>Review & unsubscribe <ArrowRight size={15}/></button></section><div className="calm-note"><span className="calm-line"/><Sparkles size={15}/><span className="calm-line"/><p>A clear inbox is a fresh start.</p></div></aside></div>
        <footer className="page-footer"><span><span className="small-dot"/> {connected?(lastSync?`Last synced ${lastSync} · Refreshes every 30 minutes while open`:'Gmail connected · Preparing your first brief'):'Sample emails · Connect Gmail to make it yours'}</span><span>Made for a little more headspace.</span></footer>
      </main>
    </div>
    <ConnectionPanel signInUrl={inbox.signInUrl} open={connect} onOpenChange={setConnect} status={status} onDisconnect={()=>{inbox.resetToDemo();setSelected(null);}}/>
    <Sheet open={!!selectedEmail} onOpenChange={o=>!o&&setSelected(null)}><SheetContent className="email-sheet"><SheetHeader><span className="eyebrow">CONVERSATION</span><SheetTitle>{selectedEmail?.subject}</SheetTitle><SheetDescription>{selectedEmail?.sender} · {selectedEmail?.address}{selectedEmail?.accountEmail&&<> · To {selectedEmail.accountEmail}</>}</SheetDescription></SheetHeader><div className="message-body">{selectedEmail?.body}</div>{selectedEmail&&<ReplyComposer key={selectedEmail?emailKey(selectedEmail):'none'} email={selectedEmail!} demo={!connected} aiReady={!!status?.aiConfigured} onSent={markReplied}/>}</SheetContent></Sheet>
  </SidebarProvider>;
}
