'use client';
import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Inbox, Sparkles, Layers3, Settings2, ChevronDown, ArrowUpRight, ArrowRight, RefreshCw, Check, Sun, X } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { emailKey, senderKey, type Email } from '@/lib/mail';
import { useInbox } from '@/hooks/use-inbox';
import { useMailTools } from '@/hooks/use-mail-tools';
import { ReplyComposer } from '@/components/reply-composer';
import { ConnectionPanel } from '@/components/connection-panel';
import { ConnectGmailButton } from '@/components/connect-gmail-button';
import { DailyBrief } from '@/components/daily-brief';
import { AccountSwitcher } from '@/components/account-switcher';
import { ShareInbox } from '@/components/share-inbox';
import { NextEvent } from '@/components/next-event';
import { WeekCalendar } from '@/components/week-calendar';
import { NoiseList } from '@/components/noise-list';
import { PriorityEmailList } from '@/components/priority-email-list';
import { isImportantEmail } from '@/lib/inbox-priority';
import { CategoryNav } from '@/components/category-nav';
import { ClassificationDetail } from '@/components/classification-detail';
import { emailTags, parseView, selectEmails, sectionName, tagName } from '@/lib/categories';
import { useTheme } from '@/hooks/use-theme';
import { ThemePrompt } from '@/components/theme-prompt';

/**
 * Main inbox screen. It combines mailbox state, category filtering, daily highlights,
 * settings, the conversation panel, and reply tools without owning their server logic.
 */
export default function Dashboard() {
  // Navigation and panel state stay local because changing views does not change Gmail.
  const [view,setView]=useState('overview');
  const [filter,setFilter]=useState('all');
  const [selected,setSelected]=useState<Email|null>(null);
  const [connect,setConnect]=useState(false);
  const [briefRead,setBriefRead]=useState(false);
  const {darkMode,setDarkMode,showThemePrompt}=useTheme();
  const inbox=useInbox();
  const {emails,connected,status,busy,notice}=inbox;
  const selectedEmail=selected?emails.find(email=>emailKey(email)===emailKey(selected))||null:null;
  const [date,setDate]=useState('YOUR DAILY OVERVIEW');
  const [greeting,setGreeting]=useState('Welcome back');
  useEffect(()=>{
    // Refresh the greeting at minute boundaries without forcing mailbox data to reload.
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
  // Derive every visible collection from the current snapshot instead of maintaining
  // duplicate lists that could fall out of sync.
  const mail=emails.filter(m=>m.category!=='noise');
  const noise=emails.filter(m=>m.category==='noise');
  const work=mail.filter(m=>m.category==='work');
  const personal=mail.filter(m=>m.category==='personal');
  const attention=work.filter(m=>m.needsReply||m.priority==='high');
  const personalAttention=personal.filter(m=>m.needsReply||m.priority==='high');
  const sources=Array.from(new Map(noise.map(m=>[senderKey(m),m])).values());
  const {section,tag}=parseView(view);
  // Overview spans Work and Personal so urgent personal mail still surfaces here.
  const base=view==='overview'?mail.filter(isImportantEmail):selectEmails(emails,view);
  const viewLabel=view==='overview'?'Overview':view==='inbox'?'Inbox':section?(tag?`${sectionName(section)} · ${tagName(tag)}`:sectionName(section)):'Inbox';
  const viewTitle=view==='overview'?'Important now':view==='inbox'?'Your inbox':tag?tagName(tag):section?`${sectionName(section)} conversations`:'Your inbox';
  const messages=base.filter(m=>filter!=='reply'||m.needsReply);

  useMailTools(emails,setSelected,!connected);
  const lastSync=connected&&inbox.updated?new Date(inbox.updated).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):null;
  const agentActive=connected&&!!status?.schedulerActive;
  function markReplied(){if(selected)inbox.setEmails(previous=>previous.map(m=>emailKey(m)===emailKey(selected)?{...m,needsReply:false}:m));}
  function applyCorrection(updated:Email){
    // Merge one composite message identity into the latest state. A delayed response for
    // another mailbox cannot replace the current inbox, and an older revision cannot
    // roll back a correction already received from a poll or another action.
    inbox.setEmails(previous=>previous.map(current=>{
      if(emailKey(current)!==emailKey(updated))return current;
      if((current.correctionRevision||0)>(updated.correctionRevision||0))return current;
      return {...current,classification:updated.classification,automaticClassificationAvailable:updated.automaticClassificationAvailable,
        correctionRevision:updated.correctionRevision,manuallyCorrected:updated.manuallyCorrected,
        category:updated.category,tags:updated.tags,priority:updated.priority,label:updated.label,needsReply:updated.needsReply};
    }));
  }

  function switchAccount(id:string){inbox.setActiveAccountId(id);setSelected(null);setFilter('all');setBriefRead(false);setView('overview');}

  return <SidebarProvider style={{'--sidebar-width':'238px'} as React.CSSProperties}>
    <Sidebar className="brief-sidebar">
      <SidebarHeader className="brand-block"><Link className="brand" href="/"><span className="brand-icon"><Layers3 size={23}/></span>brief<span className="brand-dot">.</span></Link><span className="brand-caption">Bedrock Systems 2026</span></SidebarHeader>
      <SidebarContent>
        <div className="workspace-label">WORKSPACE</div>
        <CategoryNav emails={emails} view={view} onSelect={setView}/>
        <Link href="/team" className="settings-button" style={{margin:"20px 16px 0"}}><Layers3 size={17}/> Team knowledge <ArrowUpRight size={14}/></Link><div className="sidebar-note"><span className="tiny-spark"><Sparkles size={14}/></span><span>A quieter inbox.<br/><strong>A clearer head.</strong></span></div>
      </SidebarContent>
      <SidebarFooter className="sidebar-bottom"><div className="agent-mini"><span className="agent-orb"><Sparkles size={18}/></span><div><strong>Your inbox agent</strong><span>{agentActive?'Checking every 30 min':connected?'Schedule pending':'Ready when you are'}</span></div><span className={`status-dot ${agentActive?'':'muted'}`}/></div><button className="settings-button" onClick={()=>setConnect(true)}><Settings2 size={17}/>Settings & connections</button><button className="account-button" onClick={()=>setConnect(true)}><span className="avatar gray">A</span><span><strong>{connected?(allInboxes?'All inboxes':inbox.activeAccount?.email?.split('@')[0]):'Your workspace'}</strong><small>{connected?'Gmail connected':'Personal account'}</small></span><ChevronDown size={15}/></button></SidebarFooter>
    </Sidebar>
    <div className="app-main">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-toggle"/><span>Workspace</span><span className="slash">/</span><strong>{viewLabel}</strong></div><div className="topbar-right"><span className="demo-pill">{connected?'Gmail workspace':'Demo workspace'}</span><AccountSwitcher accounts={inbox.accounts} activeAccountId={inbox.activeAccountId} defaultAccountId={inbox.defaultAccountId} onSelect={switchAccount} onSettings={()=>setConnect(true)}/></div></header>
      <main className="dashboard-content">
        <div className="heading-row"><div><div className="eyebrow"><Sun size={14}/> {date}</div><h1>{greeting}<span>.</span></h1>{view==='noise'&&<p>Your subscriptions, neatly in one place.</p>}</div><div className="inbox-primary-actions">{!connected&&<ConnectGmailButton status={status} signInUrl={inbox.signInUrl} onSetup={()=>setConnect(true)}/>}<button className="button white" disabled={busy} onClick={()=>void inbox.refresh()} aria-label="Refresh inbox"><RefreshCw size={15} className={busy?'spinning':''}/>{busy?'Refreshing…':'Refresh inbox'}</button></div></div>
        {notice&&<output className="inbox-notice"><span>{notice}</span>{inbox.signInUrl&&<a className="button white" href={inbox.signInUrl} target="_top">Sign in</a>}<button aria-label="Dismiss notification" onClick={()=>inbox.setNotice('')}><X size={14}/></button></output>}
        {connected&&inbox.skipped>0&&<p className="gmail-connect-hint">{inbox.skipped} {inbox.skipped===1?'message was':'messages were'} unreadable and skipped during the latest refresh.</p>}
        {!connected&&<p className="gmail-connect-hint">You’re viewing sample emails. Connect Gmail to see summaries of your own inbox.</p>}
        <div style={{display:"flex",justifyContent:"flex-end",gap:12,marginBottom:20}}>{connected&&<ShareInbox emails={emails} accountId={inbox.activeAccountId}/>}<Link className="button white" href="/team">Team workspace <ArrowUpRight size={15}/></Link></div><div className="content-columns"><div className="primary-column">
          {(view==='overview')&&<DailyBrief emails={emails} connected={connected} ai={inbox.ai} aiConfigured={!!status?.aiConfigured} busy={busy} updated={inbox.updated} collapsed={briefRead} onCollapse={()=>setBriefRead(!briefRead)} onSelect={setSelected}/>}
          {view==='noise'?<NoiseList emails={noise} demo={!connected} onRemoved={email=>inbox.setEmails(previous=>previous.filter(m=>senderKey(m)!==senderKey(email)))} onSelect={setSelected}/>:<section className={`inbox-section ${view!=='overview'?'standalone-inbox':''}`}><div className="section-title-row"><h2>{viewTitle} <span>{base.length}</span></h2></div><div className="inbox-toolbar"><Tabs value={filter} onValueChange={v=>setFilter(String(v))}><TabsList><TabsTrigger value="all">All mail</TabsTrigger><TabsTrigger value="reply">Needs a reply <span className="tab-count">{base.filter(m=>m.needsReply).length}</span></TabsTrigger></TabsList></Tabs><span className="sort-label">Newest first <ChevronDown size={13}/></span></div><PriorityEmailList emails={messages} busy={busy} emptyTitle="All clear." emptyBody={filter==='reply'?'No conversations need a reply right now.':'New conversations will appear after your next refresh.'} onSelect={setSelected}/><div className="inbox-end"><Check size={14}/> {inbox.hasMore?'Scanning older Gmail messages in the background.':'Mailbox scan complete.'}</div></section>}
        </div><aside className="secondary-column"><WeekCalendar emails={emails} demo={!connected} onSelect={setSelected}/><div className="stats-grid"><div className="stat"><span><Inbox/>In your inbox</span><div>{emails.length}<small>new emails</small></div></div><div className="stat"><span><span className="small-dot blue-dot"/>Important</span><div className="attention-counts"><div>{attention.length}<small>work { attention.length === 1 ? 'conversation' : 'conversations' }</small></div><div>{personalAttention.length}<small>personal { personalAttention.length === 1 ? 'conversation' : 'conversations' }</small></div></div></div><NextEvent emails={emails} demo={!connected} onSelect={setSelected}/></div><section className="noise-card"><div className="aside-title"><h2><Layers3 size={18}/> Quiet corner</h2><span className="soft-count">{noise.length}</span></div><p>Newsletters and promotions,<br/>neatly out of your way.</p><div className="noise-stack">{sources.slice(0,4).map(m=><span key={senderKey(m)} className={`mini-logo ${m.color}`}>{m.initials.toLowerCase()}</span>)}<span className="senders-label">{sources.length} senders</span></div><div className="noise-rule"/><button className="text-button" onClick={()=>setView('noise')}>Review & unsubscribe <ArrowRight size={15}/></button></section><div className="calm-note"><span className="calm-line"/><Sparkles size={15}/><span className="calm-line"/><p>A clear inbox is a fresh start.</p></div></aside></div>
        <footer className="page-footer"><span><span className="small-dot"/> {connected?(lastSync?`Last synced ${lastSync} · Refreshes every 30 minutes while open`:'Gmail connected · Preparing your first brief'):'Sample emails · Connect Gmail to make it yours'}</span><span>Made for a little more headspace.</span></footer>
      </main>
    </div>
    <ConnectionPanel signInUrl={inbox.signInUrl} open={connect} onOpenChange={setConnect} status={status} darkMode={darkMode} onDarkModeChange={setDarkMode} defaultAccountId={inbox.defaultAccountId} onSetDefault={inbox.setDefaultAccount} onDisconnectAccount={async id=>{await inbox.disconnectAccount(id);setSelected(null);}} onDisconnect={()=>{inbox.resetToDemo();setSelected(null);}}/>
    <ThemePrompt open={showThemePrompt} onChoose={setDarkMode}/>
    <Sheet open={!!selectedEmail} onOpenChange={o=>!o&&setSelected(null)}><SheetContent className="email-sheet"><SheetHeader><span className="eyebrow">CONVERSATION</span><SheetTitle>{selectedEmail?.subject}</SheetTitle><SheetDescription>{selectedEmail?.sender} · {selectedEmail?.address}{selectedEmail?.accountEmail&&<> · To {selectedEmail.accountEmail}</>}</SheetDescription>{selectedEmail&&<div className="conversation-tags"><span className="mail-label section">{sectionName(selectedEmail.category)}</span>{emailTags(selectedEmail).filter(t=>t!=='junk').map(t=><span key={t} className="mail-label">{tagName(t)}</span>)}</div>}</SheetHeader><div className="message-body">{selectedEmail?.body}</div>{selectedEmail&&<ClassificationDetail email={selectedEmail} demo={!connected} onApplied={applyCorrection}/>} {selectedEmail?.quoted&&<details className="quoted-history"><summary>Quoted history</summary><div className="message-body">{selectedEmail.quoted}</div></details>}{selectedEmail&&<ReplyComposer key={selectedEmail?emailKey(selectedEmail):'none'} email={selectedEmail!} demo={!connected} aiReady={!!status?.aiConfigured} onSent={markReplied}/>}</SheetContent></Sheet>
  </SidebarProvider>;
}
