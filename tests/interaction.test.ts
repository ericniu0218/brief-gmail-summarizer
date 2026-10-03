import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { allByText, byLabel, byText, click, render, rerender, screen, setupDom, settle, teardownDom, unmountTree } from './dom';
import Dashboard from '../app/page';
import { ReplyComposer } from '../components/reply-composer';
import { ClassificationDetail } from '../components/classification-detail';
import { NoiseList } from '../components/noise-list';
import { BlockConfirmFields } from '../components/block-confirm';
import { PriorityEmailList } from '../components/priority-email-list';
import { WeekCalendar } from '../components/week-calendar';
import { SenderJunkButton } from '../components/sender-junk-button';
import { useSenderRule } from '../hooks/use-sender-rule';
import { EmailBody } from '../components/email-body';
import { demoEmails, type Email } from '../lib/mail';
import type { Classification } from '../lib/classification';
import { useInbox, type ConnectionStatus } from '../hooks/use-inbox';
import type { InboxSnapshot } from '../lib/inbox-client';

/**
 * Interaction tests for the combined "All inboxes" view.
 *
 * These mount the real dashboard in a browser-like document, so a click runs the same
 * handlers a person would trigger. The other suites cover rendered markup and server
 * rules; this one covers what actually happens when the button is pressed.
 */

const ACCOUNT_EMAIL:Record<string,string>={'acct-1':'first@example.com','acct-2':'second@example.com'};
const accounts=[
  {id:'acct-1',email:ACCOUNT_EMAIL['acct-1'],lastSync:123,error:null},
  {id:'acct-2',email:ACCOUNT_EMAIL['acct-2'],lastSync:123,error:null},
];
const connection:ConnectionStatus={
  userId:'user-a',accounts,defaultAccountId:'acct-1',connected:true,configured:true,
  aiConfigured:true,schedulerActive:false,intervalMinutes:30,
};

/**
 * A message attributed to one mailbox. Each gets its own sender domain so the inbox never
 * folds two of them into a single grouped row, which would hide the subjects under test.
 */
function mail(over:Partial<Email>&{id:string;accountId:string}):Email{
  return {...demoEmails[0],accountEmail:ACCOUNT_EMAIL[over.accountId],address:`${over.id}@${over.id}.example`,
    needsReply:false,tags:[],category:'work',...over} as Email;
}

const firstAccountMail=[
  mail({id:'w1',accountId:'acct-1',subject:'First account work mail',category:'work',tags:['deadlines']}),
  mail({id:'p1',accountId:'acct-1',subject:'First account personal mail',category:'personal',tags:['low-priority']}),
];
const secondAccountMail=[
  mail({id:'w2',accountId:'acct-2',subject:'Second account work mail',category:'work',tags:['deadlines']}),
  mail({id:'p2',accountId:'acct-2',subject:'Second account personal mail',category:'personal',tags:['low-priority']}),
];
const combinedMail=[...firstAccountMail,...secondAccountMail];

function snapshot(emails:Email[]):InboxSnapshot{
  return {emails,updated:123,ai:true,hasMore:false,skipped:0,
    accounts:accounts.map(a=>({...a,loaded:true,pending:0,skipped:0,hasMore:false}))};
}

/** Mail for one account id, or the combined view when no account was named. */
function mailFor(account:string|null){
  return snapshot(account==='acct-1'?firstAccountMail:account==='acct-2'?secondAccountMail:combinedMail);
}

type Handler=(url:string,body:Record<string,unknown>|undefined)=>unknown;
type Seen={url:string;body:Record<string,unknown>|undefined};

/** Routes the dashboard's requests to canned data and records what it asked for. */
function stubFetch(handler:Handler){
  const seen:Seen[]=[];
  globalThis.fetch=(async(input:unknown,init?:RequestInit)=>{
    const url=String(input instanceof Request?input.url:input);
    const body=typeof init?.body==='string'?JSON.parse(init.body) as Record<string,unknown>:undefined;
    seen.push({url,body});
    const result=await handler(url,body);
    if(result===undefined)throw new Error(`unexpected request ${url}`);
    return Response.json(result);
  }) as typeof fetch;
  return seen;
}

function defaultHandler(url:string,body:Record<string,unknown>|undefined){
  if(url.startsWith('/api/connection'))return connection;
  if(url.startsWith('/api/demo'))return snapshot([]);
  if(url.startsWith('/api/mailbox'))
    return mailFor(new URL(url,'https://brief.example').searchParams.get('accountId'));
  // The refresh names its account in the request body rather than the query string.
  if(url.startsWith('/api/sync'))return mailFor(typeof body?.accountId==='string'?body.accountId:null);
  if(url.startsWith('/api/reply'))return {id:'sent-1',status:'sent'};
  if(url.startsWith('/api/classification')){
    // Mirrors the real route: the saved preference and the advanced revision come back so
    // the browser can keep writing in order.
    const action=body?.action as {type?:string;value?:string}|undefined;
    const junk=action?.type==='set-sender-junk-preference'?action.value as 'junk'|'not-junk':undefined;
    const revision=(Number(body?.expectedSenderRevision)||0)+1;
    return {updated:true,revision:Number(body?.expectedRevision)||0,senderRuleRevision:revision,
      senderJunkPreference:junk??null,
      email:mail({id:typeof body?.messageId==='string'?body.messageId:'s1',
        accountId:typeof body?.accountId==='string'?body.accountId:'acct-1',
        senderJunkPreference:junk,senderRuleRevision:revision})};
  }
  return undefined;
}

const originalFetch=globalThis.fetch;
afterEach(()=>{teardownDom();globalThis.fetch=originalFetch;});

/** Boots the dashboard as a connected user with two mailboxes. */
async function openDashboard(options:{viewport?:'desktop'|'mobile';handler?:Handler}={}){
  setupDom({viewport:options.viewport});
  const seen=stubFetch(options.handler??defaultHandler);
  await render(createElement(Dashboard));
  await settle();
  return seen;
}

function InboxLifecycleProbe(){
  const inbox=useInbox();
  return createElement('div',{},
    createElement('span',{'data-testid':'busy'},inbox.busy?'busy':'idle'),
    createElement('button',{type:'button',onClick:()=>void inbox.refresh()},'Probe refresh'),
    createElement('button',{type:'button',onClick:()=>void inbox.reloadCached()},'Probe cached reload'),
    createElement('button',{type:'button',onClick:()=>inbox.setActiveAccountId('acct-2')},'Probe switch account'),
    createElement('button',{type:'button',onClick:inbox.resetToDemo},'Probe reset demo'));
}

void test('a cached reload supersedes sync output without starting a second sync',async()=>{
  setupDom();
  let syncCount=0;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/sync')){
      syncCount++;
      if(syncCount===2)await held;
      return mailFor(typeof body?.accountId==='string'?body.accountId:null);
    }
    return defaultHandler(url,body);
  });
  await render(createElement(InboxLifecycleProbe));
  await settle();
  assert.equal(syncCount,1,'boot completed its initial sync');

  await click(byText('button','Probe refresh'));
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'busy');
  await click(byText('button','Probe cached reload'));
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'busy',
    'the physical sync keeps its mutex until it settles');
  await click(byText('button','Probe refresh'));
  assert.equal(syncCount,2,'another refresh cannot overlap the superseded sync');
  release();
  await settle();
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'idle');
  await click(byText('button','Probe refresh'));
  assert.equal(syncCount,3,'a later refresh can start normally');
});

void test('switching accounts during refresh never starts an overlapping sync',async()=>{
  setupDom();
  let syncCount=0;
  const synced:(string|null)[]=[];
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/sync')){
      syncCount++;
      const accountId=typeof body?.accountId==='string'?body.accountId:null;
      synced.push(accountId);
      if(syncCount===2)await held;
      return mailFor(accountId);
    }
    return defaultHandler(url,body);
  });
  await render(createElement(InboxLifecycleProbe));
  await settle();
  await click(byText('button','Probe refresh'));
  await click(byText('button','Probe switch account'));
  assert.equal(syncCount,2,'switching reads the target cache while Gmail is busy');
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'busy');
  await click(byText('button','Probe refresh'));
  assert.equal(syncCount,2,'Refresh remains locked until the original request settles');
  release();
  await settle();
  // The mailbox chosen mid-sync was shown from the cache. It is refreshed as soon as the
  // mutex frees, so the newly selected account is not left stale until the next poll.
  assert.equal(syncCount,3,'the account chosen during the sync refreshes once it can');
  assert.equal(synced[2],'acct-2','and the queued refresh targets that account');
  await click(byText('button','Probe refresh'));
  assert.equal(syncCount,4,'the selected account can refresh after the mutex is released');
});

void test('resetting to demo does not release a physical Gmail sync early',async()=>{
  setupDom();
  let syncCount=0;
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/sync')){
      syncCount++;
      if(syncCount===2)await held;
      return mailFor(typeof body?.accountId==='string'?body.accountId:null);
    }
    return defaultHandler(url,body);
  });
  await render(createElement(InboxLifecycleProbe));
  await settle();
  await click(byText('button','Probe refresh'));
  await click(byText('button','Probe switch account'));
  await click(byText('button','Probe reset demo'));
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'busy');
  await click(byText('button','Probe refresh'));
  assert.equal(syncCount,2,'demo reset cannot launch another Gmail request');
  release();
  await settle();
  assert.equal(screen().querySelector('[data-testid="busy"]')?.textContent,'idle');
  assert.equal(syncCount,2,'demo reset discards the connected mailbox refresh that was queued behind it');
});

/** Subjects currently listed in the inbox. */
const subjects=()=>allByText('h3',/account (work|personal) mail/).map(node=>(node.textContent||'').trim()).sort();

/** A sidebar row by its visible label, ignoring the count beside it. */
function navButton(label:string){
  const found=[...screen().querySelectorAll('.nav-button')]
    .filter(node=>node.querySelector('span')?.textContent===label);
  if(found.length!==1)throw new Error(`Expected one "${label}" sidebar row, found ${found.length}`);
  return found[0] as HTMLElement;
}
const isActive=(element:Element)=>element.hasAttribute('data-active');

void test('the email reader switches views and goes full screen without weakening its sandbox',async()=>{
  setupDom();
  const email={...demoEmails[0],body:'Plain fallback https://tracking.example/click?token=secret',
    html:'<table width="900"><tr><td>Formatted newsletter</td></tr></table>'};
  let fullScreen=false;
  const props=()=>({email,fullScreen,onFullScreenChange:(value:boolean)=>{fullScreen=value;}});
  await render(createElement(EmailBody,props()));
  // A conversation without images opens as text: no frame, readable links.
  assert.equal(byText('button','Reading view').getAttribute('aria-pressed'),'true');
  assert.equal(screen().querySelectorAll('iframe.email-document').length,0,'the reading view has no frame');
  assert.match(screen().querySelector('.reading-body')?.textContent||'',/Formatted newsletter/);

  await click(byText('button','Original'));
  const frame=screen().querySelector('iframe.email-document')!;
  assert.deepEqual((frame.getAttribute('sandbox')||'').split(' ').sort(),
    ['allow-popups','allow-popups-to-escape-sandbox'],'switching views grants no new iframe capability');

  await click(byText('button',/Full screen/));
  assert.equal(fullScreen,true,'the panel is asked to take the whole window');
  await rerender(createElement(EmailBody,props()));
  assert.ok(screen().querySelector('iframe.email-document')!.classList.contains('expanded'));
  assert.equal(byText('button',/Exit full screen/).getAttribute('aria-pressed'),'true');
});

void test('the reading view shows text tidily: links compact, tables kept, footer folded',async()=>{
  setupDom();
  const tracking=`https://u1.ct.sendgrid.net/ls/click?upn=${'x'.repeat(200)}`;
  const email={...demoEmails[0],category:'work' as const,body:'unused',
    html:`<p>Hi Alex,</p><p>Thanks&amp;nbsp;for the order. <a href="${tracking}">Track it</a>.</p><table><tr><th>Item</th><th>Qty</th></tr><tr><td>Seats</td><td>12</td></tr></table><p>Unsubscribe | Manage preferences</p>`};
  await render(createElement(EmailBody,{email}));
  const body=screen().querySelector('.reading-body')!;
  assert.match(body.textContent||'',/Thanks for the order/,'a stray &nbsp; is decoded');
  assert.doesNotMatch(body.textContent||'',/x{50}/,'the tracking query is not printed');
  assert.equal(body.querySelectorAll('a.reading-link').length,1);
  assert.equal(body.querySelectorAll('.reading-table td').length,4,'a table keeps its cells');
  const footer=body.querySelector('details.reading-footer')!;
  assert.ok(footer&&!footer.hasAttribute('open'),'the mailing-list footer is folded, not removed');
  assert.match(footer.textContent||'',/Unsubscribe/);
});

void test('the sender’s frame is held back until the panel has opened, and the view choice is remembered',async()=>{
  setupDom();
  const email={...demoEmails[0],category:'noise' as const,address:'news@letters.example',html:'<img src="https://x.example/a.png"><p>Big newsletter</p>'};
  await render(createElement(EmailBody,{email,ready:false}));
  assert.equal(byText('button','Original').getAttribute('aria-pressed'),'true','a newsletter opens in its original layout');
  assert.equal(screen().querySelectorAll('iframe').length,0,'no frame while the panel slides in');
  assert.ok(screen().querySelector('.email-document-pending'),'a placeholder keeps the space');
  await rerender(createElement(EmailBody,{email,ready:true}));
  assert.equal(screen().querySelectorAll('iframe.email-document').length,1);
  await click(byText('button','Reading view'));
  assert.equal(globalThis.localStorage.getItem('brief:email-view:demo:news@letters.example'),'reading');
  await unmountTree();
  await render(createElement(EmailBody,{email:{...email,id:'next'}}));
  await settle();
  assert.equal(byText('button','Reading view').getAttribute('aria-pressed'),'true','the next message from this sender opens the same way');
});

void test('the dashboard opens on the default mailbox, not the combined view', async () => {
  await openDashboard();
  // resolveSelection prefers the stored default account, so only its mail is listed.
  assert.deepEqual(subjects(),['First account personal mail','First account work mail']);
});

void test('choosing All inboxes widens the scope and clears the previous subcategory', async () => {
  const seen=await openDashboard();
  // Narrow to a subcategory first, so the test proves the selection is actually cleared.
  await click(byLabel('Expand inbox sections'));
  await click(byLabel('Expand Work subcategories'));
  await click(byText('button',/^Deadlines/));
  assert.deepEqual(subjects(),['First account work mail'],'a subcategory of one mailbox');

  seen.length=0;
  await click(navButton('All inboxes'));

  // Every connected mailbox is now listed, at the top-level inbox rather than a category.
  assert.deepEqual(subjects(),[
    'First account personal mail','First account work mail',
    'Second account personal mail','Second account work mail',
  ],'the combined scope replaced the single-account subcategory view');
  assert.ok(isActive(navButton('All inboxes')),'All inboxes is highlighted');
  assert.ok(!isActive(navButton('Inbox')),'the single-account Inbox is not also highlighted');
  assert.ok(!isActive(navButton('Work')),'the previous category is no longer highlighted');
  // The combined mailbox is requested without naming an account, reusing the existing API.
  assert.ok(seen.some(request=>request.url==='/api/mailbox'),'loads the combined mailbox');
  assert.ok(!seen.some(request=>request.url.includes('accountId=')),'no account is named');
});

void test('categories and subcategories filter across every connected mailbox', async () => {
  await openDashboard();
  await click(navButton('All inboxes'));
  await click(byLabel('Expand inbox sections'));

  await click(navButton('Work'));
  assert.deepEqual(subjects(),['First account work mail','Second account work mail'],
    'Work spans both mailboxes');

  await click(navButton('Personal'));
  assert.deepEqual(subjects(),['First account personal mail','Second account personal mail'],
    'Personal spans both mailboxes');

  // A subcategory narrows the messages without narrowing the account scope.
  await click(byLabel('Expand Work subcategories'));
  await click(byText('button',/^Deadlines/));
  assert.deepEqual(subjects(),['First account work mail','Second account work mail'],
    'a subcategory still spans both mailboxes');
  assert.ok(!isActive(navButton('All inboxes')),'the highlight follows the chosen category');

  // Returning to the combined inbox restores every message, so scope was never lost.
  await click(navButton('All inboxes'));
  assert.equal(subjects().length,4,'the combined scope survived category navigation');
});

void test('Inbox returns to the selected individual mailbox after All inboxes and a reload',async()=>{
  setupDom();
  localStorage.setItem('brief:selected-view:user-a','acct-2');
  const seen=stubFetch(defaultHandler);
  await render(createElement(Dashboard));await settle();
  await click(navButton('Inbox'));
  assert.deepEqual(subjects(),['Second account personal mail','Second account work mail']);
  await click(navButton('All inboxes'));
  assert.equal(subjects().length,4);
  assert.equal(localStorage.getItem('brief:selected-account:user-a'),'acct-2');
  await unmountTree();
  await render(createElement(Dashboard));await settle();
  assert.equal(allByText('strong','All inboxes').length,1,'the combined view restores independently');
  seen.length=0;
  await click(navButton('Inbox'));
  assert.deepEqual(subjects(),['Second account personal mail','Second account work mail'],'Inbox keeps the chosen account, not the default or the combined scope');
  assert.ok(isActive(navButton('Inbox')));
  assert.ok(!isActive(navButton('All inboxes')));
  assert.ok(seen.some(request=>request.url.includes('/api/mailbox?accountId=acct-2')));
  assert.ok(!seen.some(request=>request.url==='/api/mailbox'));
  assert.equal(localStorage.getItem('brief:selected-view:user-a'),'acct-2');
});

void test('Inbox falls back to an owned account when the previously selected mailbox is gone',async()=>{
  setupDom();
  localStorage.setItem('brief:selected-view:user-a','all');
  localStorage.setItem('brief:selected-account:user-a','disconnected-account');
  const seen=stubFetch(defaultHandler);
  await render(createElement(Dashboard));await settle();
  await click(navButton('Inbox'));
  assert.deepEqual(subjects(),['First account personal mail','First account work mail']);
  assert.ok(seen.some(request=>request.url.includes('/api/mailbox?accountId=acct-1')));
  assert.ok(!seen.some(request=>request.url.includes('disconnected-account')));
});

void test('an expand arrow opens subcategories without navigating to the category', async () => {
  await openDashboard();
  await click(navButton('All inboxes'));
  await click(byLabel('Expand inbox sections'));
  const before=subjects();
  await click(byLabel('Expand Work subcategories'));
  assert.deepEqual(subjects(),before,'the listed mail is unchanged by the arrow');
  assert.ok(!isActive(navButton('Work')),'the arrow did not select the category');
  assert.ok(isActive(navButton('All inboxes')),'the current view is still the combined inbox');
  // The disclosure is reported to assistive technology and can be closed again.
  const arrow=byLabel('Collapse Work subcategories');
  assert.equal(arrow.getAttribute('aria-expanded'),'true');
  await click(arrow);
  assert.equal(byLabel('Expand Work subcategories').getAttribute('aria-expanded'),'false');
});

void test('active-path disclosure controls explain why they are locked open',async()=>{
  await openDashboard();
  await click(byLabel('Expand inbox sections'));
  await click(byLabel('Expand Work subcategories'));
  await click(byText('button',/^Deadlines/));
  const workLock=byLabel('Work subcategories stay open while Deadlines is selected') as HTMLButtonElement;
  assert.equal(workLock.disabled,true,'the subcategory arrow cannot promise an ineffective collapse');
  const active=screen().querySelector('.nav-subitem[aria-current="page"]');
  assert.ok(active,'the selected subcategory remains visible');
  assert.match(active.textContent||'',/Deadlines/);
  const inboxLock=byLabel('Inbox sections stay open while Work is selected') as HTMLButtonElement;
  assert.equal(inboxLock.disabled,true,'the parent arrow is honest about the active path staying visible');
  assert.ok(!sectionGroup().hasAttribute('hidden'),'the active path keeps the parent group visible');
});

void test('All inboxes is operable from the keyboard', async () => {
  await openDashboard();
  const button=navButton('All inboxes');
  // A real button is focusable and activates on Enter or Space with no extra wiring.
  assert.equal(button.tagName,'BUTTON');
  assert.ok(!button.hasAttribute('disabled'),'it is not disabled');
  assert.ok((button.getAttribute('tabindex')??'0')!=='-1','it stays in the tab order');
  button.focus();
  assert.equal(screen().ownerDocument.activeElement,button,'the row can hold focus');
});

void test('the combined selection is restored after a reload', async () => {
  await openDashboard();
  await click(navButton('All inboxes'));
  assert.equal(globalThis.localStorage.getItem('brief:selected-view:user-a'),'all',
    'the combined choice is remembered for this user');

  // Reload: the tree is discarded and rebuilt against the same browser storage.
  await unmountTree();
  const seen=stubFetch(defaultHandler);
  await render(createElement(Dashboard));
  await settle();
  assert.equal(subjects().length,4,'the combined view came back without being reselected');
  // The dashboard opens on Overview, so the restored scope shows in the account summary
  // rather than as a highlighted Inbox row.
  assert.equal(allByText('strong','All inboxes').length,1,'the combined scope is the active one');
  assert.ok(!seen.some(request=>request.url.includes('accountId=')),
    'the restored scope requests every mailbox');
  // Viewing everything must not quietly promote a different default account.
  assert.ok(!seen.some(request=>request.url.startsWith('/api/default-account')),
    'the default-account preference was left alone');
});

void test('the reply composer is bound to the mailbox that received the message', async () => {
  setupDom();
  stubFetch(defaultHandler);
  // Mounted directly: this is the component every reply goes through, and the conversation
  // panel it normally sits inside cannot be opened here (see the note in tests/dom.ts).
  await render(createElement(ReplyComposer,{email:secondAccountMail[0],demo:false,aiReady:true,onSent:()=>{}}));
  await settle();
  // The sending mailbox is the message's own account, stated before anything is sent, so
  // a reply written from the combined view can never leave from the wrong address.
  assert.equal(allByText('span','Sending as second@example.com').length,1,
    'the composer names the receiving mailbox rather than the combined scope');
  assert.equal(allByText('span','Sending as first@example.com').length,0,
    'and not the other connected mailbox');
});

// ── Guard: an unattributed message cannot act through a guessed mailbox ─────

/** A message that reached the browser without its mailbox, as a damaged cache would give. */
const unattributed={...firstAccountMail[0],accountId:undefined,accountEmail:undefined} as unknown as Email;

void test('a correction on an unattributed message is refused instead of guessed', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  await render(createElement(ClassificationDetail,{email:unattributed,demo:false,onApplied:()=>{}}));
  await settle();

  // The correction controls sit behind a disclosure, as they do for the user.
  await click(byText('button','Change category'));
  await click(byText('button',/Return to automatic classification/));
  // Nothing is sent: a correction with no account would be applied to whichever mailbox
  // the server resolved, which is exactly the mix-up this guard exists to prevent.
  assert.equal(seen.filter(request=>request.url.startsWith('/api/classification')).length,0,
    'no correction was submitted without an account');
  assert.ok(allByText('output',/Refresh your inbox/).length>0,
    'the user is told how to recover rather than shown a dead end');
});

/** A Noise message that offers a supported unsubscribe. */
function newsletter(over:Partial<Email>&{id:string}):Email{
  return mail({accountId:'acct-1',category:'noise',oneClick:true,
    unsubscribeCapability:'one-click',sender:'Daily News',address:'news@daily.example',
    subject:'Issue '+over.id,...over} as Partial<Email>&{id:string;accountId:string});
}

void test('an accepted unsubscribe explains itself and keeps the message on screen', async () => {
  setupDom();
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe'))
      return {capability:'one-click',outcome:'accepted',reason:'accepted',
        scope:'list',scopeDetail:'This request names the newsletter this message belongs to.'};
    return defaultHandler(url,body);
  });
  const item=newsletter({id:'n1',listId:'daily.news.example'});
  await render(createElement(NoiseList,{emails:[item],demo:false,onSelect:()=>{}}));
  await settle();

  await click(byText('button',/^Unsubscribe$/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe')).length,1);
  // The wording is the accepted notice, and it never claims the sender has acted.
  const shown=allByText('output',/accepted your unsubscribe request/);
  assert.equal(shown.length,1,'the outcome is explained beside the button');
  assert.ok(/existing emails will stay here/.test(shown[0].textContent||''));
  assert.ok(byText('button',/Issue n1|Daily News/),'the message is still listed');
  // Scope is available but tucked away, so it does not clutter the row.
  assert.equal(allByText('small',/names the newsletter/).length,0,'detail stays collapsed');
  await click(byText('button',/What does this cover\?/));
  assert.equal(allByText('small',/names the newsletter/).length,1,'and opens on request');
});

void test('a newsletter needing confirmation offers the page, never a success message', async () => {
  setupDom();
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe'))
      return {capability:'one-click',outcome:'action-required',reason:'confirmation-required',
        page:'https://news.list-manage.com/finish'};
    return defaultHandler(url,body);
  });
  await render(createElement(NoiseList,{emails:[newsletter({id:'n2',listId:'a.example'})],demo:false,onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Unsubscribe$/));
  await settle();
  const shown=allByText('output',/requires confirmation on its website/);
  assert.equal(shown.length,1);
  assert.equal(allByText('output',/accepted/).length,0,'nothing claims success for an unfinished request');
  const link=screen().querySelector('.unsubscribe-notice a') as HTMLAnchorElement|null;
  assert.equal(link?.getAttribute('href'),'https://news.list-manage.com/finish');
  assert.equal(link?.getAttribute('target'),'_blank');
});

void test('a sender with two newsletters gets no single control over both', async () => {
  setupDom();
  stubFetch(defaultHandler);
  const weekly=newsletter({id:'w1',listId:'weekly.news.example',subject:'Weekly digest'});
  const alerts=newsletter({id:'a1',listId:'alerts.news.example',subject:'Price alert'});
  await render(createElement(NoiseList,{emails:[weekly,alerts],demo:false,onSelect:()=>{}}));
  await settle();

  // Both messages share one sender, so a group-level button would imply it covered both.
  assert.equal(allByText('button',/^Unsubscribe$/).length,0,'no control on the group row');
  assert.ok(byText('p',/2 separate newsletters/),'and the reason is stated');
  await click(byLabel('Expand Daily News'));
  await settle();
  assert.equal(allByText('button',/Unsubscribe from this newsletter/).length,2,
    'each newsletter gets its own control');
});

void test('two messages from one newsletter keep a single control', async () => {
  setupDom();
  stubFetch(defaultHandler);
  const first=newsletter({id:'s1',listId:'same.news.example',subject:'Issue 1'});
  const second=newsletter({id:'s2',listId:'same.news.example',subject:'Issue 2'});
  await render(createElement(NoiseList,{emails:[first,second],demo:false,onSelect:()=>{}}));
  await settle();
  assert.equal(allByText('button',/^Unsubscribe$/).length,1,'one newsletter, one control');
  assert.equal(allByText('p',/separate newsletters/).length,0);
});

void test('unsubscribing does not open or collapse the sender group', async () => {
  setupDom();
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe'))return {capability:'one-click',outcome:'accepted',reason:'accepted'};
    return defaultHandler(url,body);
  });
  await render(createElement(NoiseList,{emails:[newsletter({id:'n3',listId:'x.example'})],demo:false,onSelect:()=>{}}));
  await settle();
  assert.equal(byLabel('Expand Daily News').getAttribute('aria-expanded'),'false');
  await click(byText('button',/^Unsubscribe$/));
  await settle();
  assert.equal(byLabel('Expand Daily News').getAttribute('aria-expanded'),'false',
    'the group is where it was left');
});

void test('demo mode makes no external request and says so', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  await render(createElement(NoiseList,{emails:[newsletter({id:'d1',listId:'demo.example'})],demo:true,onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Unsubscribe$/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe')).length,0,'nothing was submitted');
  assert.ok(allByText('output',/Demo only/).length>0,'and the notice says so plainly');
});

void test('the button reports its own state and blocks a second click', async () => {
  setupDom();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  let calls=0;
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe')){calls++;await held;return {capability:'one-click',outcome:'accepted',reason:'accepted'};}
    return defaultHandler(url,body);
  });
  await render(createElement(NoiseList,{emails:[newsletter({id:'b1',listId:'b.example'})],demo:false,onSelect:()=>{}}));
  await settle();

  const button=byText('button',/^Unsubscribe$/);
  assert.equal(button.getAttribute('aria-busy'),null,'at rest it is not busy');
  await click(button);
  const working=byText('button',/Unsubscribing…/);
  assert.equal(working.getAttribute('aria-busy'),'true','the state is announced, not only drawn');
  assert.ok((working as HTMLButtonElement).disabled,'and it cannot be pressed again');
  // A second attempt while the first is in flight never becomes a request.
  await click(working);
  assert.equal(calls,1,'one request, however many clicks');
  release();
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe')).length,1);
  assert.ok(allByText('output',/accepted your unsubscribe request/).length>0);
  assert.ok(byText('button',/Unsubscribe again/),'the control stays usable afterwards');
});

void test('switching to another mailbox drops a stale notice', async () => {
  setupDom();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe')){await held;return {capability:'one-click',outcome:'accepted',reason:'accepted'};}
    return defaultHandler(url,body);
  });
  const first=newsletter({id:'m-first',listId:'first.example',sender:'First Sender',address:'one@first.example'});
  const second=newsletter({id:'m-second',listId:'second.example',sender:'Second Sender',address:'two@second.example'});
  await render(createElement(NoiseList,{emails:[first],demo:false,onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Unsubscribe$/));

  // The account changes while the request is in flight, so the list is replaced.
  await rerender(createElement(NoiseList,{emails:[second],demo:false,onSelect:()=>{}}));
  await settle();
  release();
  await settle();
  // The answer belonged to a newsletter that is no longer shown, so it is not attached to
  // whatever now occupies that row. The server-side record was written regardless.
  assert.equal(allByText('output',/accepted your unsubscribe request/).length,0,
    'no notice is shown against the wrong newsletter');
  assert.ok(byText('strong',/Second Sender/),'the new mailbox is what is displayed');
});

void test('unsubscribing from an unattributed message is refused instead of guessed', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  const junk={...unattributed,category:'noise',oneClick:true,unsubscribe:'https://sender.example/unsubscribe'} as unknown as Email;
  await render(createElement(NoiseList,{emails:[junk],demo:false,onSelect:()=>{}}));
  await settle();

  await click(byText('button',/^Unsubscribe$/));
  assert.equal(seen.filter(request=>request.url.startsWith('/api/unsubscribe')).length,0,
    'no unsubscribe was submitted without an account');
  assert.ok(allByText('output',/Refresh your inbox/).length>0,'the message explains the fix');
});

// ── The Inbox section group ────────────────────────────────────────────────

const sectionGroup=()=>screen().querySelector('#nav-submenu-sections')!;

void test('the sidebar rests with Work, Personal and Noise tucked inside Inbox', async () => {
  await openDashboard();
  assert.ok(sectionGroup().hasAttribute('hidden'),'the three sections start out of the way');
  assert.equal(byLabel('Expand inbox sections').getAttribute('aria-expanded'),'false');

  await click(byLabel('Expand inbox sections'));
  assert.ok(!sectionGroup().hasAttribute('hidden'),'the arrow reveals them');
  for(const name of ['Work','Personal','Noise'])
    assert.ok(navButton(name),`${name} is reachable inside the group`);
  // Opening the group is browsing, not navigating: nothing became selected by it.
  assert.ok(!isActive(navButton('Work')));
  assert.ok(!isActive(navButton('Noise')));
  assert.deepEqual(subjects(),['First account personal mail','First account work mail'],
    'and the listed mail is unchanged');

  await click(byLabel('Collapse inbox sections'));
  assert.ok(sectionGroup().hasAttribute('hidden'),'it can be tucked away again');
});

void test('navigating from outside the menu opens the group it landed in', async () => {
  await openDashboard();
  assert.ok(sectionGroup().hasAttribute('hidden'),'the group starts closed');
  // The page's own "Review & unsubscribe" link jumps straight to Noise. A collapsed group
  // would hide the row it selected, leaving nothing on screen marked as current.
  await click(byText('button',/Review & unsubscribe/));
  assert.ok(!sectionGroup().hasAttribute('hidden'),'the group opened to show the destination');
  assert.ok(isActive(navButton('Noise')),'and Noise is marked as the current view');
});

// ── The list cut-off ───────────────────────────────────────────────────────

/** Distinct senders, so no two messages fold into one grouped row. */
function manyEmails(count:number){
  return Array.from({length:count},(_,i)=>mail({id:`m${i}`,accountId:'acct-1',
    subject:`Numbered message ${i}`,address:`s${i}@s${i}.example`}));
}
const listedSubjects=()=>allByText('h3',/^Numbered message/).length;

void test('a long mailbox is cut off and extends on request', async () => {
  setupDom();
  stubFetch(defaultHandler);
  await render(createElement(PriorityEmailList,{emails:manyEmails(60),now:Date.now(),busy:false,
    emptyTitle:'All clear.',emptyBody:'Nothing here.',onSelect:()=>{}}));
  await settle();

  // Only the first page is laid out; the rest is present in the data but not rendered.
  assert.equal(listedSubjects(),25,'the list stops at the first page');
  assert.ok(allByText('span','35 not shown').length===1,'the remainder is stated precisely');

  await click(byText('button',/Show additional conversations/));
  assert.equal(listedSubjects(),50,'a request extends the list by one page');
  assert.ok(allByText('span','10 not shown').length===1,'the remainder is updated');

  await click(byText('button',/Show additional conversations/));
  assert.equal(listedSubjects(),60,'the final page shows everything that is left');
  assert.equal(allByText('button',/Show additional conversations/).length,0,
    'and the control disappears once nothing is left to show');
});

void test('a mailbox that fits is shown whole with no cut-off', async () => {
  setupDom();
  stubFetch(defaultHandler);
  await render(createElement(PriorityEmailList,{emails:manyEmails(25),now:Date.now(),busy:false,
    emptyTitle:'All clear.',emptyBody:'Nothing here.',onSelect:()=>{}}));
  await settle();
  assert.equal(listedSubjects(),25,'every message is listed');
  assert.equal(allByText('button',/Show additional conversations/).length,0,
    'nothing invites the user to expand a list that is already complete');
});

void test('expanded folded mail labels each message by its own live importance',async()=>{
  const now=Date.UTC(2026,8,24,12);
  const baseClassification:Omit<Classification,'obligations'>={context:'work',topics:[],disposition:'useful',replyRequired:false,
    securityEvent:false,processingStatus:'classified',reason:'test',version:'test'};
  const routine=mail({id:'routine-code',accountId:'acct-1',sender:'GitHub',address:'noreply@github.com',
    // Five days old: inside the week a topic fold spans, and no longer Important.
    subject:'Old GitHub verification code',receivedAt:now-5*86400000,priority:'high',
    classification:{...baseClassification,obligations:[]}});
  const urgent=mail({id:'urgent-setup',accountId:'acct-1',sender:'GitHub',address:'security@github.com',
    subject:'Complete your GitHub two-factor setup',receivedAt:now-3600000,
    classification:{...baseClassification,obligations:[{id:'due',kind:'deadline',description:'Complete setup',
      owner:'you',ownerIsUser:true,required:true,evidence:'Complete setup today',state:'open',
      due:{phrase:'today',time:new Date(now+3600000).toISOString(),ambiguous:false}}]}});
  setupDom();
  stubFetch(defaultHandler);
  await render(createElement(PriorityEmailList,{emails:[routine,urgent],now,busy:false,
    emptyTitle:'All clear.',emptyBody:'Nothing here.',onSelect:()=>{}}));
  await settle();
  await click(screen().querySelector('.fold-expand')!);
  const rows=[...screen().querySelectorAll('.folded-email')];
  const old=rows.find(row=>(row.textContent||'').includes(routine.subject))!;
  const current=rows.find(row=>(row.textContent||'').includes(urgent.subject))!;
  assert.equal(old.querySelectorAll('.mail-label.important').length,0,'the old code is not called Important');
  assert.equal(current.querySelectorAll('.mail-label.important').length,1,'the live deadline is called Important');
});

void test('changing view restarts the list rather than inheriting its extent', async () => {
  // A mailbox large enough to be cut off, so the extent is observable rather than assumed.
  const bulk=manyEmails(60);
  await openDashboard({handler:(url,body)=>{
    if(url.startsWith('/api/connection'))return connection;
    if(url.startsWith('/api/mailbox')||url.startsWith('/api/sync'))return snapshot(bulk);
    return defaultHandler(url,body);
  }});
  await click(navButton('Inbox'));
  assert.equal(listedSubjects(),25,'the inbox starts at one page');

  await click(byText('button',/Show additional conversations/));
  assert.equal(listedSubjects(),50,'the user extended this view');

  // Leave for another view and return. The extent belonged to the previous selection.
  await click(byLabel('Expand inbox sections'));
  await click(navButton('Work'));
  assert.equal(listedSubjects(),25,'the new view starts at the top');

  await click(navButton('Inbox'));
  assert.equal(listedSubjects(),25,'and returning does not restore the old extent');
});

// ── Calendar ranges and the month day popup ────────────────────────────────

/** A dated message: the calendar reads dates out of the subject and body. */
function datedMail(id:string,subject:string,body:string,receivedAt:number,classification?:unknown){
  return {...mail({id,accountId:'acct-1',subject,address:`${id}@${id}.example`}),
    body,receivedAt,classification} as unknown as Email;
}

/** A due time on an obligation is the only clock time the calendar can order by. */
const timed=(iso:string)=>({context:'work',topics:[],disposition:'useful',replyRequired:false,
  securityEvent:false,processingStatus:'classified',reason:'test',version:'test',
  obligations:[{id:'o1',kind:'meeting',description:'Meeting',owner:'recipient',ownerIsUser:true,
    required:true,evidence:'e',state:'open',due:{phrase:'2026-10-14',date:'2026-10-14',time:iso}}]});

const calendarMail=[
  // All three fall on the same day so the popup has something to order.
  datedMail('late','Afternoon review','Scheduled for 2026-10-14.',10,timed('2026-10-14T15:30:00')),
  datedMail('early','Morning standup','Scheduled for 2026-10-14.',20,timed('2026-10-14T09:00:00')),
  datedMail('untimed','Budget paperwork','Due 2026-10-14.',5),
  datedMail('other','Different day','Scheduled for 2026-10-20.',30),
];

/** Switches range through the heading picker, the way the card offers it. */
async function chooseRange(name:string){
  await click(screen().querySelector('.calendar-range')!);
  const menu=screen().querySelector('.calendar-range-menu')!;
  const option=[...menu.querySelectorAll('button')].find(button=>(button.textContent||'').trim()===name);
  assert.ok(option,`the range menu offers ${name}`);
  await click(option);
}

async function openCalendar(){
  setupDom();
  stubFetch(defaultHandler);
  await render(createElement(WeekCalendar,{emails:calendarMail,demo:false,onSelect:()=>{}}));
  await settle();
}

void test('the calendar rests on the week and changes range from one small control', async () => {
  await openCalendar();
  // The resting card is the week view as it was before the other ranges existed: the
  // seven day buttons, the "This week" heading, and no range controls competing with them.
  assert.ok(screen().querySelector('.week-calendar-days'),'the week strip is shown');
  assert.ok(!screen().querySelector('.calendar-month'),'the month grid is not');
  assert.equal(allByText('h2',/This week/).length,1,'the original heading is kept');
  // The heading itself is the control, so nothing extra sits beside it.
  const heading=screen().querySelector('.calendar-range')!;
  assert.equal(heading.tagName,'BUTTON','the heading can be pressed');
  assert.equal((heading.textContent||'').trim(),'This week','and still reads as the heading');
  assert.equal(heading.getAttribute('aria-expanded'),'false');
  assert.equal(screen().querySelectorAll('.calendar-nav').length,1,
    'with a stepper beside it');
  // The choices stay out of sight until asked for.
  assert.equal(screen().querySelectorAll('.calendar-range-menu').length,0);

  await chooseRange('Month');
  assert.equal(screen().querySelectorAll('.calendar-range-menu').length,0,'choosing closes the menu');
  // The heading now names the month it is showing rather than the week.
  assert.equal(allByText('h2',/This week/).length,0,'the week heading is gone');
  assert.match((screen().querySelector('.calendar-range')!.textContent||'').trim(),/^\w+ 20\d{2}$/,
    'and reads as a month and year');
  assert.ok(screen().querySelector('.calendar-month'),'the month grid replaced the week strip');
  // A month of subjects cannot fit the card, so the running agenda gives way to the grid.
  assert.ok(!screen().querySelector('.calendar-agenda'),'the day list is not shown under a month');
  // Whole weeks only, so every row of the grid is complete.
  const cells=screen().querySelectorAll('.calendar-month-grid button').length;
  assert.equal(cells%7,0,'the grid holds complete weeks');

  await chooseRange('Day');
  assert.ok(screen().querySelector('.calendar-agenda'),'a single day lists its mail directly');
  assert.ok(!screen().querySelector('.week-calendar-days'),'without the week strip');
  // The heading shares its line with the stepper, so the weekday is abbreviated here. The
  // agenda underneath still spells the day out, so nothing is lost by shortening it.
  assert.match((screen().querySelector('.calendar-range')!.textContent||'').trim(),
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w{3} \d{1,2}$/,'the day heading stays short');
  assert.equal(screen().querySelectorAll('.calendar-nav').length,1,'and the stepper sits beside it');
  assert.match((screen().querySelector('.calendar-agenda h3')!.textContent||'').trim(),
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), /,'the full day is still shown');

  await chooseRange('Week');
  assert.ok(screen().querySelector('.week-calendar-days'),'and it returns to the week unchanged');
  assert.equal(allByText('h2',/This week/).length,1);
});

void test('a day in the month grid opens its events in chronological order', async () => {
  await openCalendar();
  await chooseRange('Month');
  // Walk to October 2026, where the fixtures are dated.
  for(let guard=0;guard<240&&allByText('h2',/October 2026/).length===0;guard++)
    await click(byLabel('Next month'));
  assert.equal(allByText('h2',/October 2026/).length,1,'the grid reached October 2026');

  assert.equal(screen().querySelectorAll('.calendar-popup').length,0,'no day is open yet');
  await click(byLabel(/^Wednesday, October 14,/));

  const popup=screen().querySelector('.calendar-popup')!;
  assert.ok(popup,'clicking a date opens that day');
  const bullets=[...popup.querySelectorAll('.calendar-agenda-summary')].map(node=>(node.textContent||'').trim());
  // One bullet per event, earliest clock time first; the undated one follows the timed.
  assert.deepEqual(bullets,['Morning standup','Afternoon review','Budget paperwork']);
  assert.deepEqual([...popup.querySelectorAll('.calendar-agenda-time')].map(node=>node.textContent),['9:00 AM','3:30 PM']);
  // Only that day's events, never the whole month.
  assert.ok(!bullets.includes('Different day'),'another day’s event is not listed');

  await click(byLabel('Close day'));
  assert.equal(screen().querySelectorAll('.calendar-popup').length,0,'the day can be dismissed');
});

void test('a month day with nothing scheduled says so rather than showing nothing', async () => {
  await openCalendar();
  await chooseRange('Month');
  for(let guard=0;guard<240&&allByText('h2',/October 2026/).length===0;guard++)
    await click(byLabel('Next month'));
  assert.equal(allByText('h2',/October 2026/).length,1,'the grid reached October 2026');
  await click(byLabel(/^Thursday, October 15,/));
  const popup=screen().querySelector('.calendar-popup')!;
  assert.equal(popup.querySelectorAll('li').length,0);
  assert.match(popup.textContent||'',/No events on this day/);
});

void test('the week steps forwards and back', async () => {
  await openCalendar();
  const dayNumbers=()=>[...screen().querySelectorAll('.week-calendar-days strong')].map(node=>node.textContent);
  assert.equal(allByText('h2',/This week/).length,1,'it opens on the current week');
  const current=dayNumbers();
  assert.equal(current.length,7);

  await click(byLabel('Next week'));
  // The heading stops claiming the current week and names the one being shown instead,
  // so a reader who has stepped away is never misled about where they are.
  assert.equal(allByText('h2',/This week/).length,0);
  assert.match((screen().querySelector('.calendar-range')!.textContent||'').trim(),
    /^\w{3} \d{1,2} – \w{3} \d{1,2}$/,'the heading names the week on screen');
  assert.notDeepEqual(dayNumbers(),current,'a different seven days are shown');

  await click(byLabel('Previous week'));
  assert.deepEqual(dayNumbers(),current,'stepping back returns to where it started');
  assert.equal(allByText('h2',/This week/).length,1,'and says so again');

  await click(byLabel('Previous week'));
  assert.equal(allByText('h2',/This week/).length,0,'it moves into the past as well');
  assert.notDeepEqual(dayNumbers(),current);
});

void test('agenda bullets expand in place and the arrow still opens the message', async () => {
  setupDom();
  stubFetch(defaultHandler);
  const opened:string[]=[];
  // A day with mail, reached through the week strip the card opens on.
  await render(createElement(WeekCalendar,{emails:calendarMail,demo:false,
    onSelect:(email:Email)=>{opened.push(email.id);}}));
  await settle();
  await chooseRange('Month');
  for(let guard=0;guard<240&&allByText('h2',/October 2026/).length===0;guard++)
    await click(byLabel('Next month'));
  await click(byLabel(/^Wednesday, October 14,/));

  const bullets=()=>[...screen().querySelectorAll('.calendar-agenda-summary')] as HTMLElement[];
  assert.equal(bullets().length,3,'one bullet per event');
  // Each bullet carries the subject alone: the sender and summary stay out of the way
  // until asked for, which is what keeps a busy day readable.
  assert.equal(bullets()[0].textContent,'Morning standup');
  assert.equal(screen().querySelectorAll('.calendar-agenda-detail').length,0,'nothing is expanded yet');

  await click(bullets()[0]);
  assert.equal(bullets()[0].getAttribute('aria-expanded'),'true');
  const detail=screen().querySelector('.calendar-agenda-detail')!;
  assert.ok((detail.textContent||'').includes(calendarMail[1].sender),'the sender is revealed');
  assert.deepEqual(opened,[],'expanding a bullet does not open the message');

  // Only one at a time, so the list cannot grow back into a wall of text.
  await click(bullets()[1]);
  assert.equal(screen().querySelectorAll('.calendar-agenda-detail').length,1);
  assert.equal(bullets()[0].getAttribute('aria-expanded'),'false');

  await click(bullets()[1]);
  assert.equal(screen().querySelectorAll('.calendar-agenda-detail').length,0,'and it closes again');

  // The arrow is the way into the message itself.
  await click(byLabel('Open Morning standup'));
  assert.deepEqual(opened,['early'],'the arrow opened that message');
});

void test('agenda disclosures have unique ids even when sanitised email keys would collide',async()=>{
  const identities=[['acct-1','m1'],['acct','1m1'],['acct-1','m-1'],['acct1','m1']];
  const colliding=identities.map(([accountId,id],index)=>({...datedMail(id,`Collision ${index}`,
    'Scheduled for 2026-10-14.',index+1),accountId}));
  setupDom();
  stubFetch(defaultHandler);
  await render(createElement(WeekCalendar,{emails:colliding,demo:false,onSelect:()=>{}}));
  await settle();
  await chooseRange('Month');
  for(let guard=0;guard<240&&allByText('h2',/October 2026/).length===0;guard++)
    await click(byLabel('Next month'));
  await click(byLabel(/^Wednesday, October 14,/));
  const controls=[...screen().querySelectorAll('.calendar-agenda-summary')].map(node=>node.getAttribute('aria-controls'));
  assert.equal(controls.length,4);
  assert.equal(new Set(controls).size,4,'every disclosure controls only its own detail panel');
});

// ── Sender junk controls in the reader ─────────────────────────────────────

const senderEmail=(over:Partial<Email>={})=>mail({id:'s1',accountId:'acct-1',
  subject:'Pulse Survey',address:'communications@berkeley.edu',
  accountEmail:'first@example.com',correctionRevision:0,senderRuleRevision:0,...over});

/** Renders the control alone, which is how it behaves inside the reader's action row. */
async function openControl(email:Email,handler?:Handler,demo=false){
  setupDom();
  const seen=stubFetch(handler??defaultHandler);
  const applied:Email[]=[];
  const refreshes:number[]=[];
  await render(createElement(SenderJunkButton,{email,demo,
    onApplied:(next:Email)=>{applied.push(next);},
    onRefresh:async()=>{refreshes.push(1);return true;}}));
  await settle();
  return {seen,applied,refreshes};
}
const control=()=>screen().querySelector('.sender-junk-button') as HTMLButtonElement;

void test('the reader offers Mark sender as junk, and confirms before saving', async () => {
  const {seen}=await openControl(senderEmail());
  assert.equal(control().getAttribute('aria-label'),'Mark sender as junk');
  assert.equal(screen().querySelectorAll('.sender-junk-state').length,0,'nothing claims a rule exists yet');

  // Pressing it opens a confirmation rather than saving. The dialog's own contents cannot
  // be rendered in this harness (see tests/dom.ts), so what is asserted here is the part
  // that matters most: nothing is written until the reader confirms.
  await click(control());
  assert.equal(seen.filter(r=>r.url.startsWith('/api/classification')).length,0,
    'opening the confirmation saves nothing');
  assert.equal(control().getAttribute('aria-expanded'),null);
});

/**
 * Drives the shared hook directly. The confirmation dialog cannot be opened in this
 * harness, so the save it guards is exercised here instead — through the same code path
 * the dialog's confirm button calls.
 */
function HookProbe({email,demo,onApplied,onRefresh,record}:{email:Email;demo:boolean;
  onApplied:(email:Email)=>void;onRefresh?:()=>Promise<boolean>;record:(outcome:unknown)=>void}){
  const rule=useSenderRule({email,demo,onApplied,onRefresh});
  return createElement('div',null,
    createElement('button',{type:'button','data-probe':'mark',
      onClick:()=>{void rule.markJunk().then(record);}},'probe mark'),
    createElement('button',{type:'button','data-probe':'clear',
      onClick:()=>{void rule.clearRule().then(record);}},'probe clear'),
    createElement('span',{'data-probe':'notice'},rule.notice?.text??''),
  );
}

async function probe(email:Email,options:{handler?:Handler;demo?:boolean;refresh?:()=>Promise<boolean>}={}){
  setupDom();
  const seen=stubFetch(options.handler??defaultHandler);
  const applied:Email[]=[];const outcomes:unknown[]=[];
  await render(createElement(HookProbe,{email,demo:options.demo??false,
    onApplied:(next:Email)=>{applied.push(next);},onRefresh:options.refresh,
    record:(outcome:unknown)=>{outcomes.push(outcome);}}));
  await settle();
  const press=async(name:string)=>{await click(screen().querySelector(`[data-probe=${name}]`)!);};
  const notice=()=>screen().querySelector('[data-probe=notice]')!.textContent||'';
  return {seen,applied,outcomes,press,notice};
}

void test('marking sends the sender action with both revisions and refreshes once', async () => {
  let refreshes=0;
  const run=await probe(senderEmail({correctionRevision:3,senderRuleRevision:7}),
    {refresh:async()=>{refreshes++;return true;}});
  await run.press('mark');
  assert.equal(refreshes,1,'the cached mailbox is re-read exactly once');
  const save=run.seen.find(r=>r.url==='/api/classification');
  assert.ok(save,'the save was submitted');
  assert.equal(save.body?.accountId,'acct-1','targeting the mailbox that received it');
  assert.equal(save.body?.messageId,'s1');
  assert.equal(save.body?.expectedRevision,3,'the message revision is sent');
  assert.equal(save.body?.expectedSenderRevision,7,'and the sender revision');
  assert.deepEqual(save.body?.action,{type:'set-sender-junk-preference',value:'junk'});
  assert.equal(run.applied.length,1,'the returned message is merged');
  assert.match(run.notice(),/Sender marked as junk\./);
  assert.deepEqual(run.outcomes,[{ok:true,revision:8,previous:undefined}],
    'the new revision is reported so a temporary Undo can reverse exactly this change');
});

void test('a successful save whose refresh fails says so without repeating the save', async () => {
  const run=await probe(senderEmail(),{refresh:async()=>false});
  await run.press('mark');
  assert.equal(run.seen.filter(r=>r.url==='/api/classification').length,1,'the save ran exactly once');
  assert.match(run.notice(),/could not be refreshed/,'and the failure is described as the refresh');
});

void test('a temporary Undo reverses exactly the change it was offered for', async () => {
  // Marking a sender that already had a Keep preference must restore that preference,
  // not merely clear the rule, and must be ordered against the revision it just created.
  const run=await probe(senderEmail({senderJunkPreference:'not-junk',senderRuleRevision:4}));
  await run.press('mark');
  const outcome=run.outcomes[0] as {ok:true;revision:number;previous?:string};
  assert.equal(outcome.previous,'not-junk','the preference in place beforehand is remembered');
  assert.equal(outcome.revision,5,'along with the revision the save produced');
});

void test('an active rule shows a permanent Undo that clears it', async () => {
  const {seen,refreshes}=await openControl(senderEmail({senderJunkPreference:'junk',senderRuleRevision:2}));
  // Active state comes from the saved preference, not from the message being in Noise.
  assert.equal(control().getAttribute('aria-label'),'Undo sender junk');
  assert.match(screen().textContent||'',/This sender is marked as junk\./);

  await click(control());
  const save=seen.find(r=>r.url==='/api/classification');
  assert.deepEqual(save?.body?.action,{type:'clear-sender-junk-preference'},'undo clears, with no second confirmation');
  assert.equal(save?.body?.expectedSenderRevision,2);
  assert.equal(refreshes.length,1);
  assert.match(screen().textContent||'',/Automatic sorting and message-specific corrections apply again/);
});

void test('a message already in Noise is not mistaken for a saved rule', async () => {
  // Automatic junk classification and a confirmed sender rule are different states, and
  // only the second one has anything to undo.
  await openControl(senderEmail({category:'noise'}));
  assert.equal(control().getAttribute('aria-label'),'Mark sender as junk');
});

void test('a failed save leaves the rule as it was and stays retryable', async () => {
  const failing:Handler=(url,body)=>url.startsWith('/api/classification')
    ? (()=>{throw new Error('boom');})() : defaultHandler(url,body);
  const {applied,refreshes}=await openControl(senderEmail({senderJunkPreference:'junk',senderRuleRevision:2}),failing);
  await click(control());
  assert.equal(applied.length,0,'nothing was merged');
  assert.equal(refreshes.length,0,'and no refresh was claimed');
  assert.equal(control().getAttribute('aria-label'),'Undo sender junk','the rule still reads as active');
  assert.ok(!control().disabled,'and the control is usable again');
});

void test('the demo workspace saves nothing', async () => {
  const {seen}=await openControl(senderEmail(),undefined,true);
  await click(control());
  assert.equal(seen.filter(r=>r.url==='/api/classification').length,0,'no mutation is attempted');
  assert.match(screen().textContent||'',/Connect Gmail to save sender preferences/);
});

void test('the permanent Undo survives a remount and works from another message', async () => {
  // Nothing is remembered in component state: the control reads the saved preference that
  // arrives with every message, so it is there after a reload or a later visit.
  const marked=senderEmail({senderJunkPreference:'junk',senderRuleRevision:3});
  await openControl(marked);
  assert.equal(control().getAttribute('aria-label'),'Undo sender junk');
  teardownDom();

  // A different message from the same sender in the same account offers the same Undo.
  const sibling=senderEmail({id:'s2',senderJunkPreference:'junk',senderRuleRevision:3});
  const {seen}=await openControl(sibling);
  assert.equal(control().getAttribute('aria-label'),'Undo sender junk');
  await click(control());
  const save=seen.find(r=>r.url==='/api/classification');
  assert.equal(save?.body?.messageId,'s2','the request is made from the message in hand');
  assert.equal(save?.body?.expectedSenderRevision,3,'against the rule revision it was shown');
});

void test('a second press cannot start a second save', async () => {
  // The rendered disabled state and a synchronous guard both apply, because React state
  // updates are asynchronous and two fast clicks can otherwise both get through.
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const slow:Handler=async(url,body)=>{
    if(url.startsWith('/api/classification'))await held;
    return defaultHandler(url,body);
  };
  const {seen}=await openControl(senderEmail({senderJunkPreference:'junk',senderRuleRevision:1}),slow);
  await click(control());
  assert.equal(control().disabled,true,'the control reports itself busy');
  assert.equal(control().getAttribute('aria-label'),'Undoing…');
  await click(control());
  await click(control());
  release();
  await settle();
  assert.equal(seen.filter(r=>r.url==='/api/classification').length,1,'exactly one save was sent');
});

void test('the control is reachable and operable from the keyboard', async () => {
  await openControl(senderEmail());
  const button=control();
  assert.equal(button.tagName,'BUTTON','a real button, so Enter and Space work unaided');
  assert.ok(!button.hasAttribute('disabled'));
  assert.ok((button.getAttribute('tabindex')??'0')!=='-1','it stays in the tab order');
  button.focus();
  assert.equal(screen().ownerDocument.activeElement,button,'and it can hold focus');
  // The visible text shortens on a narrow screen, so the name is stated independently.
  assert.equal(button.getAttribute('aria-label'),'Mark sender as junk');
  assert.ok((button.textContent||'').includes('Mark sender as junk'),'the full label is present at wide widths');
});

void test('the reader declares one close control, not two', () => {
  // The sheet's built-in close button is switched off for this sheet, and its SheetClose
  // primitive is rendered in the action row instead. The sheet itself cannot be opened in
  // this harness, so what is checked is that the page never asks for both.
  const source=readFileSync(`${process.cwd()}/app/page.tsx`,'utf8');
  assert.match(source,/showCloseButton=\{false\}/,'the built-in close button is disabled for this sheet');
  assert.equal(source.match(/<SheetClose\b/g)?.length,1,'and exactly one SheetClose is rendered');
  assert.match(source,/<SheetClose[^>]*aria-label="Close"/,'carrying an accessible name');
  assert.match(source,/className="email-sheet-actions"/,'inside the reader action row');
  // Other sheets keep their own close button.
  assert.equal(source.match(/showCloseButton=/g)?.length,1,'no other sheet is changed');
});

// ── Blocking senders without a verified unsubscribe ─────────────────────────

/** Tests of what a block does skip the question, as "Don't ask me again" would. */
function skipQuestion(){globalThis.localStorage.setItem('brief-skip-block-confirm:user-a','true');}

void test('a sender without a verified unsubscribe gets Block sender, which hides it after one click', async () => {
  setupDom();
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/block'))return {accountId:'acct-1',address:'promo@shop.example',blocked:true};
    return defaultHandler(url,body);
  });
  const promo=newsletter({id:'p1',oneClick:false,unsubscribeCapability:'manual-page',sender:'Shop',address:'promo@shop.example'});
  let reloads=0;
  skipQuestion();
  await render(createElement(NoiseList,{emails:[promo],demo:false,user:'user-a',onSelect:()=>{},
    onBlockChanged:async()=>{reloads++;return true;}}));
  await settle();

  assert.equal(allByText('button',/Unsubscribe/).length,0,'no unsubscribe button for an unverified sender');
  await click(byText('button',/^Block sender$/));
  await settle();
  const sent=seen.filter(r=>r.url.startsWith('/api/block'));
  assert.equal(sent.length,1);
  assert.deepEqual(sent[0].body,{accountId:'acct-1',address:'promo@shop.example',name:'Shop',blocked:true});
  assert.equal(reloads,1,'the mailbox is re-read so the sender leaves the list');
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe')).length,0,'the sender is never contacted');

  // A short notice confirms the block, and stays even though the row is gone.
  assert.equal(allByText('output',/Blocked Shop/).length,1,'a notice confirms the block');
  await click(byText('button',/^Undo$/));
  await settle();
  assert.deepEqual(seen.filter(r=>r.url.startsWith('/api/block'))[1]?.body,
    {accountId:'acct-1',address:'promo@shop.example',blocked:false},'Undo unblocks the same sender');
  assert.equal(allByText('output',/Blocked Shop/).length,0,'and the notice goes away');
});

void test('the block notice can be dismissed', async () => {
  setupDom();
  stubFetch(async(url,body)=>url.startsWith('/api/block')?{blocked:true}:defaultHandler(url,body));
  skipQuestion();
  await render(createElement(NoiseList,{emails:[newsletter({id:'p2',oneClick:false,sender:'Shop'})],demo:false,
    user:'user-a',onSelect:()=>{},onBlockChanged:async()=>true}));
  await settle();
  await click(byText('button',/^Block sender$/));
  await settle();
  await click(byLabel('Dismiss'));
  assert.equal(allByText('output',/Blocked Shop/).length,0);
});

void test('a verified newsletter keeps one-click Unsubscribe, and a failed one offers Block instead', async () => {
  setupDom();
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe'))return {capability:'one-click',outcome:'unknown',reason:'uncertain'};
    if(url.startsWith('/api/block'))return {blocked:true};
    return defaultHandler(url,body);
  });
  skipQuestion();
  await render(createElement(NoiseList,{emails:[newsletter({id:'v1',listId:'v.example'})],demo:false,user:'user-a',onSelect:()=>{},
    onBlockChanged:async()=>true}));
  await settle();
  assert.equal(allByText('button',/^Block sender$/).length,0,'a verified newsletter is unsubscribed, not blocked');
  await click(byText('button',/^Unsubscribe$/));
  await settle();
  await click(byText('button',/Block sender instead/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/block')).length,1);
});

void test('an accepted unsubscribe does not suggest blocking', async () => {
  setupDom();
  stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe'))return {capability:'one-click',outcome:'accepted',reason:'accepted'};
    return defaultHandler(url,body);
  });
  await render(createElement(NoiseList,{emails:[newsletter({id:'v2',listId:'w.example'})],demo:false,onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Unsubscribe$/));
  await settle();
  assert.equal(allByText('button',/Block sender instead/).length,0);
});

void test('blocked senders are listed and can be unblocked', async () => {
  setupDom();
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/block'))return {blocked:false};
    return defaultHandler(url,body);
  });
  let reloads=0;
  await render(createElement(NoiseList,{emails:[],demo:false,onSelect:()=>{},onBlockChanged:async()=>{reloads++;return true;},
    blocked:[{accountId:'acct-1',accountEmail:'me@example.com',address:'promo@shop.example',name:'Shop',created:1}]}));
  await settle();
  assert.ok(byText('p',/hidden here, not deleted/),'the list says nothing was deleted');
  await click(byLabel('Unblock Shop'));
  await settle();
  const sent=seen.filter(r=>r.url.startsWith('/api/block'));
  assert.deepEqual(sent[0]?.body,{accountId:'acct-1',address:'promo@shop.example',blocked:false});
  assert.equal(reloads,1);
});

void test('blocking in the demo sends nothing', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  skipQuestion();
  await render(createElement(NoiseList,{emails:[newsletter({id:'d1',oneClick:false})],demo:true,user:'user-a',onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Block sender$/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/block')).length,0);
  assert.ok(allByText('output',/Demo only/).length>0);
});

void test('Block sender asks first, and sends nothing until confirmed', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  await render(createElement(NoiseList,{emails:[newsletter({id:'q1',oneClick:false,sender:'Shop'})],demo:false,
    user:'user-a',onSelect:()=>{},onBlockChanged:async()=>true}));
  await settle();
  // The question itself is a dialog, which this harness cannot render (see tests/dom.ts);
  // what matters most is that pressing the button alone blocks nothing.
  await click(byText('button',/^Block sender$/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/block')).length,0,'nothing is blocked before confirming');
  assert.equal(allByText('output',/Blocked Shop/).length,0);
});

void test('the question explains blocking and offers Don’t ask me again', async () => {
  setupDom();
  const ticks:boolean[]=[];
  await render(createElement(BlockConfirmFields,{dontAsk:false,onDontAskChange:(value:boolean)=>{ticks.push(value);}}));
  const text=screen().textContent||'';
  for(const phrase of [/hidden in Gmail Hub/,/Nothing is deleted/,/sender isn’t told/,/unblock them anytime/])
    assert.ok(phrase.test(text),`the explanation says ${String(phrase)}`);
  await click(screen().querySelector('input[type=checkbox]') as HTMLElement);
  assert.deepEqual(ticks,[true],'ticking the box reports the choice');
  assert.ok(byText('label',/Don’t ask me again/));
});

void test('someone who chose not to be asked can turn the question back on', async () => {
  setupDom();
  stubFetch(defaultHandler);
  skipQuestion();
  await render(createElement(NoiseList,{emails:[],demo:false,user:'user-a',onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Ask me again$/));
  assert.equal(globalThis.localStorage.getItem('brief-skip-block-confirm:user-a'),null);
  assert.equal(allByText('button',/^Ask me again$/).length,0);
});

void test('one person’s Don’t ask again does not apply to another', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  skipQuestion();
  await render(createElement(NoiseList,{emails:[newsletter({id:'q2',oneClick:false})],demo:false,user:'user-b',onSelect:()=>{}}));
  await settle();
  await click(byText('button',/^Block sender$/));
  await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/block')).length,0,'user-b is still asked');
});

void test('newsletter state and running requests are isolated across accounts',async()=>{
  setupDom();
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const seen=stubFetch(async(url,body)=>{
    if(url.startsWith('/api/unsubscribe')){
      if(body?.accountId==='acct-1')await held;
      return {capability:'one-click',outcome:'accepted',reason:'accepted'};
    }
    return defaultHandler(url,body);
  });
  await render(createElement(NoiseList,{emails:[newsletter({id:'same',accountId:'acct-1',listId:'shared.example'}),
    newsletter({id:'same',accountId:'acct-2',listId:'shared.example'})],demo:false,onSelect:()=>{}}));
  const buttons=allByText('button',/^Unsubscribe$/);
  await click(buttons[0]);
  assert.equal((buttons[1] as HTMLButtonElement).disabled,false);
  await click(buttons[1]);await settle();
  assert.equal(allByText('output',/accepted your unsubscribe request/).length,1);
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe')).length,2);
  release();await settle();
  assert.equal(allByText('output',/accepted your unsubscribe request/).length,2);
});

void test('newsletter group chooses an older verified message and confirms uncertain retries',async()=>{
  setupDom();
  const seen=stubFetch(async(url,body)=>url.startsWith('/api/unsubscribe')
    ?{capability:'one-click',outcome:'unknown',reason:'uncertain'}:defaultHandler(url,body));
  await render(createElement(NoiseList,{emails:[newsletter({id:'new',listId:'same.example',oneClick:false}),
    newsletter({id:'verified',listId:'same.example',oneClick:true})],demo:false,onSelect:()=>{}}));
  await click(byText('button',/^Unsubscribe$/));await settle();
  assert.equal(seen.find(r=>r.url.startsWith('/api/unsubscribe'))?.body?.id,'verified');
  await click(byText('button',/I checked — retry unsubscribe/));await settle();
  assert.equal(seen.filter(r=>r.url.startsWith('/api/unsubscribe'))[1].body?.confirmRetry,true);
});

void test('switching signed-in users resets the block-confirmation preference display',async()=>{
  setupDom();stubFetch(defaultHandler);
  const props={emails:[newsletter({id:'news',oneClick:false})],demo:false,onSelect:()=>{}};
  globalThis.localStorage.setItem('brief-skip-block-confirm:first-user','true');
  await render(createElement(NoiseList,{...props,user:'first-user'}));
  assert.ok(allByText('button',/Ask me again/).length);
  await rerender(createElement(NoiseList,{...props,user:'second-user'}));await settle();
  assert.equal(allByText('button',/Ask me again/).length,0);
});

// ── Audit 2026-09-29, section 3: Noise controls ───────────────────────────────

void test('one running unsubscribe labels only its own button', async () => {
  setupDom();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  stubFetch(async (url, body) => {
    if (url.startsWith('/api/unsubscribe')) { await held; return { capability: 'one-click', outcome: 'accepted', reason: 'accepted' }; }
    return defaultHandler(url, body);
  });
  await render(createElement(NoiseList, { emails: [
    newsletter({ id: 'a', sender: 'Alpha', address: 'a@alpha.example', listId: 'a.list' }),
    newsletter({ id: 'b', sender: 'Beta', address: 'b@beta.example', listId: 'b.list' }),
    newsletter({ id: 'c', sender: 'Gamma', address: 'c@gamma.example', oneClick: false, unsubscribeCapability: 'none' }),
  ], demo: false, onSelect: () => {} }));
  await click(allByText('button', /^Unsubscribe$/)[0]);
  assert.equal(allByText('button', /Unsubscribing…/).length, 1, 'only the pressed button says it is working');
  assert.equal(allByText('button', /Blocking…/).length, 0);
  const other = allByText('button', /^Unsubscribe$/)[0] as HTMLButtonElement;
  assert.equal(other.disabled, false, 'another newsletter in the same account is still available');
  assert.equal((allByText('button', /Block sender/)[0] as HTMLButtonElement).disabled, false);
  release(); await settle();
});

void test('a late unsubscribe answer is dropped when its newsletter has left the screen', async () => {
  setupDom();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  stubFetch(async (url, body) => {
    if (url.startsWith('/api/unsubscribe')) { await held; return { capability: 'one-click', outcome: 'failed', reason: 'provider-rejected' }; }
    return defaultHandler(url, body);
  });
  const first = newsletter({ id: 'first', listId: 'first.list' });
  const props = { demo: false, onSelect: () => {} };
  await render(createElement(NoiseList, { ...props, emails: [first] }));
  await click(byText('button', /^Unsubscribe$/));
  await rerender(createElement(NoiseList, { ...props, emails: [newsletter({ id: 'other', accountId: 'acct-2', listId: 'other.list' })] }));
  release(); await settle();
  await rerender(createElement(NoiseList, { ...props, emails: [first] })); await settle();
  assert.equal(allByText('output', /couldn’t accept/).length, 0, 'the answer did not attach itself after the list changed');
});

void test('a link the server will not call is offered to open, not described as missing', async () => {
  setupDom();
  stubFetch(async (url, body) => url.startsWith('/api/unsubscribe')
    ? { capability: 'manual-page', outcome: 'none', reason: 'open-page', page: 'https://unknown-provider.example/u?id=1' }
    : defaultHandler(url, body));
  await render(createElement(NoiseList, { emails: [newsletter({ id: 'stale', listId: 'stale.list' })], demo: false, onSelect: () => {} }));
  await click(byText('button', /^Unsubscribe$/)); await settle();
  assert.equal(allByText('output', /doesn’t include a supported unsubscribe option/).length, 0);
  const link = byText('a', /Open unsubscribe page/) as HTMLAnchorElement;
  assert.equal(link.getAttribute('href'), 'https://unknown-provider.example/u?id=1');
});

void test('a sender with no real address is not offered Block sender', async () => {
  setupDom(); stubFetch(defaultHandler);
  await render(createElement(NoiseList, { emails: [
    newsletter({ id: 'ghost', sender: 'Unknown', address: 'unattributed:ghost', oneClick: false, unsubscribeCapability: 'none' }),
    newsletter({ id: 'real', sender: 'Real', address: 'real@real.example', oneClick: false, unsubscribeCapability: 'none' }),
  ], demo: false, onSelect: () => {} }));
  assert.equal(allByText('button', /Block sender/).length, 1, 'only the real sender can be blocked');
});

// ── Needs a reply: membership, counts, order and late responses ─────────────

/** A classified message whose reply decision is given, with nothing that makes it Important. */
function replyMail(id:string,accountId:string,reply:{status:'required'|'not_required'|'uncertain';urgency:'prompt'|'routine'|'unknown'},extra:Partial<Email>={}):Email{
  const classification={context:'work',topics:[],obligations:[],disposition:'useful',replyRequired:reply.status==='required',
    reply:{...reply,channel:reply.status==='required'?'email':'none',reasonCode:reply.status==='required'?'information_requested':'no_request',
      evidence:`Question ${id}?`,explanation:`Reply decision for ${id}.`,source:'rules'},
    securityEvent:false,processingStatus:'classified',reason:'Classified.',version:'test'} as unknown as Classification;
  return mail({id,accountId,subject:`Subject ${id}`,category:'work',priority:'normal',tags:[],receivedAt:Date.now()-3600000,
    needsReply:reply.status==='required',classification,...extra});
}

void test('the reply tab holds every pending reply, Important or routine, with matching counts',async()=>{
  const inbox=[
    replyMail('a-routine','acct-1',{status:'required',urgency:'routine'}),
    replyMail('z-prompt','acct-1',{status:'required',urgency:'prompt'}),
    replyMail('done-1','acct-1',{status:'not_required',urgency:'unknown'}),
    replyMail('unclear-1','acct-1',{status:'uncertain',urgency:'unknown'}),
  ];
  await openDashboard({handler:(url,body)=>url.startsWith('/api/mailbox')||url.startsWith('/api/sync')?snapshot(inbox):defaultHandler(url,body)});
  const tab=byText('button',/Needs a reply/);
  assert.equal(tab.querySelector('.tab-count')?.textContent,'2','the count includes routine replies outside Important');
  await click(tab);await settle();
  const subjects=allByText('h3',/^Subject /).map(node=>node.textContent);
  assert.deepEqual(subjects,['Subject z-prompt','Subject a-routine'],'prompt replies come first, and only pending replies are listed');
  assert.equal(byText('h2',/Waiting on your reply/).querySelector('span')?.textContent,'2','the heading counts what is listed');
});

void test('grouped rows count their pending replies, and reply order puts prompt answers first',async()=>{
  const { buildInboxRows, sortInboxEmails }=await import('../lib/inbox-priority');
  const fold=(id:string,urgency:'prompt'|'routine',needs:boolean)=>({...replyMail(id,'acct-1',{status:needs?'required':'not_required',urgency}),
    address:'security@bank.example',sender:'Bank Security',subject:`New sign-in ${id}`,summary:'A new device signed in.',body:'A new device signed in to your account.'});
  const rows=buildInboxRows([fold('s1','routine',true),fold('s2','prompt',true),fold('s3','routine',false)],Date.now());
  const group=rows.find(row=>row.kind==='fold');
  assert.ok(group&&group.kind==='fold');
  assert.equal(group.needsReplyCount,2);
  // Identity would put "a" first; urgency must win over that tie-breaker.
  const ordered=sortInboxEmails([replyMail('a','acct-1',{status:'required',urgency:'routine'}),replyMail('z','acct-1',{status:'required',urgency:'prompt'})],Date.now(),'reply');
  assert.deepEqual(ordered.map(m=>m.id),['z','a']);
});

void test('a routine reply shows its own wording, and an unsettled decision says so',async()=>{
  setupDom();stubFetch(defaultHandler);
  await render(createElement(PriorityEmailList,{emails:[
    replyMail('a','acct-1',{status:'not_required',urgency:'unknown'}),
    replyMail('b','acct-1',{status:'uncertain',urgency:'unknown'}),
    replyMail('c','acct-1',{status:'required',urgency:'routine'}),
    {...replyMail('d','acct-1',{status:'required',urgency:'prompt'}),needsReply:false,replied:true},
  ],now:Date.now(),sortMode:'reply',busy:false,emptyTitle:'x',emptyBody:'y',onSelect:()=>{}}));
  assert.equal(allByText('span',/^No reply needed$/).length,1);
  assert.equal(allByText('span',/^Reply unclear$/).length,1);
  assert.equal(allByText('span',/^Replied$/).length,1);
  assert.equal(allByText('button',/Quick reply/).length,1);
});

void test('a sync that started before a send cannot bring the reply badge back',async()=>{
  const { keepSentReplies }=await import('../hooks/use-inbox');
  const sent={...replyMail('x','acct-1',{status:'required',urgency:'prompt'}),needsReply:false,replied:true};
  const stale=replyMail('x','acct-1',{status:'required',urgency:'prompt'});
  const sameIdOtherAccount=replyMail('x','acct-2',{status:'required',urgency:'prompt'});
  const newerInThread=replyMail('y','acct-1',{status:'required',urgency:'prompt'},{threadId:'same-thread'} as Partial<Email>);
  const merged=keepSentReplies([sent],[stale,sameIdOtherAccount,newerInThread]);
  assert.equal(merged[0].needsReply,false,'the late response keeps the send');
  assert.equal(merged[0].replied,true);
  assert.equal(merged[1].needsReply,true,'the same Gmail id in another mailbox is a different message');
  assert.equal(merged[2].needsReply,true,'a newer message in the thread still needs its own answer');
});
