import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, encode, mutation, type Runtime } from '../server/runtime';
import { parseMessage, safeUnsubscribe } from '../server/gmail';
import { POST as reply } from '../app/api/reply/route';
import { POST as suggest } from '../app/api/suggest/route';
import { generate } from '../server/ai';
import { demoEmails } from '../lib/mail';
import { GET as demoDigest } from '../app/api/demo/route';
import { POST as runScheduledAgent } from '../app/api/agent/route';
import { summarizeInbox } from '../server/sync';
import { buildInboxRows, isImportantEmail, sortInboxEmails } from '../lib/inbox-priority';
import { SECTIONS, classifyEmail, emailTags, parseView, rowLabels, sectionCount, selectEmails, tagCount, toggleExpanded, type Tag } from '../lib/categories';
import { normalizeMessage, type NormalizedMessage } from '../server/message';
import { collectBatch, evidenceSupported, validateItem } from '../server/classify';
import { applyOverride, contentFingerprint } from '../server/overrides';
import { deterministicClassify } from '../lib/deterministic';
import { resolveDate } from '../lib/dates';
import { derivePriority, effectiveCategories, isOverviewMessage, needsReview, upcomingMeetings, type Classification, type Obligation } from '../lib/classification';
import { FIXTURES, DEV_FIXTURES, HELDOUT_FIXTURES } from './eval-set';

declare global { var __briefTestEnv: Runtime; var __briefTestHeaders: Headers; }
const testEnv = {TOKEN_ENCRYPTION_KEY:encode(crypto.getRandomValues(new Uint8Array(32))),APP_URL:'https://brief.example'} as Runtime;
globalThis.__briefTestEnv=testEnv;
globalThis.__briefTestHeaders=new Headers();

test('stored refresh tokens are encrypted and bound to the owning user',async()=>{
 const encrypted=await encrypt('sample-refresh-token','user-a',testEnv);
 assert.ok(!encrypted.includes('sample-refresh-token'));
 assert.equal(await decrypt(encrypted,'user-a',testEnv),'sample-refresh-token');
 await assert.rejects(decrypt(encrypted,'user-b',testEnv));
});
test('rejects external-origin mutations and requests without an origin',()=>{
 assert.throws(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://attacker.example'}})));
 assert.throws(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST'})));
 assert.doesNotThrow(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example'}})));
});
test('the scheduled agent endpoint requires its secret and records a heartbeat',async()=>{
 const statements:string[]=[];
 const fakeDb={prepare(sql:string){return {bind(){return this;},async run(){statements.push(sql);return {meta:{changes:1}};},async all(){return {results:[]};}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,AGENT_CRON_SECRET:'cron-secret'};
 try{
  const rejected=await runScheduledAgent(new Request('https://brief.example/api/agent',{method:'POST',headers:{authorization:'Bearer wrong'}}));
  assert.equal(rejected.status,401);assert.equal(statements.length,0);
  const accepted=await runScheduledAgent(new Request('https://brief.example/api/agent',{method:'POST',headers:{authorization:'Bearer cron-secret'}}));
  assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{ok:true});
  assert.ok(statements.some(sql=>sql.includes('agent_status')));
 }finally{globalThis.__briefTestEnv=testEnv;}
});
test('one-click targets require trusted HTTPS domains without credentials or custom ports',()=>{
 assert.equal(safeUnsubscribe('https://news.list-manage.com/unsubscribe?id=1',testEnv),true);
 for(const url of ['http://news.list-manage.com/unsubscribe','https://list-manage.com.attacker.example','https://attacker.example','https://127.0.0.1','https://localhost','https://user:pass@list-manage.com','https://list-manage.com:8443'])assert.equal(safeUnsubscribe(url,testEnv),false,url);
});
test('newsletter headers cannot promote marketing to an urgent work item',()=>{
 const parsed=parseMessage({id:'abc',threadId:'thread',snippet:'Newsletter',internalDate:'1788960000000',labelIds:['INBOX','IMPORTANT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Daily News <hello@news.example>'},{name:'Subject',value:'Our latest issue'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}],body:{data:encode('Hello, reader.')}}});
 // An unsubscribe header no longer forces Noise, but bulk mail still must not become urgent.
 assert.notEqual(parsed.category,'noise','an unsubscribe header alone must not prove junk');
 assert.equal(parsed.priority,'normal');assert.equal(parsed.address,'hello@news.example');assert.equal(parsed.body,'Hello, reader.');
});
test('security and account-access mail is important even without Gmail Important',()=>{
 const parsed=parseMessage({id:'security',threadId:'thread',snippet:'Use code 482917 to finish signing in.',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'GitHub <noreply@github.com>'},{name:'Subject',value:'Your GitHub verification code'}],body:{data:encode('Use code 482917 to finish signing in.')}}});
 assert.equal(parsed.priority,'high');
 assert.equal(parsed.label,'Important');
 assert.equal(isImportantEmail(parsed),true);
});
test('reply-needed mail ranks first and routine mail stays at the bottom',()=>{
 const routine={...demoEmails[3],id:'routine',priority:'normal' as const,needsReply:false};
 const security={...demoEmails[3],id:'security',sender:'GitHub',address:'noreply@github.com',subject:'Security alert: new sign-in',priority:'high' as const,needsReply:false};
 const replyNeeded={...demoEmails[3],id:'reply',priority:'normal' as const,needsReply:true};
 assert.deepEqual(sortInboxEmails([routine,security,replyNeeded]).map(email=>email.id),['reply','security','routine']);
});
test('related important company notifications fold without pulling routine mail into the group',()=>{
 const verification={...demoEmails[3],id:'verify',sender:'GitHub',address:'noreply@github.com',subject:'Your GitHub verification code',summary:'Use this code to sign in.',priority:'high' as const,needsReply:false};
 const setup={...demoEmails[3],id:'setup',sender:'GitHub Security',address:'security@github.com',subject:'Complete your two-factor setup',summary:'Finish account security setup.',priority:'high' as const,needsReply:true};
 const routine={...demoEmails[3],id:'routine',sender:'GitHub',address:'news@github.com',subject:'This month on GitHub',summary:'A product roundup.',priority:'normal' as const,needsReply:false};
 const rows=buildInboxRows([routine,verification,setup]);
 assert.equal(rows[0].kind,'fold');
 if(rows[0].kind!=='fold')throw new Error('Expected a folded company row');
 assert.equal(rows[0].company,'GitHub');
 assert.deepEqual(rows[0].emails.map(email=>email.id),['setup','verify']);
 assert.equal(rows[0].needsReplyCount,1);
 assert.equal(rows[1].kind,'email');
 if(rows[1].kind==='email')assert.equal(rows[1].email.id,'routine');
});
test('the demo inbox keeps useful work and noise classifications without AI',()=>{
 assert.ok(demoEmails.some(email=>email.category==='work'&&email.priority==='high'&&email.needsReply));
 assert.ok(demoEmails.some(email=>email.category==='noise'&&email.label==='Newsletter'));
 assert.ok(demoEmails.some(email=>email.category==='personal'&&email.needsReply));
});
test('Gemini prepay depletion is reported as a billing-project problem',async()=>{
 const original=globalThis.fetch;let endpoint='';
 globalThis.fetch=async input=>{endpoint=String(input);return Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'}},{status:429});};
 try{
  await assert.rejects(
   generate('Return a status.',{message:'test'},{type:'object',properties:{status:{type:'string'}},required:['status']},{...testEnv,GEMINI_API_KEY:'test-key'}),
   (error:unknown)=>{
    assert.equal((error as {status?:number}).status,502);
    assert.match((error as Error).message,/prepay balance/i);
    assert.match((error as Error).message,/free tier/i);
    return true;
   },
  );
  assert.match(endpoint,/\/models\/gemini-3\.5-flash-lite:generateContent$/);
 }finally{globalThis.fetch=original;}
});
test('Gemini JSON is rejected when it does not match the requested schema',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:'{"options":["only one"]}'}]},finishReason:'STOP'}]});
 try{
  await assert.rejects(
   generate('Return options.',{message:'test'},{type:'object',properties:{options:{type:'array',minItems:3,maxItems:3,items:{type:'string'}}},required:['options'],additionalProperties:false},{...testEnv,GEMINI_API_KEY:'test-key'}),
   (error:unknown)=>{assert.equal((error as {status?:number}).status,502);assert.match((error as Error).message,/expected format/i);return true;},
  );
 }finally{globalThis.fetch=original;}
});
test('a Gemini outage does not prevent Gmail messages from loading',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{message:'Your prepayment credits are depleted.'}},{status:429});
 const originalError=console.error;console.error=()=>{};
 try{
  const messages=demoEmails.slice(0,2);
  const result=await summarizeInbox(messages,{...testEnv,GEMINI_API_KEY:'test-key'});
  assert.equal(result.ai,false);assert.deepEqual(result.emails,messages);
 }finally{globalThis.fetch=original;console.error=originalError;}
});
test('send endpoint rejects unauthenticated callers before contacting any provider',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',action:'send',body:'Hello'})}));assert.equal(response.status,401);assert.equal(called,false);}finally{globalThis.fetch=original;}
});
function sampleRequest(body:unknown){return new Request('https://brief.example/api/suggest',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify(body)});}
test('sample replies reject unauthenticated callers before contacting any provider',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{const response=await suggest(sampleRequest({id:'1',tone:'Concise'}));assert.equal(response.status,401);assert.equal(called,false);}finally{globalThis.fetch=original;}
});
test('a concurrent demo digest request uses deterministic fallback instead of duplicating Gemini work',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const fakeDb={prepare(){return {bind(){return this;},async first(){return {data:'{"pending":true}',updated:Date.now()};}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GEMINI_API_KEY:'test-key'};
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not duplicate Gemini work');};
 try{
  const response=await demoDigest();const body=await response.json() as {emails:typeof demoEmails;ai:boolean};
  assert.equal(response.status,200);assert.equal(body.ai,false);assert.equal(called,false);
  assert.ok(body.emails.some(email=>email.category==='noise'));
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
test('the demo digest stays available when Gemini is out of credit',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const fakeDb={prepare(){return {bind(){return this;},async first(){return null;},async run(){return {meta:{changes:1}};}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GEMINI_API_KEY:'test-key'};
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{message:'Your prepayment credits are depleted.'}},{status:429});
 try{
  const response=await demoDigest();const body=await response.json() as {emails:typeof demoEmails;ai:boolean};
  assert.equal(response.status,200);assert.equal(body.ai,false);assert.equal(body.emails.length,demoEmails.length);
  assert.deepEqual(body.emails.map(email=>email.id),demoEmails.map(email=>email.id));
  assert.ok(body.emails.some(email=>email.category==='work'&&email.needsReply));
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
test('sample replies generate only from the demo inbox, never from caller-supplied text',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,GEMINI_API_KEY:'test-key'};
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{
  for(const id of ['does-not-exist','','99'])assert.equal((await suggest(sampleRequest({id,tone:'Concise'}))).status,400,id);
  assert.equal(called,false);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
test('sample reply options send the chosen tone and regeneration attempt to the model',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,GEMINI_API_KEY:'test-key',GEMINI_MODEL:'test-model'};
 const original=globalThis.fetch;let url='';let sent:{systemInstruction:{parts:{text:string}[]};contents:{role:string;parts:{text:string}[]}[]}|null=null;
 globalThis.fetch=async(input,init)=>{url=String(input);sent=JSON.parse(typeof init?.body==='string'?init.body:'{}') as typeof sent;return Response.json({candidates:[{content:{parts:[{text:'{"options":["Hi Sarah, approving before 2 PM.","Hi Sarah, I will sign off shortly.","Hi Sarah, you have my approval."]}'}]},finishReason:'STOP'}]});};
 try{
  const response=await suggest(sampleRequest({id:'1',tone:'Professional',variation:2}));
  assert.equal(response.status,200);
  const body=await response.json() as {options:string[]};
  assert.equal(body.options.length,3);
  assert.match(url,/models\/test-model:generateContent/);
  const payload=sent!;
  const instructions=payload.systemInstruction.parts[0].text;
  assert.match(instructions,/Tone: Professional/);
  assert.match(instructions,/regeneration/);
  const modelInput=JSON.parse(payload.contents[0].parts[0].text) as {subject:string;tone:string;attempt:number};
  assert.equal(modelInput.subject,'Website launch — final approval');
  assert.equal(modelInput.tone,'Professional');
  assert.equal(modelInput.attempt,2);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
test('polishing a reply sends the user’s notes and rejects empty ones before contacting any provider',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,GEMINI_API_KEY:'test-key'};
 const original=globalThis.fetch;let called=false;let sent:{contents:{role:string;parts:{text:string}[]}[]}|null=null;
 globalThis.fetch=async(_input,init)=>{called=true;sent=JSON.parse(typeof init?.body==='string'?init.body:'{}') as typeof sent;return Response.json({candidates:[{content:{parts:[{text:'{"reply":"Hi Sarah, I will review by Friday and need two more days."}'}]},finishReason:'STOP'}]});};
 try{
  const empty=await suggest(sampleRequest({id:'1',action:'polish',tone:'Concise',notes:'   '}));
  assert.equal(empty.status,400);
  assert.equal(called,false);
  const response=await suggest(sampleRequest({id:'1',action:'polish',tone:'Concise',notes:'tell her I will review by Friday and need two more days'}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{reply:'Hi Sarah, I will review by Friday and need two more days.'});
  const modelInput=JSON.parse(sent!.contents[0].parts[0].text) as {notes:string};
  assert.match(modelInput.notes,/two more days/);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
test('a known successful send returns its receipt without sending a duplicate',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const encrypted=await encrypt('refresh','user-a',testEnv);
 const fakeDb={prepare(sql:string){return {bind(){return this;},async first(){if(sql.includes('FROM connections'))return {user_id:'user-a',email:'a@example.com',token:encrypted};if(sql.includes('FROM operations'))return {status:'complete',result:'{"id":"sent-1","status":"sent"}'};return null;}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'};
 const original=globalThis.fetch;let sends=0;
 globalThis.fetch=async(input)=>{const url=String(input);if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'access'});if(url.includes('messages/send')){sends++;return Response.json({id:'unexpected'});}return Response.json({id:'abc',threadId:'thread',snippet:'Can you review?',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Review'}],body:{data:encode('Can you review?')}}});};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',action:'send',body:'Thanks, received.'})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'sent-1',status:'sent'});assert.equal(sends,0);}finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

test('an expired dashboard session returns a usable sign-in destination',async()=>{
 const {GET:connectionStatus}=await import('../app/api/connection/route');
 const {api}=await import('../hooks/use-inbox');
 globalThis.__briefTestHeaders=new Headers();
 const original=globalThis.fetch;
 globalThis.fetch=async()=>connectionStatus();
 try{
  const response=await connectionStatus();
  assert.equal(response.status,401);
  const body=await response.json() as {signInUrl?:string};
  assert.equal(body.signInUrl,'/signin-with-chatgpt?return_to=%2F');
  await assert.rejects(api('/api/connection'),(error:unknown)=>{
   assert.equal((error as {signInUrl?:string}).signInUrl,body.signInUrl);
   return true;
  });
 }finally{globalThis.fetch=original;}
});

test('missing Gmail credentials are reported before starting Google OAuth',async()=>{
 const {GET:startGoogle}=await import('../app/api/auth/google/route');
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact Google before setup');};
 try{
  const response=await startGoogle();
  assert.equal(response.status,503);
  assert.match((await response.json() as {error:string}).error,/not configured yet\. Missing site settings: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET\./);
  assert.equal(called,false);
 }finally{globalThis.fetch=original;globalThis.__briefTestHeaders=new Headers();}
});

test('a Gmail token failure does not masquerade as a dashboard sign-in failure',async()=>{
 const {failure,HttpError}=await import('../server/runtime');
 const response=failure(new HttpError(401,'Reconnect Gmail.'));
 const body=await response.json() as {signInUrl?:string};
 assert.equal(response.status,401);
 assert.equal(body.signInUrl,undefined);
});

test('configured Gmail starts OAuth with PKCE and the exact callback origin',async()=>{
 const {GET:startGoogle}=await import('../app/api/auth/google/route');
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 let bound:unknown[]=[];
 const db={prepare(){return {bind(...values:unknown[]){bound=values;return this;},async run(){return {};}};}};
 globalThis.__briefTestEnv={...testEnv,GOOGLE_CLIENT_ID:'client-id',GOOGLE_CLIENT_SECRET:'client-secret',DB:db as unknown as D1Database};
 try{
  const response=await startGoogle();
  assert.equal(response.status,302);
  const destination=new URL(response.headers.get('location')!);
  assert.equal(destination.origin,'https://accounts.google.com');
  assert.equal(destination.searchParams.get('redirect_uri'),'https://brief.example/api/auth/google/callback');
  assert.equal(destination.searchParams.get('code_challenge_method'),'S256');
  assert.equal(destination.searchParams.get('state'),bound[0]);
  assert.equal(bound[1],'user-a');
  const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(bound[2])))));
  assert.equal(destination.searchParams.get('code_challenge'),challenge);
 }finally{globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

// Exercises the callback against the real migrations so schema drift fails here
// instead of silently redirecting the user back with a connection error.
test('completing Google OAuth stores the connection in the migrated schema',async()=>{
 const {DatabaseSync}=await import('node:sqlite');
 const fs=await import('node:fs/promises');
 const sqlite=new DatabaseSync(':memory:');
 const read=(file:string)=>fs.readFile(`${process.cwd()}/drizzle/${file}`,'utf8');
 const journal=JSON.parse(await read('meta/_journal.json')) as {entries:{tag:string}[]};
 for(const entry of journal.entries)sqlite.exec(await read(`${entry.tag}.sql`));
 const db={
  prepare(sql:string){
   const statement=sqlite.prepare(sql);let params:unknown[]=[];
   const bound={bind(...values:unknown[]){params=values;return bound;},
    first(){return statement.get(...params as never[])??null;},
    run(){const info=statement.run(...params as never[]);return {meta:{changes:Number(info.changes)}};},
    all(){return {results:statement.all(...params as never[])};}};
   return bound;
  },
  async batch(statements:{run():unknown}[]){return statements.map(statement=>statement.run());},

 };
 globalThis.__briefTestEnv={...testEnv,GOOGLE_CLIENT_ID:'client-id',GOOGLE_CLIENT_SECRET:'client-secret',DB:db as unknown as D1Database};
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const original=globalThis.fetch;
 globalThis.fetch=async(input)=>{
  const url=String(input as string|URL);
  if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'access',refresh_token:'refresh',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose'});
  return Response.json({emailAddress:'Person@Example.com'});
 };
 try{
  db.prepare('INSERT INTO oauth_states (state,user_id,verifier,expires) VALUES (?,?,?,?)').bind('state-1','user-a','verifier-1',Date.now()+600000).run();
  const {GET:callback}=await import('../app/api/auth/google/callback/route');
  const response=await callback(new Request('https://brief.example/api/auth/google/callback?state=state-1&code=code-1'));
  assert.equal(new URL(response.headers.get('location')!).search,'?connected=1');
  const stored=db.prepare('SELECT email, token FROM connections WHERE user_id = ?').bind('user-a').first() as {email:string;token:string};
  assert.equal(stored.email,'person@example.com');
  assert.equal(await decrypt(stored.token,'user-a',testEnv),'refresh');
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

const demoById=(id:string)=>{const found=demoEmails.find(m=>m.id===id);assert.ok(found,`demo email ${id} is missing`);return found;};

test('submenus start collapsed and each section toggles independently',()=>{
 assert.deepEqual(toggleExpanded([],'work'),['work']);
 // Expanding one section must not expand or collapse another.
 assert.deepEqual(toggleExpanded(['work'],'personal'),['work','personal']);
 assert.deepEqual(toggleExpanded(['work','personal'],'work'),['personal']);
 assert.deepEqual(toggleExpanded(['personal'],'personal'),[]);
});

test('parent views keep section mail that matches no subcategory',()=>{
 const untagged=demoById('18');
 assert.equal(untagged.category,'work');
 assert.deepEqual(emailTags(untagged),[]);
 assert.ok(selectEmails(demoEmails,'work').includes(untagged),'combined Work view must retain untagged work mail');
 assert.ok(!selectEmails(demoEmails,'work:deadlines').includes(untagged));
});

test('Inbox is the complete incoming view and Noise carries junk directly',()=>{
 assert.equal(selectEmails(demoEmails,'inbox').length,demoEmails.length);
 const noise=selectEmails(demoEmails,'noise');
 assert.ok(noise.length>0);
 assert.ok(noise.every(m=>m.category==='noise'));
 assert.equal(SECTIONS.find(s=>s.id==='noise')?.tags.length,0,'Noise has no submenu');
});

test('parent counts are unique while subcategory counts may overlap',()=>{
 const overlapping=demoById('50');
 // Copy before sorting: emailTags returns the message's own tag array.
 assert.deepEqual([...emailTags(overlapping)].sort(),['deadlines','meetings','research']);
 const work=sectionCount(demoEmails,'work');
 const summed=['deadlines','meetings','requests','actions','research'].reduce((total,tag)=>total+tagCount(demoEmails,'work',tag as Tag),0);
 assert.equal(work,new Set(selectEmails(demoEmails,'work').map(m=>m.id)).size,'parent count must be unique messages');
 assert.ok(summed>work,'overlapping tags should make subcategory counts exceed the unique parent count');
 // A message carrying several tags still appears once in the combined view.
 assert.equal(selectEmails(demoEmails,'work').filter(m=>m.id==='50').length,1);
});

test('subcategory views filter to their tag',()=>{
 const deadlines=selectEmails(demoEmails,'work:deadlines');
 assert.ok(deadlines.length>0);
 assert.ok(deadlines.every(m=>m.category==='work'&&emailTags(m).includes('deadlines')));
 const research=selectEmails(demoEmails,'work:research');
 assert.ok(research.some(m=>m.id==='50'),'a research message with other tags still appears under Research');
});

test('a research newsletter with an unsubscribe link is not junk',()=>{
 const digest=demoById('51');
 assert.ok(digest.unsubscribe,'this fixture must carry an unsubscribe link');
 assert.equal(digest.category,'work');
 assert.ok(emailTags(digest).includes('research'));
 assert.equal(classifyEmail(digest).category,'work','newsletter format alone must not prove junk');
});

test('urgent personal mail stays personal and reaches Overview',()=>{
 const urgent=demoById('54');
 assert.equal(urgent.category,'personal');
 assert.equal(classifyEmail(urgent).category,'personal');
 assert.ok(isImportantEmail(urgent),'urgent personal mail must qualify for Overview');
 assert.ok(!emailTags(urgent).includes('low-priority'));
});

test('bulk promotions are junk but a single promotional word is not',()=>{
 const promo=demoEmails.find(m=>m.id==='39');
 assert.ok(promo);
 assert.equal(classifyEmail(promo).category,'noise');
 const mild={...demoById('18'),subject:'Our team offsite deal is confirmed',body:'Just confirming the venue for the team offsite.'};
 assert.notEqual(classifyEmail(mild).category,'noise','one promotional word must not force junk');
});

test('view ids resolve to a section and optional tag',()=>{
 assert.deepEqual(parseView('work'),{section:'work',tag:undefined});
 assert.deepEqual(parseView('personal:low-priority'),{section:'personal',tag:'low-priority'});
 assert.deepEqual(parseView('overview'),{});
 assert.deepEqual(parseView('inbox'),{});
});

test('email rows show at most two compact category labels',()=>{
 for(const email of demoEmails)assert.ok(rowLabels(email).length<=2,`${email.id} produced more than two row labels`);
 assert.deepEqual(rowLabels(demoById('50')),['Research','Meetings']);
 assert.ok(!rowLabels(demoById('39')).includes('Junk'),'junk is shown by the Noise view, not as a row chip');
});

// ── Stage B: extraction, policy, validation ──────────────────────────────────

const normalized=(over:Partial<NormalizedMessage>={}):NormalizedMessage=>({
 id:'m1',threadId:'t1',messageId:'<m1>',receivedAt:Date.UTC(2026,8,14,15,0,0),
 from:{name:'Sam',address:'sam@studio.example'},to:[{name:'Alex',address:'alex@studio.example'}],cc:[],
 subject:'Subject',text:'Body text',quoted:'',signature:'',labels:['INBOX'],headers:{},
 attachments:[],htmlOnly:false,contentComplete:true,incompleteReasons:[],...over,
});

const obligation=(over:Partial<Obligation>={}):Obligation=>({
 id:'o1',kind:'request',description:'d',owner:'recipient',ownerIsUser:true,required:true,
 evidence:'e',state:'open',...over,
});
const classification=(over:Partial<Classification>={}):Classification=>({
 context:'work',topics:[],obligations:[],disposition:'useful',replyRequired:false,securityEvent:false,
 processingStatus:'classified',reason:'r',version:'test',...over,
});

test('HTML-only mail is read as text rather than from the snippet',()=>{
 const html=encode('<html><body><p>Please approve the <a href="https://x.example/doc">launch doc</a>.</p><script>alert(1)</script></body></html>');
 const result=normalizeMessage({id:'h1',threadId:'t',snippet:'Please approve',internalDate:'1789000000000',labelIds:['INBOX'],
  payload:{mimeType:'text/html',headers:[{name:'From',value:'A <a@b.example>'},{name:'Subject',value:'Doc'}],body:{data:html}}});
 assert.equal(result.htmlOnly,true);
 assert.match(result.text,/Please approve the launch doc \(https:\/\/x\.example\/doc\)\./);
 assert.ok(!result.text.includes('alert'),'script content must not survive');
 assert.equal(result.receivedAt,1789000000000,'the original timestamp must be preserved');
});

test('quoted history is separated from the current message',()=>{
 const body=encode('Thanks, that works.\n\nOn Mon, Sarah wrote:\n> Could you approve this by Friday?');
 const result=normalizeMessage({id:'q1',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
  payload:{mimeType:'text/plain',headers:[{name:'From',value:'S <s@x.example>'}],body:{data:body}}});
 assert.equal(result.text,'Thanks, that works.');
 assert.match(result.quoted,/approve this by Friday/);
});

test('incomplete content is flagged rather than silently dropped',()=>{
 const long=encode('x'.repeat(25000));
 const result=normalizeMessage({id:'l1',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
  payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'S <s@x.example>'}],parts:[
   {mimeType:'text/plain',body:{data:long}},
   {mimeType:'application/pdf',filename:'nda.pdf',body:{size:9000,attachmentId:'a1'}},
  ]}});
 assert.equal(result.contentComplete,false);
 assert.ok(result.incompleteReasons.includes('current-text-truncated'));
 assert.ok(result.incompleteReasons.includes('attachments-not-read'),'attachments are never claimed to be understood');
});

test('relative dates resolve against the message timestamp, not the refresh time',()=>{
 const monday=Date.UTC(2026,8,14,15,0,0);
 assert.equal(resolveDate('Friday',monday).date,'2026-09-18');
 assert.equal(resolveDate('tomorrow',monday).date,'2026-09-15');
 // Same phrase, different message: the answer must follow the message, not today.
 assert.equal(resolveDate('Friday',Date.UTC(2026,8,17,9,0,0)).date,'2026-09-18');
});

test('vague phrases never become dates and date-only deadlines gain no time',()=>{
 const vague=resolveDate('soon',Date.UTC(2026,8,14));
 assert.equal(vague.date,undefined);
 assert.equal(vague.ambiguous,true);
 assert.equal(vague.reason,'vague-phrase');
 assert.equal(vague.phrase,'soon','original wording is preserved');
 const dated=resolveDate('September 18',Date.UTC(2026,8,14));
 assert.equal(dated.date,'2026-09-18');
 assert.equal(dated.time,undefined,'a date-only deadline must not invent a time');
 const timed=resolveDate('Friday at 5 pm',Date.UTC(2026,8,14));
 assert.equal(timed.ambiguous,true);
 assert.equal(timed.reason,'timezone-unknown','a clock time without a zone is not silently resolved');
});

test('evidence must be quoted from the source message',()=>{
 const source=normalized({subject:'Launch',text:'Could you approve the   launch doc by Friday?'});
 assert.equal(evidenceSupported('approve the launch doc',source),true,'whitespace differences are tolerated');
 assert.equal(evidenceSupported('approve the budget instead',source),false);
 assert.equal(evidenceSupported('a',source),false,'trivially short quotes are rejected');
});

test('a batch keeps valid results and retries only missing or invalid ones',()=>{
 const batch=[normalized({id:'a',text:'Please approve the plan.'}),normalized({id:'b',text:'Please approve the plan.'}),normalized({id:'c',text:'Please approve the plan.'})];
 const good=(id:string)=>({id,context:'work',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'ok',
  obligations:[{kind:'request',description:'approve',owner:'recipient',ownerIsUser:'yes',required:true,evidence:'Please approve the plan.',state:'open'}]});
 const outcome=collectBatch({items:[
  good('a'),
  {...good('b'),context:'nonsense'},          // invalid value
  {id:'zzz',context:'work'},                   // unexpected id
 ]},batch);
 assert.deepEqual([...outcome.results.keys()],['a'],'the valid item survives its neighbours');
 assert.equal(outcome.failures.get('b'),'bad-context');
 assert.equal(outcome.failures.get('c'),'missing-result','a missing id is a failure, not a success');
 assert.ok(!outcome.results.has('zzz'),'unexpected ids are rejected');
});

test('duplicate results for one id are rejected',()=>{
 const batch=[normalized({id:'a',text:'Please approve the plan.'})];
 const item={id:'a',context:'work',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'ok',obligations:[]};
 const outcome=collectBatch({items:[item,item]},batch);
 assert.equal(outcome.results.has('a'),false);
 assert.equal(outcome.failures.get('a'),'duplicate-result');
});

test('unsupported evidence is rejected instead of stored as fact',()=>{
 const source=normalized({text:'The workshop notes are attached.'});
 const result=validateItem({id:'m1',context:'work',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'x',
  obligations:[{kind:'request',description:'approve',owner:'recipient',ownerIsUser:'yes',required:true,evidence:'Please approve the budget by Friday',state:'open'}]},source);
 assert.equal(result.ok,false);
 if(!result.ok)assert.equal(result.reason,'unsupported-evidence');
});

test('priority comes from evidence, not from the word urgent',()=>{
 const now=Date.UTC(2026,8,14);
 const shouty=classification({obligations:[obligation({kind:'action',evidence:'URGENT!!! do this'})]});
 assert.equal(derivePriority(shouty,now),'normal','claiming urgency must not raise priority');
 assert.equal(derivePriority(classification({securityEvent:true}),now),'high');
 const due=classification({obligations:[obligation({kind:'deadline',due:{phrase:'September 15',date:'2026-09-15',ambiguous:false}})]});
 assert.equal(derivePriority(due,now),'high','a supported near deadline does');
 const done={...due,obligations:[{...due.obligations[0],state:'completed' as const}]};
 assert.equal(derivePriority(done,now),'normal','a completed obligation is not urgent');
});

test('cancelled meetings stay as history but leave upcoming events',()=>{
 const cancelled=classification({obligations:[obligation({kind:'meeting',meetingState:'cancelled',state:'cancelled'})]});
 assert.ok(effectiveCategories(cancelled).tags.includes('meetings'),'still filed under Meetings');
 assert.equal(upcomingMeetings(cancelled).length,0,'but not an upcoming event');
 assert.equal(isOverviewMessage(cancelled,Date.UTC(2026,8,14)),false);
});

test('somebody else’s task does not become the user’s tag',()=>{
 const theirs=classification({obligations:[obligation({kind:'action',ownerIsUser:false})]});
 assert.ok(!effectiveCategories(theirs).tags.includes('actions'));
 const ambiguous=classification({obligations:[obligation({kind:'action',ownerIsUser:null})]});
 assert.ok(effectiveCategories(ambiguous).tags.includes('actions'),'ambiguous ownership is preserved, not discarded');
 assert.equal(needsReview(ambiguous),'unclear-task-owner');
});

test('personal mail with an open obligation is not marked low priority',()=>{
 const urgentPersonal=classification({context:'personal',obligations:[obligation({kind:'meeting',meetingState:'confirmed'})]});
 const mapped=effectiveCategories(urgentPersonal);
 assert.equal(mapped.category,'personal');
 assert.ok(!mapped.tags.includes('low-priority'));
 const quiet=effectiveCategories(classification({context:'personal'}));
 assert.deepEqual(quiet.tags,['low-priority']);
});

test('research is a topic and never implies an action',()=>{
 const paper=classification({topics:['research']});
 const mapped=effectiveCategories(paper);
 assert.deepEqual(mapped.tags,['research']);
 assert.ok(!mapped.tags.includes('actions'));
});

test('a junk prediction carrying a real obligation is sent for review',()=>{
 const conflicted=classification({disposition:'junk',obligations:[obligation({kind:'request'})]});
 assert.equal(needsReview(conflicted),'junk-with-open-obligation');
});

test('manual corrections outrank the classifier and survive reclassification',()=>{
 const junk=classification({disposition:'junk'});
 const corrected=applyOverride(junk,{messageId:'m1',addTags:[],removeTags:[],notJunk:true,source:'message',createdAt:0});
 assert.notEqual(effectiveCategories(corrected).category,'noise','marking not junk moves it out of Noise');
 assert.equal(corrected.override?.source,'message');
 const retagged=applyOverride(classification({context:'work'}),{messageId:'m1',addTags:['research'],removeTags:['requests'],notJunk:false,source:'message',createdAt:0});
 assert.ok(effectiveCategories(retagged).tags.includes('research'));
 const forced=applyOverride(classification({context:'work'}),{messageId:'m1',category:'personal',addTags:[],removeTags:[],notJunk:false,source:'message',createdAt:0});
 assert.equal(effectiveCategories(forced).category,'personal');
});

test('a fingerprint changes only when classification-relevant content changes',()=>{
 const base=normalized({subject:'Launch',text:'Approve please'});
 assert.equal(contentFingerprint(base),contentFingerprint(normalized({subject:'Launch',text:'Approve please'})));
 assert.notEqual(contentFingerprint(base),contentFingerprint(normalized({subject:'Launch',text:'Approve please now'})));
});

test('quoted requests do not create new obligations',()=>{
 const reply=deterministicClassify({id:'r1',subject:'Re: checklist',text:'Thanks, that all looks good.',
  quoted:'> Could you review the checklist and approve it by Friday?',
  from:{name:'S',address:'sarah@studio.example'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,14),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 assert.equal(reply.obligations.length,0,'an obligation quoted from history is not a new task');
});

// ── Evaluation: measured, deterministic, no live AI ──────────────────────────

type Scored={section:number;junkFalsePositive:number;junkTruePositive:number;junkFalseNegative:number;tagHits:number;tagChecks:number;total:number};

/** Baseline: the Stage A classifier, which reads the whole body including quoted history. */
function baselineSection(fixture:typeof FIXTURES[number]){
 const m=fixture.message;
 return classifyEmail({id:m.id,sender:m.from.name,address:m.from.address,initials:'',subject:m.subject,
  summary:m.text.slice(0,140),body:`${m.text}\n${m.quoted}`,time:'',category:'personal',priority:'normal',
  needsReply:false,unread:false,color:'gray'}).category;
}

function score(fixtures:typeof FIXTURES,mode:'baseline'|'new'):Scored{
 const out:Scored={section:0,junkFalsePositive:0,junkTruePositive:0,junkFalseNegative:0,tagHits:0,tagChecks:0,total:fixtures.length};
 for(const fixture of fixtures){
  let section:string;let tags:Tag[]=[];
  if(mode==='baseline'){section=baselineSection(fixture);}
  else{
   const result=deterministicClassify(fixture.message,'alex@studio.example');
   const mapped=effectiveCategories(result);
   section=mapped.category;tags=mapped.tags;
  }
  if(section===fixture.expect.section)out.section++;
  const predictedJunk=section==='noise';
  const actualJunk=fixture.expect.junk===true||fixture.expect.section==='noise';
  if(predictedJunk&&!actualJunk)out.junkFalsePositive++;
  if(predictedJunk&&actualJunk)out.junkTruePositive++;
  if(!predictedJunk&&actualJunk)out.junkFalseNegative++;
  if(mode==='new'){
   for(const tag of fixture.expect.tags||[]){out.tagChecks++;if(tags.includes(tag))out.tagHits++;}
   for(const tag of fixture.expect.notTags||[]){out.tagChecks++;if(!tags.includes(tag))out.tagHits++;}
  }
 }
 return out;
}

const percent=(n:number,d:number)=>d===0?'n/a':`${((n/d)*100).toFixed(0)}%`;

test('evaluation: the new classifier is measured against the previous one',()=>{
 const report:string[]=[];
 for(const [name,set] of [['dev',DEV_FIXTURES],['held-out',HELDOUT_FIXTURES],['all',FIXTURES]] as const){
  const before=score(set,'baseline');
  const after=score(set,'new');
  const junkPrecision=(s:Scored)=>s.junkTruePositive+s.junkFalsePositive===0?'n/a':percent(s.junkTruePositive,s.junkTruePositive+s.junkFalsePositive);
  const junkRecall=(s:Scored)=>s.junkTruePositive+s.junkFalseNegative===0?'n/a':percent(s.junkTruePositive,s.junkTruePositive+s.junkFalseNegative);
  report.push(
   `${name} (n=${set.length})`,
   `  section accuracy   baseline ${percent(before.section,before.total)}  ->  new ${percent(after.section,after.total)}`,
   `  junk precision     baseline ${junkPrecision(before)}  ->  new ${junkPrecision(after)}`,
   `  junk recall        baseline ${junkRecall(before)}  ->  new ${junkRecall(after)}`,
   `  legit mail in junk baseline ${before.junkFalsePositive}  ->  new ${after.junkFalsePositive}`,
   `  tag expectations   new ${percent(after.tagHits,after.tagChecks)} (${after.tagHits}/${after.tagChecks})`,
  );
 }
 console.log('\n'+report.join('\n')+'\n');

 const all=score(FIXTURES,'new');
 const baseline=score(FIXTURES,'baseline');
 // Junk precision is the metric that must not regress: legitimate mail in Noise is the
 // costly error. This asserts the measured outcome rather than a promise of accuracy.
 assert.equal(all.junkFalsePositive,0,'no legitimate message may be classified as junk');
 assert.ok(all.section>=baseline.section,'section accuracy must not regress against the baseline');
});

test('evaluation fixtures keep threads and near-duplicates in one split',()=>{
 const splits=new Map<string,string>();
 for(const fixture of FIXTURES){
  const family=fixture.id.replace(/-(same-sender|reschedule|cancelled|marketing|newsletter)$/,'');
  const existing=splits.get(family);
  if(existing)assert.equal(existing,fixture.split,`${family} spans splits`);
  splits.set(family,fixture.split);
 }
 assert.ok(DEV_FIXTURES.length>0&&HELDOUT_FIXTURES.length>0);
});

test('disconnecting removes manual corrections along with mail data',async()=>{
 const tables:string[]=[];
 const fakeDb={prepare(sql:string){tables.push(sql);return {bind(){return this;},async first(){return null;},async run(){return {};},async all(){return {results:[]};}};},
  async batch(statements:unknown[]){return statements;}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database};
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 try{
  const {POST:disconnect}=await import('../app/api/disconnect/route');
  await disconnect(new Request('https://brief.example/api/disconnect',{method:'POST',headers:{origin:'https://brief.example'}}));
  assert.ok(tables.some(sql=>sql.includes('DELETE FROM overrides')),'overrides must be cleared with the rest of the account data');
 }finally{globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
