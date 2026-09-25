import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { allByText, byLabel, byText, click, render, screen, setupDom, settle, teardownDom, unmountTree } from './dom';
import Dashboard from '../app/page';
import { ReplyComposer } from '../components/reply-composer';
import { ClassificationDetail } from '../components/classification-detail';
import { NoiseList } from '../components/noise-list';
import { PriorityEmailList } from '../components/priority-email-list';
import { WeekCalendar } from '../components/week-calendar';
import { demoEmails, type Email } from '../lib/mail';
import type { Classification } from '../lib/classification';
import type { ConnectionStatus } from '../hooks/use-inbox';
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

void test('unsubscribing from an unattributed message is refused instead of guessed', async () => {
  setupDom();
  const seen=stubFetch(defaultHandler);
  const junk={...unattributed,category:'noise',oneClick:true,unsubscribe:'https://sender.example/unsubscribe'} as unknown as Email;
  await render(createElement(NoiseList,{emails:[junk],demo:false,onRemoved:()=>{},onSelect:()=>{}}));
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
    subject:'Old GitHub verification code',receivedAt:Date.UTC(2026,7,1),priority:'high',
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
  const bullets=[...popup.querySelectorAll('li')].map(node=>(node.textContent||'').trim());
  // One bullet per event, earliest clock time first; the undated one follows the timed.
  assert.deepEqual(bullets,['Morning standup','Afternoon review','Budget paperwork']);
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
