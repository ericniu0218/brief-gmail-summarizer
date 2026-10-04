'use client';
import Link from 'next/link';
import { useState, useEffect, useMemo, useRef } from 'react';
import { Inbox, Sparkles, Layers3, Settings2, ChevronDown, ArrowUpRight, ArrowRight, RefreshCw, Check, Sun, X, SquarePen, Forward } from 'lucide-react';
import { SidebarProvider, Sidebar, SidebarHeader, SidebarContent, SidebarFooter, SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { emailKey, gmailLink, senderKey, type Email } from '@/lib/mail';
import { api, useInbox, type ConnectionStatus } from '@/hooks/use-inbox';
import { useFoldPreferences } from '@/hooks/use-fold-preferences';
import { useDoneMail } from '@/hooks/use-done-mail';
import { useDrafts } from '@/hooks/use-drafts';
import { DraftsView } from '@/components/drafts-view';
import type { DraftItem } from '@/server/drafts';
import { preferenceFor } from '@/lib/folding';
import { syncFailureMessage, type InboxSnapshot } from '@/lib/inbox-client';
import { useMailTools } from '@/hooks/use-mail-tools';
import { ReplyComposer } from '@/components/reply-composer';
import { ConnectionPanel } from '@/components/connection-panel';
import { ConnectGmailButton } from '@/components/connect-gmail-button';
import { DailyBrief } from '@/components/daily-brief';
import { MyTasksStrip } from '@/components/my-tasks-strip';
import { ComposeDialog, emptyCompose, type ComposeFields } from '@/components/compose-dialog';
import { ScheduledEmails } from '@/components/scheduled-emails';
import type { Contact } from '@/components/recipient-field';
import { signatureBlock } from '@/lib/signature';
import { AccountSwitcher } from '@/components/account-switcher';
import { NextEvent } from '@/components/next-event';
import { WeekCalendar } from '@/components/week-calendar';
import { NoiseList } from '@/components/noise-list';
import { PriorityEmailList } from '@/components/priority-email-list';
import { isImportantEmail } from '@/lib/inbox-priority';

import { CategoryNav } from '@/components/category-nav';
import { ClassificationDetail } from '@/components/classification-detail';
import { SenderJunkButton } from '@/components/sender-junk-button';
import { AddToTeamTask } from '@/components/email-task-dialog';
import { emailTags, parseView, selectEmails, sectionName, tagName } from '@/lib/categories';
import { useEmailView } from '@/hooks/use-email-view';
import { useTheme } from '@/hooks/use-theme';
import { ThemePrompt } from '@/components/theme-prompt';
import { searchMail } from '@/lib/mail-search';
import { HeaderMailSearch, MailSearchResults } from '@/components/mail-search';
import { receivedLabel } from '@/lib/email-time';
import { EmailBody } from '@/components/email-body';

/**
 * Main inbox screen. It combines mailbox state, category filtering, daily highlights,
 * settings, the conversation panel, and reply tools without owning their server logic.
 */
export default function Dashboard() {
  // Navigation and panel state stay local because changing views does not change Gmail.
  const [view,setView]=useState('overview');
  const [filter,setFilter]=useState('all');
  const [searchQuery,setSearchQuery]=useState('');
  const [searchEpoch,setSearchEpoch]=useState(0);
  const searching=!!searchQuery.trim();
  const [selected,setSelected]=useState<Email|null>(null);
  const [connect,setConnect]=useState(false);
  const [briefRead,setBriefRead]=useState(false);
  const [composing,setComposing]=useState(false);
  /** The Gmail draft Compose is editing, when it was opened from the Drafts tab. */
  const [composeDraftId,setComposeDraftId]=useState('');
  const [composeEpoch,setComposeEpoch]=useState(0);
  const [compose,setCompose]=useState<ComposeFields>(emptyCompose);
  const [scheduledVersion,setScheduledVersion]=useState(0);
  const {darkMode,setDarkMode,showThemePrompt}=useTheme();
  const inbox=useInbox();
  const {emails,connected,status,busy,notice}=inbox;
  const {defaultEmailView,setDefaultEmailView}=useEmailView(status?.userId||'');
  const drafts=useDrafts(inbox.activeAccountId,connected,view==='drafts');
  // Saving or sending from Compose changes the Drafts folder, so it is read again on close.
  const wasComposing=useRef(false);
  const reloadDrafts=drafts.reload;
  useEffect(()=>{if(wasComposing.current&&!composing)void reloadDrafts();wasComposing.current=composing;},[composing,reloadDrafts]);
  const folding=useFoldPreferences(status?.userId||'');
  const doneMail=useDoneMail(status?.userId||'');
  const selectedEmail=selected?emails.find(email=>emailKey(email)===emailKey(selected))||null:null;
  // The panel keeps showing the message while it slides away. Clearing it the moment the
  // panel starts to close left an empty panel animating out for a dozen frames.
  const [lastShown,setLastShown]=useState<Email|null>(null);
  if(selectedEmail&&selectedEmail!==lastShown)setLastShown(selectedEmail);
  const shown=selectedEmail??lastShown;
  // The sender's HTML frame is built only after the slide-in finishes, so the animation
  // never waits on parsing and painting a newsletter.
  const [panelOpen,setPanelOpen]=useState(false);
  const [fullScreen,setFullScreen]=useState(false);
  const closeButton=useRef<HTMLButtonElement>(null);
  const [date,setDate]=useState('YOUR DAILY OVERVIEW');
  const [greeting,setGreeting]=useState('Welcome back');
  // One clock for every time-dependent view. Importance changes as obligations fall due,
  // so the minute timer that already refreshes the greeting advances this too: no extra
  // interval, no request, and no reclassification just because the date moved on.
  // The server and the hydrating browser must render the same first frame. The client
  // supplies wall-clock time immediately after hydration, then keeps it current.
  const [clock,setClock]=useState<number|null>(null);
  const searchResults=useMemo(()=>searchQuery.trim()?searchMail(emails,searchQuery,'',clock??0):[],[emails,searchQuery,clock]);
  useEffect(()=>{
    // Refresh the greeting at minute boundaries without forcing mailbox data to reload.
    const update=()=>{
      const now=new Date();
      setClock(now.getTime());
      setDate(now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}).toUpperCase());
      const hour=now.getHours();
      setGreeting(hour>=5&&hour<12?'Good morning, let’s start fresh':hour>=12&&hour<18?'Good afternoon, take a breather':'Good evening, time to unwind');
    };
    const initial=window.setTimeout(update,0);
    const timer=window.setInterval(update,60000);
    // A tab left open overnight should be current the moment it is looked at again.
    const visible=()=>{if(document.visibilityState==='visible')update();};
    document.addEventListener('visibilitychange',visible);
    return()=>{window.clearTimeout(initial);window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[]);
  const allInboxes=inbox.activeAccountId==='all';
  // Derive every visible collection from the current snapshot instead of maintaining
  // duplicate lists that could fall out of sync.
  const openAllMail=doneMail.split(emails).open;
  const mail=openAllMail.filter(m=>m.category!=='noise');
  const noise=openAllMail.filter(m=>m.category==='noise');
  const work=mail.filter(m=>m.category==='work');
  const personal=mail.filter(m=>m.category==='personal');
  const attention=work.filter(m=>isImportantEmail(m,clock));
  const personalAttention=personal.filter(m=>isImportantEmail(m,clock));
  const sources=Array.from(new Map(noise.map(m=>[senderKey(m),m])).values());
  const {section,tag}=parseView(view);
  // Overview spans Work and Personal so urgent personal mail still surfaces here.
  const base=view==='overview'?emails.filter(m=>m.category!=='noise'&&isImportantEmail(m,clock)):selectEmails(emails,view);
  const viewLabel=view==='overview'?'Overview':view==='inbox'?'Inbox':view==='drafts'?'Drafts':section?(tag?`${sectionName(section)} · ${tagName(tag)}`:sectionName(section)):'Inbox';
  // "Needs a reply" holds every pending reply in the current account and section scope.
  // Overview's Important-only list is a view of urgency, not of replies, so its reply tab
  // widens to all of Work and Personal: a routine question is still owed an answer.
  const replyScope=view==='overview'?emails.filter(m=>m.category!=='noise'):base;
  const pendingReplies=replyScope.filter(m=>m.needsReply);
  const replying=filter==='reply';
  const viewTitle=replying&&view==='overview'?'Waiting on your reply':view==='overview'?'Important now':view==='inbox'?'Your inbox':tag?tagName(tag):section?`${sectionName(section)} conversations`:'Your inbox';
  const messages=replying?pendingReplies:base;
  // Mail marked done leaves the list and its counts and waits in a collapsed Done section.
  const {open:openMessages,done:doneMessages}=doneMail.split(messages);
  const openReplies=doneMail.split(pendingReplies).open;

  useMailTools(emails,setSelected,!connected);
  const lastSync=connected&&inbox.updated?new Date(inbox.updated).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):null;
  const agentActive=connected&&!!status?.schedulerActive;
  // A successful send only — a saved draft never reaches here. Marking `replied` lets a sync
  // or poll that started before the send keep the badge cleared when it lands afterwards.
  function markReplied(){if(selected)inbox.setEmails(previous=>previous.map(m=>
    m.accountId===selected.accountId&&(emailKey(m)===emailKey(selected)||!!selected.threadId&&m.threadId===selected.threadId&&(m.receivedAt||0)<=(selected.receivedAt||0))
      ?{...m,needsReply:false,replied:true}:m));}
  function applyCorrection(updated:Email){
    // Merge one composite message identity into the latest state. A delayed response for
    // another mailbox cannot replace the current inbox, and an older revision cannot
    // roll back a correction already received from a poll or another action.
    inbox.setEmails(previous=>previous.map(current=>{
      if(emailKey(current)!==emailKey(updated))return current;
      if((current.correctionRevision||0)>(updated.correctionRevision||0))return current;
      if((current.senderRuleRevision||0)>(updated.senderRuleRevision||0))return current;
      return {...current,classification:updated.classification,automaticClassificationAvailable:updated.automaticClassificationAvailable,
        correctionRevision:updated.correctionRevision,manuallyCorrected:updated.manuallyCorrected,
        manualCorrection:updated.manualCorrection,
        senderJunkPreference:updated.senderJunkPreference,senderRuleRevision:updated.senderRuleRevision,
        category:updated.category,tags:updated.tags,priority:updated.priority,label:updated.label,
        // A correction computed before a reply was sent cannot reinstate the badge.
        replied:current.replied||updated.replied,needsReply:current.replied?false:updated.needsReply};
    }));
  }

  // People the user has corresponded with, offered as suggestions while typing a recipient.
  const contacts=useMemo(()=>{
    const own=new Set(inbox.accounts.map(account=>account.email.toLowerCase()));
    const seen=new Map<string,Contact>();
    for(const m of emails){const key=m.address.toLowerCase();if(m.category==='noise'||own.has(key)||/no-?reply|donotreply/.test(key)||seen.has(key))continue;seen.set(key,{name:m.sender,address:m.address});}
    return [...seen.values()].slice(0,300);
  },[emails,inbox.accounts]);
  // A fresh email starts with the saved signature already under the cursor.
  const signature=status?.profile?.signature||'';
  const blank=useMemo<ComposeFields>(()=>({...emptyCompose,body:signature?`\n\n${signatureBlock(signature)}`:''}),[signature]);
  const writingNothing=(fields:ComposeFields)=>!fields.to.trim()&&!fields.cc.trim()&&!fields.bcc.trim()&&!fields.subject.trim()&&(!fields.body.trim()||fields.body.trim()===blank.body.trim());
  function openCompose(){if(writingNothing(compose)||composeDraftId){setCompose(blank);setComposeDraftId('');setComposeEpoch(value=>value+1);}setComposing(true);}
  // Opens the compose window with ready-made content, unless the user chooses to keep what they were writing.
  function startCompose(fields:ComposeFields,question:string){
    if(!writingNothing(compose)&&!window.confirm(question))return false;
    setCompose(fields);setComposeDraftId('');setComposeEpoch(value=>value+1);setSelected(null);setComposing(true);return true;
  }
  /** Reopens a Gmail draft in Compose; saving updates that draft and sending removes it. */
  function editDraft(draft:DraftItem){
    if(!writingNothing(compose)&&!window.confirm('Replace the email you are writing with this draft?'))return;
    setCompose({to:draft.to.join(', '),cc:draft.cc.join(', '),bcc:draft.bcc.join(', '),subject:draft.subject,body:draft.body,accountId:draft.accountId});
    setComposeDraftId(draft.id);setComposeEpoch(value=>value+1);setSelected(null);setComposing(true);
  }
  function forward(email:Email){
    const full=[email.body,email.signature,email.quoted].filter(Boolean).join('\n\n');
    const quoted=`---------- Forwarded message ----------\nFrom: ${email.sender} <${email.address}>\nDate: ${receivedLabel(email,Date.now())}\nSubject: ${email.subject}\n\n${full}`;
    if(quoted.length>18000||email.contentComplete===false){window.open(gmailLink(email),'_blank','noopener,noreferrer');return;}
    // A forward leaves from the mailbox the message arrived in.
    startCompose({...emptyCompose,accountId:email.accountId||'',subject:/^fwd?:/i.test(email.subject)?email.subject:'Fwd: '+email.subject,body:`\n\n${signature?signatureBlock(signature)+'\n\n':''}${quoted}`},'Replace the email you are writing with this forward?');
  }
  function selectView(nextView:string){
    setSearchQuery('');setSearchEpoch(value=>value+1);
    setSelected(null);setFilter('all');setView(nextView);
  }
  function selectInbox(){
    selectView('inbox');
    if(connected&&inbox.activeAccountId==='all'&&inbox.individualAccountId!=='all')
      inbox.setActiveAccountId(inbox.individualAccountId);
  }
  function switchAccount(id:string){inbox.setActiveAccountId(id);setBriefRead(false);selectView('overview');}

  /**
   * The sidebar's combined-scope entry point. It widens the account scope and opens the
   * top-level Inbox, clearing any subcategory and the open conversation so mail from the
   * previous scope is never left on screen beside messages it does not belong with.
   *
   * The scope change is skipped when it is already combined, which avoids emptying the
   * list and refetching for a selection the user is already viewing. Without a Gmail
   * connection this only navigates, so the demo workspace makes no authenticated request.
   */
  function selectAllInboxes(){
    setBriefRead(false);selectView('inbox');
    if(connected&&inbox.activeAccountId!=='all')inbox.setActiveAccountId('all');
  }

  return <SidebarProvider style={{'--sidebar-width':'238px'} as React.CSSProperties}>
    <Sidebar className="brief-sidebar">
      <SidebarHeader className="brand-block"><Link className="brand" href="/"><span className="brand-icon"><Layers3 size={23}/></span>brief<span className="brand-dot">.</span></Link><span className="brand-caption">Bedrock Systems 2026</span></SidebarHeader>
      <SidebarContent>
        <div className="workspace-label">WORKSPACE</div>
        <CategoryNav emails={openAllMail} view={view} allInboxes={allInboxes} onSelect={nextView=>nextView==='inbox'?selectInbox():selectView(nextView)} onSelectAllInboxes={selectAllInboxes} draftCount={connected&&drafts.loaded?drafts.count:undefined}/>
        <Link href="/team" className="settings-button" style={{margin:"20px 16px 0"}}><Layers3 size={17}/> Team knowledge <ArrowUpRight size={14}/></Link><div className="sidebar-note"><span className="tiny-spark"><Sparkles size={14}/></span><span>A quieter inbox.<br/><strong>A clearer head.</strong></span></div>
      </SidebarContent>
      <SidebarFooter className="sidebar-bottom"><div className="agent-mini"><span className="agent-orb"><Sparkles size={18}/></span><div><strong>Your inbox agent</strong><span>{agentActive?'Checking every 30 min':connected?'Schedule pending':'Ready when you are'}</span></div><span className={`status-dot ${agentActive?'':'muted'}`}/></div><button className="settings-button" onClick={()=>setConnect(true)}><Settings2 size={17}/>Settings & connections</button><button className="account-button" onClick={()=>setConnect(true)}><span className="avatar gray">A</span><span><strong>{connected?(allInboxes?'All inboxes':inbox.activeAccount?.email?.split('@')[0]):'Your workspace'}</strong><small>{connected?'Gmail connected':'Personal account'}</small></span><ChevronDown size={15}/></button></SidebarFooter>
    </Sidebar>
    <div className="app-main">
      <header className="topbar"><div className="breadcrumb"><SidebarTrigger className="mobile-toggle"/><span>Workspace</span><span className="slash">/</span><strong>{viewLabel}</strong></div><div className="topbar-right"><HeaderMailSearch key={`${status?.userId||'demo'}:${inbox.activeAccountId}:${searchEpoch}`} query={searchQuery} onQuery={setSearchQuery} emails={emails} scope={`${status?.userId||'demo'}:${inbox.activeAccountId}`} now={clock} onSelect={setSelected}/><span className="demo-pill">{connected?'Gmail workspace':'Demo workspace'}</span><AccountSwitcher accounts={inbox.accounts} activeAccountId={inbox.activeAccountId} defaultAccountId={inbox.defaultAccountId} onSelect={switchAccount} onSettings={()=>setConnect(true)}/></div></header>
      <main className="dashboard-content">
        <div className="heading-row"><div><div className="eyebrow"><Sun size={14}/> {date}</div><h1>{greeting}<span>.</span></h1>{view==='noise'&&<p>Your subscriptions, neatly in one place.</p>}</div><div className="inbox-primary-actions"><ScheduledEmails connected={connected} version={scheduledVersion} showAccount={inbox.accounts.length>1} onEdit={fields=>startCompose(fields,'Replace the email you are writing with this scheduled email?')}/><button className="button blue" onClick={openCompose}><SquarePen size={15}/>Compose</button>{!connected&&<ConnectGmailButton status={status} signInUrl={inbox.signInUrl} onSetup={()=>setConnect(true)}/>}<button className="button white" disabled={busy} onClick={()=>void inbox.refresh()} aria-label="Refresh inbox"><RefreshCw size={15} className={busy?'spinning':''}/>{busy?'Refreshing…':'Refresh inbox'}</button></div></div>
        {notice&&<output className="inbox-notice"><span>{notice}</span>{inbox.signInUrl&&<a className="button white" href={inbox.signInUrl} target="_top">Sign in</a>}<button aria-label="Dismiss notification" onClick={()=>inbox.setNotice('')}><X size={14}/></button></output>}
        {connected&&inbox.skipped>0&&<p className="gmail-connect-hint">{inbox.skipped} {inbox.skipped===1?'message was':'messages were'} unreadable and skipped during the latest refresh.</p>}
        {!connected&&<p className="gmail-connect-hint">You’re viewing sample emails. Connect Gmail to see summaries of your own inbox.</p>}
        <div className="content-columns"><div className="primary-column">
          {!searching&&view==='overview'&&<MyTasksStrip now={clock}/>}
          {!searching&&view==='overview'&&<DailyBrief doneKeys={doneMail.keys} onDone={doneMail.markDone} onMoveBack={doneMail.moveBack} emails={emails} now={clock} connected={connected} ai={inbox.ai} aiConfigured={!!status?.aiConfigured} busy={busy} updated={inbox.updated} collapsed={briefRead} onCollapse={()=>setBriefRead(!briefRead)} onSelect={setSelected} digest={inbox.digest} foldPreferences={folding.preferences} accountId={inbox.activeAccountId} scope={connected?`${status?.userId||'user'}:${inbox.activeAccountId}`:'demo'}/>}
          {searching?<MailSearchResults key={`${searchQuery}:${inbox.activeAccountId}`} emails={searchResults} query={searchQuery} hasMore={inbox.hasMore} showAccount={allInboxes&&inbox.accounts.length>1} now={clock} onSelect={setSelected}/>:view==='drafts'?<DraftsView drafts={drafts} now={clock} connected={connected} showAccount={allInboxes&&inbox.accounts.length>1} onEdit={editDraft} onCompose={openCompose}/>:view==='noise'?<NoiseList emails={noise} demo={!connected} blocked={inbox.blocked} user={status?.userId} onSelect={setSelected} onBlockChanged={inbox.reloadCached}/>:<section className={`inbox-section ${view!=='overview'?'standalone-inbox':''}`}><div className="section-title-row"><h2>{viewTitle} <span>{openMessages.length}</span></h2></div><div className="inbox-toolbar"><Tabs value={filter} onValueChange={v=>setFilter(String(v))}><TabsList><TabsTrigger value="all">All mail</TabsTrigger><TabsTrigger value="reply">Needs a reply <span className="tab-count">{openReplies.length}</span></TabsTrigger></TabsList></Tabs><span className="sort-label">{replying?'Most urgent replies first':'Most important first'}</span></div>{/* Keying on the view and filter restarts the list at the top when the selection
                changes, instead of carrying the previous view's expanded extent into it. */}
            <PriorityEmailList key={`${view}:${filter}:${inbox.activeAccountId}`} emails={openMessages} doneEmails={doneMessages} onDone={doneMail.markDone} onMoveBack={doneMail.moveBack} now={clock} sortMode={view==='inbox'?'newest':replying?'reply':'importance'} conversationsOnly={view==='inbox'} foldPreferences={folding.preferences} onKeepSeparate={folding.keepSeparate} onSenderPreference={folding.setSenderPreference} busy={busy} showAccount={allInboxes&&inbox.accounts.length>1} emptyTitle="All clear." emptyBody={filter==='reply'?'No conversations need a reply right now.':'New conversations will appear after your next refresh.'} onSelect={setSelected}/><div className="inbox-end"><Check size={14}/> {inbox.hasMore?'Scanning older Gmail messages in the background.':'Mailbox scan complete.'}</div></section>}
        </div><aside className="secondary-column"><WeekCalendar emails={emails} demo={!connected} onSelect={setSelected}/><div className="stats-grid"><div className="stat"><span><Inbox/>In your inbox</span><div>{openAllMail.length}<small>new emails</small></div></div><div className="stat"><span><span className="small-dot blue-dot"/>Important</span><div className="attention-counts"><div>{attention.length}<small>work { attention.length === 1 ? 'conversation' : 'conversations' }</small></div><div>{personalAttention.length}<small>personal { personalAttention.length === 1 ? 'conversation' : 'conversations' }</small></div></div></div><NextEvent emails={emails} demo={!connected} onSelect={setSelected}/></div><section className="noise-card"><div className="aside-title"><h2><Layers3 size={18}/> Quiet corner</h2><span className="soft-count">{noise.length}</span></div><p>Newsletters and promotions,<br/>neatly out of your way.</p><div className="noise-stack">{sources.slice(0,4).map(m=><span key={senderKey(m)} className={`mini-logo ${m.color}`}>{m.initials.toLowerCase()}</span>)}<span className="senders-label">{sources.length} senders</span></div><div className="noise-rule"/><button className="text-button" onClick={()=>selectView('noise')}>Review & unsubscribe <ArrowRight size={15}/></button></section><div className="calm-note"><span className="calm-line"/><Sparkles size={15}/><span className="calm-line"/><p>A clear inbox is a fresh start.</p></div></aside></div>
        <footer className="page-footer"><span><span className="small-dot"/> {connected?(lastSync?`Last synced ${lastSync} · Refreshes every 30 minutes while open`:'Gmail connected · Preparing your first brief'):'Sample emails · Connect Gmail to make it yours'}</span><span>Made for a little more headspace.</span></footer>
      </main>
    </div>
    <ConnectionPanel defaultEmailView={defaultEmailView} onDefaultEmailViewChange={setDefaultEmailView} signInUrl={inbox.signInUrl} open={connect} onOpenChange={setConnect} status={status} darkMode={darkMode} onDarkModeChange={setDarkMode} defaultAccountId={inbox.defaultAccountId} onSetDefault={inbox.setDefaultAccount} onRetry={async id=>{const result=await api<InboxSnapshot>('/api/sync',{accountId:id,explicit:true});const problem=syncFailureMessage(result);if(problem)throw new Error(problem);inbox.setStatus(await api<ConnectionStatus>('/api/connection'));await inbox.reloadCached();}} onDisconnectAccount={async id=>{await inbox.disconnectAccount(id);setSelected(null);}} onDisconnect={()=>{inbox.resetToDemo();setSelected(null);}} onProfileSaved={profile=>inbox.setStatus(previous=>previous?{...previous,profile}:previous)}/>
    <ComposeDialog key={composeEpoch} initialDraftId={composeDraftId} open={composing} onOpenChange={setComposing} demo={!connected} aiReady={!!status?.aiConfigured} schedulerActive={!!status?.schedulerActive} fields={compose} onFields={setCompose} blank={blank} contacts={contacts} mailboxes={inbox.accounts.map(account=>({id:account.id,email:account.email}))} preferredAccountId={inbox.activeAccountId!=='all'?inbox.activeAccountId:inbox.defaultAccountId} onScheduled={()=>setScheduledVersion(version=>version+1)}/>
    <ThemePrompt open={showThemePrompt} onChoose={setDarkMode}/>
    <Sheet open={!!selectedEmail} onOpenChange={o=>!o&&setSelected(null)}
      onOpenChangeComplete={open=>{setPanelOpen(open);if(!open){setLastShown(null);setFullScreen(false);}}}>
      <SheetContent className={`email-sheet${fullScreen?' email-sheet-full':''}`} showCloseButton={false} initialFocus={closeButton}><div className="email-sheet-actions">{shown&&<SenderJunkButton email={shown} demo={!connected} onApplied={applyCorrection} onRefresh={inbox.reloadCached}/>}<SheetClose ref={closeButton} className="email-sheet-close" aria-label="Close"><X size={16}/></SheetClose></div><div className="email-sheet-inner"><SheetHeader><span className="eyebrow">CONVERSATION</span><SheetTitle>{shown?.subject}</SheetTitle><SheetDescription>{shown?.sender} · {shown?.address}{shown?.accountEmail&&<> · To {shown.accountEmail}</>}</SheetDescription>{shown&&<div className="conversation-tags"><span className="mail-label section">{sectionName(shown.category)}</span>{emailTags(shown).filter(t=>t!=='junk').map(t=><span key={t} className="mail-label">{tagName(t)}</span>)}</div>}</SheetHeader>{shown&&<EmailBody key={emailKey(shown)} email={shown} preferredView={defaultEmailView} ready={panelOpen} fullScreen={fullScreen} onFullScreenChange={setFullScreen}/>} {shown&&<ClassificationDetail email={shown} demo={!connected} onApplied={applyCorrection} onRefresh={inbox.reloadCached}
  grouping={preferenceFor(shown,folding.preferences)??'automatic'}
  onGrouping={value=>folding.setSenderPreference(shown,value)}/>} {shown?.quoted&&<details className="quoted-history"><summary>Quoted history</summary><div className="message-body">{shown.quoted}</div></details>}{shown&&<div className="sheet-actions">{shown.contentComplete===false||[shown.body,shown.signature,shown.quoted].filter(Boolean).join('\n\n').length>18000?<a className="button white" href={gmailLink(shown)} target="_blank" rel="noreferrer"><Forward size={14}/>Forward in Gmail (keeps attachments and full text)</a>:<button className="button white" onClick={()=>forward(shown)}><Forward size={14}/>Forward</button>}<AddToTeamTask email={shown}/></div>}{shown&&<ReplyComposer key={emailKey(shown)} email={shown} demo={!connected} aiReady={!!status?.aiConfigured} onSent={markReplied}/>}</div></SheetContent></Sheet>
  </SidebarProvider>;
}
