import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { JSDOM } from 'jsdom';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { buildEmailDocument } from '../components/email-body';
import { DailyBrief } from '../components/daily-brief';
import { useDoneMail } from '../hooks/use-done-mail';
import { useDrafts } from '../hooks/use-drafts';
import { emailKey, demoEmails, type Email } from '../lib/mail';
import { searchMail, searchExcerpt } from '../lib/mail-search';
import { fromPerson, digestScore, DIGEST_WEIGHTS } from '../lib/digest-rank';
import { provisionalItems } from '../lib/digest';
import { evaluateImportance } from '../lib/importance';
import { deterministicClassify } from '../lib/deterministic';
import { normalizeMessage } from '../server/message';
import { parseMessage } from '../server/gmail';
import { syncInbox, CONTENT_VERSION } from '../server/sync';
import { analysisVersion } from '../server/ai';
import { attachSenderFamiliarity, SENDER_CHECKS_PER_REFRESH } from '../server/sender-familiarity';
import { GET as draftsRoute } from '../app/api/drafts/route';
import { draftFrom } from '../server/drafts';
import { connect, rig, gmailMessage, origin } from './helpers/google';
import { click, render, rerender, screen, settle, setupDom, teardownDom } from './dom';

const NOW=Date.UTC(2026,9,3,17);
const mail=(id:string,over:Partial<Email>={}):Email=>({...demoEmails[0],id,accountId:'a',accountEmail:'me@example.com',threadId:id,receivedAt:NOW-3600000,...over});

void test('once an ingress secret is configured, bare or forged identity headers fail closed',async()=>{
  const r=rig();
  try{
    const headers=globalThis.__briefTestHeaders;
    assert.equal((await getChatGPTUser())?.userId,'user-a');
    headers.delete('x-brief-identity-secret');assert.equal(await getChatGPTUser(),null);
    headers.set('x-brief-identity-secret','forged');assert.equal(await getChatGPTUser(),null);
    headers.set('x-brief-identity-secret','test-ingress-secret-for-authenticated-proxy');
    r.env.IDENTITY_PROXY_SECRET='';headers.delete('x-brief-identity-secret');
    assert.equal((await getChatGPTUser())?.userId,'user-a','with no secret configured, the Sites host headers are trusted as before');
    headers.set('x-brief-identity-secret','test-ingress-secret-for-authenticated-proxy');
    r.env.IDENTITY_PROXY_SECRET='short';assert.equal(await getChatGPTUser(),null);
    r.env.IDENTITY_PROXY_SECRET='test-ingress-secret-for-authenticated-proxy';assert.equal((await getChatGPTUser())?.userId,'user-a');
  }finally{r.restore();}
});

void test('all meta, link and base variants are inert, including encoded navigation and DNS hints',()=>{
  const attacks=["< <meta http-equiv=refresh content='0;url=https://evil.example'>","<div foo' bar='> <meta http-equiv=refresh content='0;url=https://evil.example'> '>",'<meta http-equiv="&#114;efresh" content="0;url=https://evil.example">','<META HTTP-EQUIV=&#x72;efresh content="0;https://evil.example">','<link rel=dns-prefetch href=//evil.example>','<link rel=preconnect href=https://evil.example>','<base href=https://evil.example>',"<!-- x='--> <meta http-equiv=refresh content='0;url=https://evil.example'>","<?x title='> <meta http-equiv=refresh content='0;url=https://evil.example'>"];
  for(const images of [false,true])for(const attack of attacks){
    const document=buildEmailDocument(attack+'<p>Kept text</p>',images);
    const dom=new JSDOM(document);
    try{
      assert.equal(dom.window.document.querySelectorAll('link,base,meta[http-equiv]').length,2,'only the application CSP meta and inert base are present');
      assert.equal(dom.window.document.querySelector('meta[http-equiv]')?.getAttribute('http-equiv'),'Content-Security-Policy');
      assert.match(dom.window.document.body.textContent||'',/Kept text/);
      assert.equal(dom.window.document.querySelector('base')?.getAttribute('href'),'about:blank');
    }finally{dom.window.close();}
  }
});

void test('the sidebar draft count reads only the list, even with fifty drafts',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');const provider=globalThis.fetch;let lists=0,reads=0;
    globalThis.fetch=async(input,init)=>{
      const url=(input instanceof Request?input.url:input.toString());
      if(url.includes('/drafts?')){lists++;return Response.json({drafts:Array.from({length:50},(_,i)=>({id:'draft-'+i})),resultSizeEstimate:137});}
      if(url.includes('/drafts/')){reads++;throw new Error('Count must not read bodies');}
      return provider(input,init);
    };
    const result=await draftsRoute(new Request(origin+'/api/drafts?accountId=a&countOnly=true'));
    assert.equal(result.status,200);assert.equal((await result.json() as {count:number}).count,137);assert.equal(lists,1);assert.equal(reads,0);
  }finally{r.restore();}
});

void test('draft recipient parsing preserves quoted commas, encoded names and multiple recipients',()=>{
  const raw=gmailMessage({id:'draft',from:'me@example.com',to:'"Lee, Sam" <sam@example.com>, =?UTF-8?B?Sm9yZGFu?= <jordan@example.com>, alex@example.com (Operations, West)'});
  assert.deepEqual(draftFrom({id:'draft-id',message:raw},{id:'a',email:'me@example.com'}).to,['sam@example.com','jordan@example.com','alex@example.com']);
});

void test('sender metadata checks are bounded and deferred senders rotate on later incremental refreshes',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');
    const all=Object.fromEntries(Array.from({length:60},(_,i)=>['m'+i,gmailMessage({id:'m'+i,from:`Person ${i} <person${i}@example.com>`,to:'me@example.com',receivedAt:NOW-3600000})]));
    const normalized=Object.values(all).map(normalizeMessage);
    await attachSenderFamiliarity(normalized,'user-a','a','token',r.env,NOW);
    assert.equal(r.calls.filter(call=>call.url.includes('labelIds=SENT')).length,SENDER_CHECKS_PER_REFRESH);
    assert.equal(normalized.filter(message=>message.senderFamiliarityDeferred).length,50);
    r.calls.length=0;Object.assign(r.messages,all);
    const provider=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const url=(input instanceof Request?input.url:input.toString()),id=/\/messages\/([^?]+)\?format=full/.exec(url)?.[1];
      if(id&&all[id])return Response.json(all[id]);
      return provider(input,init);
    };
    await syncInbox('user-a','a',r.env);
    assert.equal(r.calls.filter(call=>call.url.includes('labelIds=SENT')).length,10);
    for(const id of Object.keys(r.messages))delete r.messages[id];
    for(let pass=0;pass<5;pass++)await syncInbox('user-a','a',r.env);
    assert.equal(r.calls.filter(call=>call.url.includes('labelIds=SENT')).length,60);
    assert.equal(r.storage.sql.prepare("SELECT COUNT(*) n FROM mailbox_messages WHERE json_extract(data,'$.senderFamiliarityDeferred')=1").get()?.n,0);
  }finally{r.restore();}
});

void test('a 100-message incremental refresh plus older retries stays within the D1 parameter ceiling',async()=>{
  const r=rig({geminiKey:true});try{
    await connect(r,'user-a','a');
    r.storage.sql.prepare('UPDATE connections SET content_version=?,backfill_complete=1,last_full_scan=? WHERE id=?').run(CONTENT_VERSION,Date.now(),'a');
    for(let i=0;i<100;i++)r.messages['new-'+i]=gmailMessage({id:'new-'+i,from:'Sam <sam@example.com>'});
    const snapshot=await syncInbox('user-a','a',r.env);
    assert.equal(snapshot.emails.length,100);
  }finally{r.restore();}
});

void test('Inbox reconciliation crosses 500 ids, preserves earlier pages during refetch and clears old archives only at completion',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');
    r.storage.sql.prepare('UPDATE connections SET content_version=?,backfill_complete=1,last_full_scan=? WHERE id=?').run(CONTENT_VERSION,Date.now(),'a');
    const ids=Array.from({length:1200},(_,i)=>'kept-'+i);
    const insert=r.storage.sql.prepare('INSERT INTO mailbox_messages(user_id,account_id,message_id,data,received_at,scan_generation) VALUES(?,?,?,?,?,?)');
    for(const id of [...ids,'archived-old']){const email=mail(id,{inInbox:true,receivedAt:Date.now()-86400000});insert.run('user-a','a',id,JSON.stringify(email),email.receivedAt!,'old');}
    const provider=globalThis.fetch;let pages=0;
    globalThis.fetch=async(input,init)=>{
      const url=new URL((input instanceof Request?input.url:input.toString()));
      if(url.searchParams.get('labelIds')==='INBOX'){
        pages++;const start=Number(url.searchParams.get('pageToken')||0);
        return Response.json({messages:ids.slice(start,start+500).map(id=>({id})),...(start+500<ids.length?{nextPageToken:String(start+500)}:{})});
      }
      return provider(input,init);
    };
    const inbox=(id:string)=>JSON.parse((r.storage.sql.prepare('SELECT data FROM mailbox_messages WHERE message_id=?').get(id) as {data:string}).data).inInbox as boolean;
    await syncInbox('user-a','a',r.env);assert.equal(inbox('archived-old'),true,'partial scans cannot erase unseen mail');
    r.messages['kept-10']=gmailMessage({id:'kept-10',from:'Sam <sam@example.com>',receivedAt:NOW-3600000});
    await syncInbox('user-a','a',r.env);assert.equal(inbox('archived-old'),true);
    await syncInbox('user-a','a',r.env);
    assert.equal(pages,3);assert.equal(inbox('archived-old'),false);assert.equal(inbox('kept-10'),true);assert.equal(inbox('kept-1199'),true);
  }finally{r.restore();}
});

void test('failed stale-version model refresh preserves prior AI facts and backs off',async()=>{
  const r=rig({geminiKey:true});try{
    await connect(r,'user-a','a');
    r.storage.sql.prepare('UPDATE connections SET content_version=?,backfill_complete=1,last_full_scan=? WHERE id=?').run(CONTENT_VERSION,Date.now(),'a');
    const raw=gmailMessage({id:'old',from:'Sam <sam@example.com>',body:'Can you review the report?'}),normalized=normalizeMessage(raw);
    const classification=deterministicClassify(normalized,'me@example.com');
    const {contentFingerprint}=await import('../server/overrides');
    const email={...parseMessage(raw,'me@example.com'),accountId:'a',classificationSource:'ai',analysisVersion:'gemini:older',automaticClassification:classification,fingerprint:contentFingerprint(normalized)};
    r.storage.sql.prepare('INSERT INTO mailbox_messages(user_id,account_id,message_id,data,received_at,scan_generation) VALUES(?,?,?,?,?,?)').run('user-a','a','old',JSON.stringify(email),email.receivedAt!,'old');
    const provider=globalThis.fetch;globalThis.fetch=async(input,init)=>(input instanceof Request?input.url:input.toString()).includes('/messages/old?')?Response.json(raw):provider(input,init);
    await syncInbox('user-a','a',r.env);
    const read=()=>JSON.parse((r.storage.sql.prepare("SELECT data FROM mailbox_messages WHERE message_id='old'").get() as {data:string}).data);
    assert.equal(read().analysisVersion,'gemini:older');assert.equal(read().classificationSource,'ai');assert.deepEqual(read().automaticClassification.obligations,classification.obligations);
    assert.equal(read().modelRetryVersion,analysisVersion(r.env));assert.ok(read().modelRetryAt>Date.now());
    const calls=r.calls.filter(call=>call.url.includes('generativelanguage')).length;
    await syncInbox('user-a','a',r.env);assert.equal(r.calls.filter(call=>call.url.includes('generativelanguage')).length,calls);
  }finally{r.restore();}
});

void test('person names are not role addresses, calendar acknowledgments and search results get no outcome boost',()=>{
  for(const local of ['dbishop','mstafford','jbanks','sabbott','rtalbot','happleton'])assert.equal(fromPerson(mail(local,{address:local+'@example.com'})),true,local);
  for(const local of ['support','no-reply','account-security-noreply','notifications'])assert.equal(fromPerson(mail(local,{address:local+'@example.com'})),false,local);
  const base=mail('rank',{address:'support@example.com'}),importance=evaluateImportance(base,NOW),score=digestScore(base,importance,NOW);
  assert.equal(digestScore({...base,subject:'Accepted: Team sync'},importance,NOW),score);
  assert.equal(digestScore({...base,subject:'Your search results'},importance,NOW),score);
  assert.equal(digestScore({...base,subject:'Tryout results'},importance,NOW),score+DIGEST_WEIGHTS.outcome);
});

void test('the fifty-first recipient keeps person credit and old attachment records trigger a content upgrade',()=>{
  const to=Array.from({length:50},(_,i)=>`person${i}@example.com`).concat('me@example.com').join(', ');
  const parsed=parseMessage(gmailMessage({id:'many',from:'Sam <sam@example.com>',to}),'me@example.com');
  assert.equal(parsed.to?.length,50);assert.equal(parsed.readerWasRecipient,true);assert.equal(fromPerson({...parsed,accountEmail:'me@example.com'}),true);
  assert.ok(CONTENT_VERSION>9);
});

void test('large search bodies are indexed once across keystrokes; Unicode expansions and edits retain accurate excerpts',()=>{
  const email=mail('large',{body:'ﬃ '.repeat(10000)+'Target needle detail',summary:''});
  assert.equal(searchMail([email],'needle').length,1);assert.match(searchExcerpt(email,'needle'),/Target needle detail/);
  const dotted=mail('dotted',{body:'İ '.repeat(1000)+'Found needle',summary:''});assert.match(searchExcerpt(dotted,'needle'),/Found needle/);
  const original=Object.getOwnPropertyDescriptor(String.prototype,'normalize')!.value as (this:string,form?:string)=>string;let runs=0;
  String.prototype.normalize=function(form?:string){runs++;return original.call(String(this),form);};
  try{for(const query of ['nee','need','needle'])assert.equal(searchMail([email],query).length,1);assert.equal(runs,6,'only each query and empty sender are normalized');}
  finally{String.prototype.normalize=original;}
  email.body='Completely replaced text';assert.equal(searchMail([email],'needle').length,0);
});

void test('the provisional brief uses clock-free sender, work and star scores',()=>{
  const system=mail('system',{address:'notifications@example.com',subject:'Routine update',priority:'high',classification:undefined});
  const person=mail('person',{address:'dbishop@example.com',priority:'high',classification:undefined});
  const starred=mail('starred',{category:'personal',address:'jordan@example.com',gmailLabels:['STARRED'],priority:'high',classification:undefined});
  assert.deepEqual(provisionalItems([system,person,starred]).map(item=>item.key),[emailKey(starred),emailKey(person)]);
});

function SharedDone(){
  const done=useDoneMail('reader'),emails=[demoEmails[0],demoEmails[1]],split=done.split(emails);
  return createElement('div',null,createElement('output',null,String(split.open.length)),createElement('button',{onClick:()=>done.markDone([emails[0]])},'Done in list'),
    createElement(DailyBrief,{emails,now:NOW,connected:false,ai:false,aiConfigured:false,busy:false,updated:NOW,collapsed:false,onCollapse:()=>{},onSelect:()=>{},doneKeys:done.keys,onDone:done.markDone,onMoveBack:done.moveBack}));
}
void test('list Done and brief ticks share immediate persistent marks, including legacy ticks and Undo',async()=>{
  setupDom();try{
    await render(createElement(SharedDone));await settle();
    await click(screen().querySelector('button')!);
    assert.equal(screen().querySelector('output')?.textContent,'1');
    assert.ok(!screen().querySelector('.digest-open')?.textContent?.includes(demoEmails[0].subject));
    assert.ok(localStorage.getItem('brief:done-mail:reader')?.includes(demoEmails[0].id));
    const tick=screen().querySelector('.digest-done');assert.ok(tick);await click(tick);
    assert.equal(screen().querySelector('output')?.textContent,'0');
    await click(screen().querySelector('.digest-restore')!);assert.equal(screen().querySelector('output')?.textContent,'2');
  }finally{teardownDom();}
});

void test('a draft request from the previous account cannot populate the new account or a disconnected scope',async()=>{
  setupDom();const original=globalThis.fetch;
  let finish:(value:Response)=>void=()=>{};
  function DraftScope({account,connected}:{account:string;connected:boolean}){
    const drafts=useDrafts(account,connected,false);return createElement('output',null,`${drafts.count}:${drafts.items.length}`);
  }
  try{
    globalThis.fetch=async input=>(input instanceof Request?input.url:input.toString()).includes('accountId=a')?new Promise<Response>(resolve=>{finish=resolve;}):Response.json({items:[],count:4,failures:[]});
    await render(createElement(DraftScope,{account:'a',connected:true}));await settle();
    await rerender(createElement(DraftScope,{account:'b',connected:true}));await settle();
    finish(Response.json({items:[{id:'foreign'}],count:99,failures:[]}));await settle();assert.equal(screen().textContent,'4:0');
    await rerender(createElement(DraftScope,{account:'a',connected:true}));await settle();
    await rerender(createElement(DraftScope,{account:'a',connected:false}));await settle();
    finish(Response.json({items:[{id:'foreign'}],count:99,failures:[]}));await settle();assert.equal(screen().textContent,'0:0');
  }finally{globalThis.fetch=original;teardownDom();}
});

void test('chunked multipart uploads are rejected at the byte limit without reading the whole stream or contacting Gmail',async()=>{
  const {POST}=await import('../app/api/compose/route');
  const r=rig();try{
    await connect(r,'user-a','a');let chunks=0,cancelled=false;
    const stream=new ReadableStream<Uint8Array>({pull(controller){chunks++;controller.enqueue(new Uint8Array(65536));},cancel(){cancelled=true;}});
    const request=new Request(origin+'/api/compose',{method:'POST',headers:{origin,'content-type':'multipart/form-data; boundary=upload'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'});
    const response=await POST(request);assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(chunks<200);assert.equal(r.calls.length,0);
  }finally{r.restore();}
});

void test('unavailable, oversized and HTML-only draft bodies stay editable in Gmail instead of overwriting partial text',async()=>{
  const {editableHere}=await import('../components/drafts-view');
  const original=gmailMessage({id:'draft',from:'me@example.com',body:'hello'});
  const missing={...original,payload:{...original.payload,body:{attachmentId:'body-id',size:100}}};
  const html={...original,payload:{...original.payload,mimeType:'text/html'}};
  const large=gmailMessage({id:'large',from:'me@example.com',body:'x'.repeat(20001)});
  for(const raw of [missing,html,large])assert.equal(editableHere(draftFrom({id:'draft-id',message:raw},{id:'a',email:'me@example.com'})),false);
  assert.equal(editableHere(draftFrom({id:'draft-id',message:original},{id:'a',email:'me@example.com'})),true);
});

void test('a deferred text draft loads its full body before editing',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');const provider=globalThis.fetch;
    const raw=gmailMessage({id:'draft-message',from:'me@example.com',body:'snippet'});
    raw.payload.body={attachmentId:'body-id',size:40} as unknown as typeof raw.payload.body;
    globalThis.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input.toString();
      if(url.includes('/drafts?'))return Response.json({drafts:[{id:'draft-id'}]});
      if(url.includes('/drafts/draft-id?'))return Response.json({id:'draft-id',message:raw});
      if(url.includes('/messages/draft-message/attachments/body-id'))return Response.json({data:Buffer.from('Full body, never just the snippet.').toString('base64url')});
      return provider(input,init);
    };
    const response=await draftsRoute(new Request(origin+'/api/drafts?accountId=a'));
    assert.equal(response.status,200);const result=await response.json() as {items:{body:string;contentComplete:boolean}[]};
    assert.equal(result.items[0].body,'Full body, never just the snippet.');assert.equal(result.items[0].contentComplete,true);
  }finally{r.restore();}
});

void test('a deferred refresh follow-up always replaces the Finishing notice, including an in-flight refresh',async()=>{
  const {useInbox}=await import('../hooks/use-inbox');
  const {act}=await import('react');
  for(const inFlight of [false,true]){
    setupDom();const original=globalThis.fetch,originalTimer=window.setTimeout.bind(window);
    const followups:(()=>void)[]=[];let syncs=0,release=()=>{};
    function InboxProbe(){const inbox=useInbox();return createElement('div',null,createElement('output',null,inbox.notice),createElement('button',{onClick:()=>void inbox.refresh()},'Refresh'));}
    const snapshot={emails:[],updated:1,ai:false,hasMore:false};
    const connection={userId:'reader',connected:true,configured:true,aiConfigured:false,schedulerActive:false,intervalMinutes:30,defaultAccountId:'a',accounts:[{id:'a',email:'me@example.com',lastSync:1,error:null}]};
    try{
      window.setTimeout=((handler:TimerHandler,delay?:number,...args:unknown[])=>{
        if(delay===4000){followups.push(handler as ()=>void);return originalTimer(()=>{},0);}
        return originalTimer(handler,delay,...args);
      }) as typeof window.setTimeout;
      globalThis.fetch=async(input)=>{
        const url=input instanceof Request?input.url:input.toString();
        if(url.startsWith('/api/connection'))return Response.json(connection);
        if(url.startsWith('/api/mailbox'))return Response.json(snapshot);
        if(url.startsWith('/api/sync')){
          syncs++;
          if(syncs===3&&inFlight)await new Promise<void>(resolve=>{release=resolve;});
          return Response.json(syncs===1||syncs===3&&inFlight?snapshot:{...snapshot,deferred:[{accountId:'a',email:'me@example.com',reason:'busy'}]});
        }
        throw new Error('Unexpected '+url);
      };
      await render(createElement(InboxProbe));await settle();
      await click(screen().querySelector('button')!);await settle();assert.match(screen().querySelector('output')!.textContent!,/^Finishing/);
      assert.equal(followups.length,1);
      if(inFlight)await click(screen().querySelector('button')!);
      await act(async()=>{followups[0]();});await settle();
      assert.doesNotMatch(screen().querySelector('output')!.textContent!,/^Finishing/);
      assert.match(screen().querySelector('output')!.textContent!,inFlight?/refresh is still running/:/Some mail is still refreshing/);
      if(inFlight){release();await settle();}
    }finally{window.setTimeout=originalTimer;globalThis.fetch=original;teardownDom();}
  }
});

void test('a draft delete completing after an account switch cannot decrement the new account count',async()=>{
  setupDom();const original=globalThis.fetch;let finish:(response:Response)=>void=()=>{};
  function DraftDeleteScope({account}:{account:string}){const drafts=useDrafts(account,true);return createElement('div',null,createElement('output',null,String(drafts.count)),createElement('button',{onClick:()=>void drafts.remove(drafts.items[0])},'Delete'));}
  try{
    globalThis.fetch=async(input,init)=>{
      if(init?.method==='POST')return new Promise<Response>(resolve=>{finish=resolve;});
      const url=input instanceof Request?input.url:input.toString();
      return Response.json(url.includes('accountId=a')?{count:1,items:[{id:'draft',accountId:'a'}],failures:[]}:{count:4,items:[],failures:[]});
    };
    await render(createElement(DraftDeleteScope,{account:'a'}));await settle();await click(screen().querySelector('button')!);
    await rerender(createElement(DraftDeleteScope,{account:'b'}));await settle();finish(Response.json({deleted:true}));await settle();
    assert.equal(screen().querySelector('output')?.textContent,'4');
  }finally{globalThis.fetch=original;teardownDom();}
});

void test('legacy brief ticks migrate into Done exactly once and do not undo a later Move back',async()=>{
  setupDom();try{
    localStorage.setItem('brief:digest-done:demo',JSON.stringify([emailKey(demoEmails[0])]));
    await render(createElement(SharedDone));await settle();await settle();
    assert.equal(screen().querySelector('output')?.textContent,'1');
    assert.equal(localStorage.getItem('brief:digest-done:demo'),null);
    await click(screen().querySelector('.digest-restore')!);await settle();
    assert.equal(screen().querySelector('output')?.textContent,'2');
  }finally{teardownDom();}
});

void test('a successful bounded AI refresh clears a pending flag from a previous failed attempt',async()=>{
  const r=rig({geminiKey:true});try{
    await connect(r,'user-a','a');
    r.messages.retry=gmailMessage({id:'retry',from:'Sam <sam@example.com>',to:'a@gmail.example',body:'Hello again.'});
    r.gemini.reply=request=>({items:(JSON.parse(request.contents[0].parts[0].text) as {id:string}[]).map(({id})=>({id,context:'personal',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'Personal greeting',summary:'Hello again.',obligations:[]}))});
    await syncInbox('user-a','a',r.env);
    r.storage.sql.prepare("UPDATE mailbox_messages SET data=json_set(data,'$.analysisVersion','gemini:older','$.classificationPending',json('true')) WHERE message_id='retry'").run();
    const result=await syncInbox('user-a','a',r.env);
    assert.equal(result.pending,0);assert.equal(result.emails[0].classificationPending,false);assert.equal(result.emails[0].analysisVersion,analysisVersion(r.env));
  }finally{r.restore();}
});

void test('chunked correction bodies stop at the byte limit before touching a mailbox',async()=>{
  const {POST}=await import('../app/api/classification/route');
  const r=rig();try{
    let cancelled=false,chunks=0;
    const stream=new ReadableStream<Uint8Array>({pull(controller){chunks++;controller.enqueue(new Uint8Array(4096));},cancel(){cancelled=true;}});
    const response=await POST(new Request(origin+'/api/classification',{method:'POST',headers:{origin,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit&{duplex:'half'}));
    assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(chunks<30);assert.equal(r.calls.length,0);
  }finally{r.restore();}
});

void test('version ten reconciles older attachment metadata and stores full recipient membership during sync',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a','me@example.com');
    r.storage.sql.prepare('UPDATE connections SET content_version=9,backfill_complete=1,last_full_scan=? WHERE id=?').run(Date.now(),'a');
    const to=Array.from({length:50},(_,i)=>`person${i}@example.com`).concat('me@example.com').join(', ');
    const raw=gmailMessage({id:'older-attachment',from:'Sam <sam@example.com>',to,receivedAt:Date.now()-20*86400000});
    const part=raw.payload;
    raw.payload={mimeType:'multipart/mixed',headers:part.headers,parts:[{mimeType:'text/plain',body:part.body},{mimeType:'application/pdf',filename:'proposal.pdf',body:{attachmentId:'file',size:123}}]} as unknown as typeof raw.payload;
    r.messages['older-attachment']=raw;
    const snapshot=await syncInbox('user-a','a',r.env);
    const listing=r.calls.find(call=>call.url.includes('/messages?maxResults='));assert.ok(listing);assert.ok(!new URL(listing.url).searchParams.get('q')?.includes('newer_than'));
    assert.equal(snapshot.emails[0].hasAttachments,true);assert.equal(snapshot.emails[0].readerWasRecipient,true);
    assert.equal(searchMail(snapshot.emails,'has:attachment').length,1);
    assert.equal(r.storage.sql.prepare("SELECT content_version FROM connections WHERE id='a'").get()?.content_version,10);
  }finally{r.restore();}
});

void test('worst-case familiarity lookup still uses at most forty Gmail requests per refresh',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');const provider=globalThis.fetch;let requests=0;
    globalThis.fetch=async(input,init)=>{
      const url=new URL(input instanceof Request?input.url:input.toString());
      if(url.searchParams.get('labelIds')==='SENT'){requests++;return Response.json({messages:[{id:'one'},{id:'two'},{id:'three'}]});}
      if(url.searchParams.get('format')==='metadata'){requests++;return Response.json({labelIds:['SENT'],internalDate:String(NOW-86400000),payload:{headers:[{name:'To',value:'unrelated@example.com'}]}});}
      return provider(input,init);
    };
    const messages=Array.from({length:100},(_,i)=>normalizeMessage(gmailMessage({id:'m'+i,from:`Sender <sender${i}@example.com>`,receivedAt:NOW-3600000})));
    await attachSenderFamiliarity(messages,'user-a','a','token',r.env,NOW);
    assert.equal(requests,40);assert.equal(messages.filter(message=>message.senderFamiliarityDeferred).length,90);
  }finally{r.restore();}
});

void test('direct recruiter mail in Gmail Social stays useful without AI',()=>{
  const message=normalizeMessage(gmailMessage({id:'recruiter',from:'Jordan Lee <jordan@recruiting.example>',to:'me@example.com',subject:'An engineering opportunity',body:'Hi Ethan, I came across your work and would like to connect.'}));
  message.labels=['INBOX','CATEGORY_SOCIAL'];
  assert.notEqual(deterministicClassify(message,'me@example.com').disposition,'junk');
});

void test('failed full draft reads are reported while successfully read drafts remain visible',async()=>{
  const r=rig();try{
    await connect(r,'user-a','a');const provider=globalThis.fetch;
    globalThis.fetch=async(input,init)=>{
      const url=input instanceof Request?input.url:input.toString();
      if(url.includes('/drafts?'))return Response.json({drafts:[{id:'good'},{id:'bad'}],resultSizeEstimate:2});
      if(url.includes('/drafts/good?'))return Response.json({id:'good',message:gmailMessage({id:'good-message',from:'me@example.com'})});
      if(url.includes('/drafts/bad?'))return new Response('{}',{status:403});
      return provider(input,init);
    };
    const response=await draftsRoute(new Request(origin+'/api/drafts?accountId=a'));assert.equal(response.status,200);
    const result=await response.json() as {items:{id:string}[];failures:{error:string}[]};
    assert.deepEqual(result.items.map(item=>item.id),['good']);assert.match(result.failures[0].error,/1 drafts could not be read/);
  }finally{r.restore();}
});
