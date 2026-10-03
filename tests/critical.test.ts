import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, encode, inputObject, mutation, type Runtime } from '../server/runtime';
import { parseMessage, safeUnsubscribe } from '../server/gmail';
import { describeUnsubscribe } from '../server/unsubscribe';
import { privateDestination } from '../server/gmail';
import { asCapability, asOutcome, listIdOf, newsletterIdentity, parseListUnsubscribe, requestKey, reasonFor, notice } from '../lib/unsubscribe';
import { POST as reply } from '../app/api/reply/route';
import { POST as suggest } from '../app/api/suggest/route';
import { generate } from '../server/ai';
import { actionAccountId, demoEmails, emailKey, senderKey, gmailThreadUrl, type Email } from '../lib/mail';
import { GET as demoDigest } from '../app/api/demo/route';
import { POST as runScheduledAgent } from '../app/api/agent/route';
import { summarizeInbox } from '../server/sync';
import { buildInboxRows, isImportantEmail, sortInboxEmails } from '../lib/inbox-priority';
import { SECTIONS, classifyEmail, emailTags, parseView, rowLabels, sectionCount, selectEmails, tagCount, toggleExpanded, type Tag } from '../lib/categories';
import { hydrateDeferredBodies, normalizeMessage, type GmailMessage, type NormalizedMessage } from '../server/message';
import { collectBatch, evidenceSupported, validateItem } from '../server/classify';
import { applyOverride, contentFingerprint } from '../server/overrides';
import { deterministicClassify } from '../lib/deterministic';
import { completeStoredEmail } from '../server/messages';
import { resolveDate } from '../lib/dates';
import { applyPolicy, derivePriority, effectiveCategories, isOverdue, needsReview, upcomingMeetings, type Classification, type Obligation } from '../lib/classification';
import { evaluateImportance } from '../lib/importance';
import { FIXTURES, DEV_FIXTURES, HELDOUT_FIXTURES, EVAL_NOW } from './eval-set';

declare global { var __briefTestEnv: Runtime; var __briefTestHeaders: Headers; }
/** Resolve a fetch argument to its URL, matching the helper used by the other suites. */
function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

const testEnv = {TOKEN_ENCRYPTION_KEY:encode(crypto.getRandomValues(new Uint8Array(32))),APP_URL:'https://brief.example'} as Runtime;
globalThis.__briefTestEnv=testEnv;
globalThis.__briefTestHeaders=new Headers();

void test('stored refresh tokens are encrypted and bound to the owning user',async()=>{
 const encrypted=await encrypt('sample-refresh-token','user-a',testEnv);
 assert.ok(!encrypted.includes('sample-refresh-token'));
 assert.equal(await decrypt(encrypted,'user-a',testEnv),'sample-refresh-token');
 await assert.rejects(decrypt(encrypted,'user-b',testEnv));
});
void test('rejects external-origin mutations and requests without an origin',()=>{
 assert.throws(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://attacker.example'}})));
 assert.throws(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST'})));
 assert.doesNotThrow(()=>mutation(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example'}})));
});
void test('JSON request bodies are bounded while streaming, without trusting Content-Length',async()=>{
 const oversized=new Request('https://brief.example/api/test',{method:'POST',body:JSON.stringify({value:'x'.repeat(20000)})});
 await assert.rejects(inputObject(oversized),(error:unknown)=>{assert.equal((error as {status?:number}).status,413);return true;});
 const malformed=new Request('https://brief.example/api/test',{method:'POST',body:'{"unfinished"'});
 await assert.rejects(inputObject(malformed),(error:unknown)=>{assert.equal((error as {status?:number}).status,400);return true;});
});
void test('the scheduled agent endpoint requires its secret and records a heartbeat',async()=>{
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
void test('one-click targets require trusted HTTPS domains without credentials or custom ports',()=>{
 assert.equal(safeUnsubscribe('https://news.list-manage.com/unsubscribe?id=1',testEnv),true);
 for(const url of ['http://news.list-manage.com/unsubscribe','https://list-manage.com.attacker.example','https://attacker.example','https://127.0.0.1','https://localhost','https://user:pass@list-manage.com','https://list-manage.com:8443'])assert.equal(safeUnsubscribe(url,testEnv),false,url);
});
void test('newsletter headers cannot promote marketing to an urgent work item',()=>{
 const parsed=parseMessage({id:'abc',threadId:'thread',snippet:'Newsletter',internalDate:'1788960000000',labelIds:['INBOX','IMPORTANT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Daily News <hello@news.example>'},{name:'Subject',value:'Our latest issue'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}],body:{data:encode('Hello, reader.')}}});
 // An unsubscribe header no longer forces Noise, but bulk mail still must not become urgent.
 assert.notEqual(parsed.category,'noise','an unsubscribe header alone must not prove junk');
 assert.equal(parsed.priority,'normal');assert.equal(parsed.address,'hello@news.example');assert.equal(parsed.body,'Hello, reader.');
});
void test('security and account-access mail is important even without Gmail Important',()=>{
 const parsed=parseMessage({id:'security',threadId:'thread',snippet:'Use code 482917 to finish signing in.',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'GitHub <noreply@github.com>'},{name:'Subject',value:'Your GitHub verification code'}],body:{data:encode('Use code 482917 to finish signing in.')}}});
 assert.equal(parsed.priority,'high');
 assert.equal(parsed.label,'Important');
 // Judged at a fixed instant just after the message arrived. A verification code matters
 // when it lands; the same message weeks later is history, and reading the real clock here
 // would make this test mean something different every day it runs.
 const arrived=1788960000000;
 assert.equal(isImportantEmail(parsed,arrived+3600000),true);
 assert.equal(isImportantEmail(parsed,arrived+30*86400000),false,'an old sign-in code is not urgent');
});
void test('reply-needed mail ranks first and routine mail stays at the bottom',()=>{
 const routine={...demoEmails[3],id:'routine',priority:'normal' as const,needsReply:false};
 const security={...demoEmails[3],id:'security',sender:'GitHub',address:'noreply@github.com',subject:'Security alert: new sign-in',priority:'high' as const,needsReply:false};
 const replyNeeded={...demoEmails[3],id:'reply',priority:'normal' as const,needsReply:true};
 assert.deepEqual(sortInboxEmails([routine,security,replyNeeded],Date.UTC(2026,8,14)).map(email=>email.id),['reply','security','routine']);
});
void test('related important company notifications fold without pulling routine mail into the group',()=>{
 const verification={...demoEmails[3],id:'verify',sender:'GitHub',address:'noreply@github.com',subject:'Your GitHub verification code',summary:'Use this code to sign in.',priority:'high' as const,needsReply:false};
 const setup={...demoEmails[3],id:'setup',sender:'GitHub Security',address:'security@github.com',subject:'Complete your two-factor setup',summary:'Finish account security setup.',priority:'high' as const,needsReply:true};
 const routine={...demoEmails[3],id:'routine',sender:'GitHub',address:'news@github.com',subject:'This month on GitHub',summary:'A product roundup.',priority:'normal' as const,needsReply:false};
 const rows=buildInboxRows([routine,verification,setup],Date.UTC(2026,8,14));
 assert.equal(rows[0].kind,'fold');
 if(rows[0].kind!=='fold')throw new Error('Expected a folded company row');
 assert.equal(rows[0].company,'GitHub');
 assert.deepEqual(rows[0].emails.map(email=>email.id),['setup','verify']);
 assert.equal(rows[0].needsReplyCount,1);
 assert.equal(rows[1].kind,'email');
 if(rows[1].kind==='email')assert.equal(rows[1].email.id,'routine');
});
void test('the demo inbox keeps useful work and noise classifications without AI',()=>{
 assert.ok(demoEmails.some(email=>email.category==='work'&&email.priority==='high'&&email.needsReply));
 assert.ok(demoEmails.some(email=>email.category==='noise'&&email.label==='Newsletter'));
 assert.ok(demoEmails.some(email=>email.category==='personal'&&email.needsReply));
});
void test('Gemini prepay depletion is reported as a billing-project problem',async()=>{
 const original=globalThis.fetch;let endpoint='';
 globalThis.fetch=async input=>{endpoint=requestUrl(input);return Response.json({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'}},{status:429});};
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
void test('Gemini JSON is rejected when it does not match the requested schema',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({candidates:[{content:{parts:[{text:'{"options":["only one"]}'}]},finishReason:'STOP'}]});
 try{
  await assert.rejects(
   generate('Return options.',{message:'test'},{type:'object',properties:{options:{type:'array',minItems:3,maxItems:3,items:{type:'string'}}},required:['options'],additionalProperties:false},{...testEnv,GEMINI_API_KEY:'test-key'}),
   (error:unknown)=>{assert.equal((error as {status?:number}).status,502);assert.match((error as Error).message,/expected format/i);return true;},
  );
 }finally{globalThis.fetch=original;}
});
void test('a Gemini outage does not prevent Gmail messages from loading',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({error:{message:'Your prepayment credits are depleted.'}},{status:429});
 const originalError=console.error;console.error=()=>{};
 try{
  const messages=demoEmails.slice(0,2);
  const result=await summarizeInbox(messages,{...testEnv,GEMINI_API_KEY:'test-key'});
  assert.equal(result.ai,false);assert.deepEqual(result.emails,messages);
 }finally{globalThis.fetch=original;console.error=originalError;}
});
void test('send endpoint rejects unauthenticated callers before contacting any provider',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',action:'send',body:'Hello'})}));assert.equal(response.status,401);assert.equal(called,false);}finally{globalThis.fetch=original;}
});
function sampleRequest(body:unknown){return new Request('https://brief.example/api/suggest',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify(body)});}
void test('sample replies reject unauthenticated callers before contacting any provider',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{const response=await suggest(sampleRequest({id:'1',tone:'Concise'}));assert.equal(response.status,401);assert.equal(called,false);}finally{globalThis.fetch=original;}
});
void test('a concurrent demo digest request uses deterministic fallback instead of duplicating Gemini work',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
void test('the demo digest stays available when Gemini is out of credit',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
void test('sample replies generate only from the demo inbox, never from caller-supplied text',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,GEMINI_API_KEY:'test-key'};
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{
  for(const id of ['does-not-exist','','99'])assert.equal((await suggest(sampleRequest({id,tone:'Concise'}))).status,400,id);
  assert.equal(called,false);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
void test('sample reply options send the chosen tone and regeneration attempt to the model',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,GEMINI_API_KEY:'test-key',GEMINI_MODEL:'test-model'};
 const original=globalThis.fetch;let url='';let sent:{systemInstruction:{parts:{text:string}[]};contents:{role:string;parts:{text:string}[]}[]}|null=null;
 globalThis.fetch=async(input,init)=>{url=requestUrl(input);sent=JSON.parse(typeof init?.body==='string'?init.body:'{}') as typeof sent;return Response.json({candidates:[{content:{parts:[{text:'{"options":["Hi Sarah, approving before 2 PM.","Hi Sarah, I will sign off shortly.","Hi Sarah, you have my approval."]}'}]},finishReason:'STOP'}]});};
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
void test('polishing a reply sends the user’s notes and rejects empty ones before contacting any provider',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
void test('a known successful send returns its receipt without sending a duplicate',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const encrypted=await encrypt('refresh','user-a',testEnv);
 const fakeDb={prepare(sql:string){return {bind(){return this;},async first(){if(sql.includes('FROM connections'))return {id:'acct-1',user_id:'user-a',provider_identity:null,email:'a@example.com',token:encrypted,token_version:1,last_sync:null,sync_lock:0,error:null,created:0};if(sql.includes('FROM operations'))return {status:'complete',result:'{"id":"sent-1","status":"sent"}'};return null;}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'};
 const original=globalThis.fetch;let sends=0;
 globalThis.fetch=async(input)=>{const url=requestUrl(input);if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'access'});if(url.includes('messages/send')){sends++;return Response.json({id:'unexpected'});}return Response.json({id:'abc',threadId:'thread',snippet:'Can you review?',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Review'}],body:{data:encode('Can you review?')}}});};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',accountId:'acct-1',action:'send',body:'Thanks, received.'})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'sent-1',status:'sent'});assert.equal(sends,0);}finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
void test('an unconfirmed reply retries only after the user confirms they checked Gmail',async()=>{
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const encrypted=await encrypt('refresh','user-a',testEnv);
 let operation:{status:string;result:string|null;created:number}|null={status:'unconfirmed',result:null,created:Date.now()-120000};
 const fakeDb={prepare(sql:string){return {bind(){return this;},async first(){
  if(sql.includes('FROM connections'))return {id:'acct-1',user_id:'user-a',provider_identity:null,email:'a@example.com',token:encrypted,token_version:1,last_sync:null,sync_lock:0,error:null,created:0};
  if(sql.includes('FROM operations'))return operation;
  return null;
 },async run(){
  if(sql.startsWith('DELETE FROM operations'))operation=null;
  else if(sql.startsWith('INSERT OR IGNORE INTO operations'))operation={status:'pending',result:null,created:Date.now()};
  else if(sql.startsWith("UPDATE operations SET status='complete'"))operation={status:'complete',result:'{"id":"draft-1","status":"drafted"}',created:Date.now()};
  return {meta:{changes:1}};
 }};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'};
 const original=globalThis.fetch;let drafts=0;
 globalThis.fetch=async(input)=>{const url=requestUrl(input);if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'access'});if(url.includes('/drafts')){drafts++;return Response.json({id:'draft-1'});}return Response.json({id:'abc',threadId:'thread',snippet:'Can you review?',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Review'}],body:{data:encode('Can you review?')}}});};
 const request=(confirmUnsent=false)=>new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',accountId:'acct-1',action:'draft',body:'Thanks, received.',confirmUnsent})});
 try{
  const blocked=await reply(request());assert.equal(blocked.status,409);assert.equal(drafts,0);
  const retried=await reply(request(true));assert.equal(retried.status,200);assert.deepEqual(await retried.json(),{id:'draft-1',status:'drafted'});assert.equal(drafts,1);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

void test('an expired dashboard session returns a usable sign-in destination',async()=>{
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

void test('missing Gmail credentials are reported before starting Google OAuth',async()=>{
 const {GET:startGoogle}=await import('../app/api/auth/google/route');
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact Google before setup');};
 try{
  const response=await startGoogle();
  assert.equal(response.status,503);
  assert.match((await response.json() as {error:string}).error,/not configured yet\. Missing site settings: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET\./);
  assert.equal(called,false);
 }finally{globalThis.fetch=original;globalThis.__briefTestHeaders=new Headers();}
});

void test('a Gmail token failure does not masquerade as a dashboard sign-in failure',async()=>{
 const {failure,HttpError}=await import('../server/runtime');
 const response=failure(new HttpError(401,'Reconnect Gmail.'));
 const body=await response.json() as {signInUrl?:string};
 assert.equal(response.status,401);
 assert.equal(body.signInUrl,undefined);
});

void test('configured Gmail starts OAuth with PKCE and the exact callback origin',async()=>{
 const {GET:startGoogle}=await import('../app/api/auth/google/route');
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
void test('completing Google OAuth stores the connection in the migrated schema',async()=>{
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
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
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
  const stored=db.prepare('SELECT id, email, token, token_version FROM connections WHERE user_id = ?').bind('user-a').first() as {id:string;email:string;token:string;token_version:number};
  assert.equal(stored.email,'person@example.com');
  // New credentials are written in the account-bound format and decrypt only with both
  // identifiers, so a token cannot be reused against a different mailbox.
  assert.equal(stored.token_version,2);
  assert.equal(await decrypt(stored.token,'user-a',testEnv,stored.id),'refresh');
  await assert.rejects(decrypt(stored.token,'user-a',testEnv,'other-account'));
  // The first mailbox a user connects becomes their default.
  const preference=db.prepare('SELECT default_account_id FROM account_preferences WHERE user_id = ?').bind('user-a').first() as {default_account_id:string};
  assert.equal(preference.default_account_id,stored.id);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

const demoById=(id:string)=>{const found=demoEmails.find(m=>m.id===id);assert.ok(found,`demo email ${id} is missing`);return found;};

void test('submenus start collapsed and each section toggles independently',()=>{
 assert.deepEqual(toggleExpanded([],'work'),['work']);
 // Expanding one section must not expand or collapse another.
 assert.deepEqual(toggleExpanded(['work'],'personal'),['work','personal']);
 assert.deepEqual(toggleExpanded(['work','personal'],'work'),['personal']);
 assert.deepEqual(toggleExpanded(['personal'],'personal'),[]);
});

void test('parent views keep section mail that matches no subcategory',()=>{
 const untagged=demoById('18');
 assert.equal(untagged.category,'work');
 assert.deepEqual(emailTags(untagged),[]);
 assert.ok(selectEmails(demoEmails,'work').includes(untagged),'combined Work view must retain untagged work mail');
 assert.ok(!selectEmails(demoEmails,'work:deadlines').includes(untagged));
});

void test('Inbox is the complete incoming view and Noise carries junk directly',()=>{
 assert.equal(selectEmails(demoEmails,'inbox').length,demoEmails.length);
 const noise=selectEmails(demoEmails,'noise');
 assert.ok(noise.length>0);
 assert.ok(noise.every(m=>m.category==='noise'));
 assert.equal(SECTIONS.find(s=>s.id==='noise')?.tags.length,0,'Noise has no submenu');
});

void test('email selection ignores nullish snapshot entries in every view',()=>{
 const malformed=[demoEmails[0],undefined,null,demoEmails[1]];
 assert.deepEqual(selectEmails(malformed,'inbox').map(email=>email.id),[demoEmails[0].id,demoEmails[1].id]);
 assert.doesNotThrow(()=>selectEmails(malformed,'work'));
 assert.doesNotThrow(()=>selectEmails(malformed,'work:deadlines'));
});

void test('parent counts are unique while subcategory counts may overlap',()=>{
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

void test('subcategory views filter to their tag',()=>{
 const deadlines=selectEmails(demoEmails,'work:deadlines');
 assert.ok(deadlines.length>0);
 assert.ok(deadlines.every(m=>m.category==='work'&&emailTags(m).includes('deadlines')));
 const research=selectEmails(demoEmails,'work:research');
 assert.ok(research.some(m=>m.id==='50'),'a research message with other tags still appears under Research');
});

void test('a research newsletter with an unsubscribe link is not junk',()=>{
 const digest=demoById('51');
 assert.ok(digest.unsubscribe,'this fixture must carry an unsubscribe link');
 assert.equal(digest.category,'work');
 assert.ok(emailTags(digest).includes('research'));
 assert.equal(classifyEmail(digest).category,'work','newsletter format alone must not prove junk');
});

void test('urgent personal mail stays personal and reaches Overview',()=>{
 const urgent=demoById('54');
 assert.equal(urgent.category,'personal');
 assert.equal(classifyEmail(urgent).category,'personal');
 assert.ok(isImportantEmail(urgent,Date.UTC(2026,8,14)),'urgent personal mail must qualify for Overview');
 assert.ok(!emailTags(urgent).includes('low-priority'));
});

void test('bulk promotions are junk but a single promotional word is not',()=>{
 const promo=demoEmails.find(m=>m.id==='39');
 assert.ok(promo);
 assert.equal(classifyEmail(promo).category,'noise');
 const mild={...demoById('18'),subject:'Our team offsite deal is confirmed',body:'Just confirming the venue for the team offsite.'};
 assert.notEqual(classifyEmail(mild).category,'noise','one promotional word must not force junk');
});

void test('view ids resolve to a section and optional tag',()=>{
 assert.deepEqual(parseView('work'),{section:'work',tag:undefined});
 assert.deepEqual(parseView('personal:low-priority'),{section:'personal',tag:'low-priority'});
 assert.deepEqual(parseView('overview'),{});
 assert.deepEqual(parseView('inbox'),{});
});

void test('email rows show at most two compact category labels',()=>{
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

void test('HTML-only mail is read as text rather than from the snippet',()=>{
 const html=encode('<html><body><p>Please approve the <a href="https://x.example/doc">launch doc</a>.</p><script>alert(1)</script></body></html>');
 const result=normalizeMessage({id:'h1',threadId:'t',snippet:'Please approve',internalDate:'1789000000000',labelIds:['INBOX'],
  payload:{mimeType:'text/html',headers:[{name:'From',value:'A <a@b.example>'},{name:'Subject',value:'Doc'}],body:{data:html}}});
 assert.equal(result.htmlOnly,true);
 assert.equal(result.html,'<html><body><p>Please approve the <a href="https://x.example/doc">launch doc</a>.</p><script>alert(1)</script></body></html>');
 assert.match(result.text,/Please approve the launch doc \(https:\/\/x\.example\/doc\)\./);
 assert.ok(!result.text.includes('alert'),'script content must not survive');
 assert.equal(result.receivedAt,1789000000000,'the original timestamp must be preserved');
});

void test('a CSS-filled plain alternative does not replace the readable rich body',()=>{
 const plain=encode('table.button table td {\nbackground: #003580;\nborder-color: #003580;\ncolor: white;\n}\na:hover { color: #19498c; }\na:active { color: #19498c; }');
 const rich='<html><head><style>table{color:#003580}</style></head><body><h1>Career newsletter</h1><p>Meet with a career educator.</p></body></html>';
 const result=normalizeMessage({id:'css-leak',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:['INBOX'],payload:{mimeType:'multipart/alternative',headers:[{name:'From',value:'Career <career@example.com>'}],parts:[
  {mimeType:'text/plain',body:{data:plain}},{mimeType:'text/html',body:{data:encode(rich)}},
 ]}});
 assert.equal(result.html,rich);
 assert.match(result.text,/Career newsletter/);
  assert.doesNotMatch(result.text,/border-color|a:hover/);
});

void test('sender-supplied plain text collapses excessive spacer lines',()=>{
 const plain=encode('Opening paragraph.\r\n\r\n\r\n   \r\n\r\nNext paragraph.\n\n\nFooter.');
 const result=normalizeMessage({id:'spaced',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:['INBOX'],
  payload:{mimeType:'text/plain',headers:[{name:'From',value:'Mailer <mail@example.com>'}],body:{data:plain}}});
 assert.equal(result.text,'Opening paragraph.\n\nNext paragraph.\n\nFooter.');
});

void test('quoted history is separated from the current message',()=>{
 const body=encode('Thanks, that works.\n\nOn Mon, Sarah wrote:\n> Could you approve this by Friday?');
 const result=normalizeMessage({id:'q1',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
  payload:{mimeType:'text/plain',headers:[{name:'From',value:'S <s@x.example>'}],body:{data:body}}});
 assert.equal(result.text,'Thanks, that works.');
 assert.match(result.quoted,/approve this by Friday/);
});

void test('incomplete content is flagged rather than silently dropped',()=>{
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

void test('Gmail bodies stored behind attachment ids are fetched before normalization',async()=>{
 const message:GmailMessage={id:'large',threadId:'t',snippet:'Fallback',internalDate:'1789000000000',labelIds:['INBOX'],
  payload:{mimeType:'multipart/alternative',headers:[{name:'From',value:'S <s@x.example>'}],parts:[
   {mimeType:'text/plain',body:{size:32,attachmentId:'body-1'}},
  ]}};
 const requested:string[]=[];
 await hydrateDeferredBodies(message,async id=>{requested.push(id);return {data:encode('The complete large message body.'),size:32};});
 const result=normalizeMessage(message);
 assert.deepEqual(requested,['body-1']);
 assert.equal(result.text,'The complete large message body.');
 assert.ok(!result.incompleteReasons.includes('body-stored-separately-by-gmail'));
});

void test('excessively nested MIME content is bounded and marked incomplete',()=>{
 let payload:{mimeType:string;body?:{data:string};parts?:typeof payload[]}={mimeType:'text/plain',body:{data:encode('deep body')}};
 for(let depth=0;depth<25;depth++)payload={mimeType:'multipart/mixed',parts:[payload]};
 const result=normalizeMessage({id:'deep',threadId:'t',snippet:'Safe fallback',internalDate:'1789000000000',labelIds:[],
  payload:{...payload,headers:[{name:'From',value:'S <s@x.example>'}]}});
 assert.equal(result.text,'Safe fallback');
 assert.equal(result.contentComplete,false);
 assert.ok(result.incompleteReasons.includes('mime-depth-limit'));
});

void test('sender identity falls back safely when From is missing',()=>{
 const withSender=normalizeMessage({id:'sender',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
  payload:{mimeType:'text/plain',headers:[{name:'Sender',value:'Service <service@example.com>'}],body:{data:encode('Hello')}}});
 assert.equal(withSender.from.address,'service@example.com');
 const unattributed=normalizeMessage({id:'unknown-1',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
  payload:{mimeType:'text/plain',headers:[],body:{data:encode('Hello')}}});
 assert.equal(unattributed.from.name,'Unknown sender');
 assert.equal(unattributed.from.address,'unattributed:unknown-1');
 assert.notEqual(unattributed.from.address,'');
});

void test('malformed Gmail structures are contained and marked incomplete',()=>{
 const malformed=[
  {id:'parts',threadId:'t',snippet:'Fallback',internalDate:'1789000000000',labelIds:[],
   payload:{mimeType:'multipart/mixed',headers:[],parts:[null]}},
  {id:'headers',threadId:'t',snippet:'',internalDate:'1789000000000',labelIds:[],
   payload:{mimeType:'text/plain',headers:null,body:{data:encode('Hello')}}},
  {id:'data',threadId:'t',snippet:'Fallback',internalDate:'1789000000000',labelIds:[],
   payload:{mimeType:'text/plain',headers:[],body:{data:42}}},
 ] as unknown as GmailMessage[];
 for(const message of malformed){
  const result=normalizeMessage(message);
  assert.equal(result.contentComplete,false,message.id);
  assert.ok(result.incompleteReasons.includes('malformed-message-structure'),message.id);
 }
});

void test('relative dates resolve against the message timestamp, not the refresh time',()=>{
 const monday=Date.UTC(2026,8,14,15,0,0);
 assert.equal(resolveDate('Friday',monday).date,'2026-09-18');
 assert.equal(resolveDate('tomorrow',monday).date,'2026-09-15');
 // Same phrase, different message: the answer must follow the message, not today.
 assert.equal(resolveDate('Friday',Date.UTC(2026,8,17,9,0,0)).date,'2026-09-18');
});

void test('vague phrases never become dates and date-only deadlines gain no time',()=>{
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

void test('evidence must be quoted from the source message',()=>{
 const source=normalized({subject:'Launch',text:'Could you approve the   launch doc by Friday?'});
 assert.equal(evidenceSupported('approve the launch doc',source),true,'whitespace differences are tolerated');
 assert.equal(evidenceSupported('approve the budget instead',source),false);
 assert.equal(evidenceSupported('a',source),false,'trivially short quotes are rejected');
});

void test('a batch keeps valid results and retries only missing or invalid ones',()=>{
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

void test('duplicate results for one id are rejected',()=>{
 const batch=[normalized({id:'a',text:'Please approve the plan.'})];
 const item={id:'a',context:'work',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'ok',obligations:[]};
 const outcome=collectBatch({items:[item,item]},batch);
 assert.equal(outcome.results.has('a'),false);
 assert.equal(outcome.failures.get('a'),'duplicate-result');
});

void test('unsupported evidence is rejected instead of stored as fact',()=>{
 const source=normalized({text:'The workshop notes are attached.'});
 const result=validateItem({id:'m1',context:'work',topics:[],disposition:'useful',replyRequired:false,securityEvent:false,reason:'x',
  obligations:[{kind:'request',description:'approve',owner:'recipient',ownerIsUser:'yes',required:true,evidence:'Please approve the budget by Friday',state:'open'}]},source);
 assert.equal(result.ok,false);
 if(!result.ok)assert.equal(result.reason,'unsupported-evidence');
});

void test('priority comes from evidence, not from the word urgent',()=>{
 const now=Date.UTC(2026,8,14);
 const shouty=classification({obligations:[obligation({kind:'action',evidence:'URGENT!!! do this'})]});
 assert.equal(derivePriority(shouty,now),'normal','claiming urgency must not raise priority');
 assert.equal(derivePriority(classification({securityEvent:true}),now),'high');
 const due=classification({obligations:[obligation({kind:'deadline',due:{phrase:'September 15',date:'2026-09-15',ambiguous:false}})]});
 assert.equal(derivePriority(due,now),'high','a supported near deadline does');
 const done={...due,obligations:[{...due.obligations[0],state:'completed' as const}]};
 assert.equal(derivePriority(done,now),'normal','a completed obligation is not urgent');
 const old=classification({obligations:[obligation({kind:'deadline',due:{phrase:'January 1, 2020',date:'2020-01-01',ambiguous:false}})]});
 assert.equal(derivePriority(old,now),'normal','an old deadline is overdue, not newly urgent');
 assert.equal(isOverdue(old.obligations[0],now),true);
 // Overview uses the message-aware importance policy, tested in importance.test.ts; a
 // classification alone has no arrival date and must not maintain a second policy.
});

void test('a corrupt stored classification without obligations degrades safely',()=>{
 const corrupt={...classification(),obligations:undefined} as unknown as Classification;
 assert.deepEqual(effectiveCategories(corrupt),{category:'work',tags:[]});
 assert.equal(derivePriority(corrupt,Date.UTC(2026,8,14)),'normal');
 assert.equal(needsReview(corrupt),undefined);
});

void test('cancelled meetings stay as history but leave upcoming events',()=>{
 const cancelled=classification({obligations:[obligation({kind:'meeting',meetingState:'cancelled',state:'cancelled'})]});
 assert.ok(effectiveCategories(cancelled).tags.includes('meetings'),'still filed under Meetings');
 assert.equal(upcomingMeetings(cancelled).length,0,'but not an upcoming event');
});

void test('somebody else’s task does not become the user’s tag',()=>{
 const theirs=classification({obligations:[obligation({kind:'action',ownerIsUser:false})]});
 assert.ok(!effectiveCategories(theirs).tags.includes('actions'));
 const ambiguous=classification({obligations:[obligation({kind:'action',ownerIsUser:null})]});
 assert.ok(effectiveCategories(ambiguous).tags.includes('actions'),'ambiguous ownership is preserved, not discarded');
 assert.equal(needsReview(ambiguous),'unclear-task-owner');
});

void test('personal mail with an open obligation is not marked low priority',()=>{
 const urgentPersonal=classification({context:'personal',obligations:[obligation({kind:'meeting',meetingState:'confirmed'})]});
 const mapped=effectiveCategories(urgentPersonal);
 assert.equal(mapped.category,'personal');
 assert.ok(!mapped.tags.includes('low-priority'));
 const quiet=effectiveCategories(classification({context:'personal'}));
 assert.deepEqual(quiet.tags,['low-priority']);
});

void test('research is a topic and never implies an action',()=>{
 const paper=classification({topics:['research']});
 const mapped=effectiveCategories(paper);
 assert.deepEqual(mapped.tags,['research']);
 assert.ok(!mapped.tags.includes('actions'));
});

void test('a junk prediction carrying a real obligation is sent for review',()=>{
 const conflicted=classification({disposition:'junk',obligations:[obligation({kind:'request'})]});
 assert.equal(needsReview(conflicted),'junk-with-open-obligation');
});

void test('manual corrections outrank the classifier and survive reclassification',()=>{
 const junk=classification({disposition:'junk'});
 const corrected=applyOverride(junk,{messageId:'m1',addTags:[],removeTags:[],notJunk:true,source:'message',createdAt:0});
 assert.notEqual(effectiveCategories(corrected).category,'noise','marking not junk moves it out of Noise');
 assert.equal(corrected.override?.source,'message');
 const retagged=applyOverride(classification({context:'work'}),{messageId:'m1',addTags:['research'],removeTags:['requests'],notJunk:false,source:'message',createdAt:0});
 assert.ok(effectiveCategories(retagged).tags.includes('research'));
 const forced=applyOverride(classification({context:'work'}),{messageId:'m1',category:'personal',addTags:[],removeTags:[],notJunk:false,source:'message',createdAt:0});
 assert.equal(effectiveCategories(forced).category,'personal');
 const invalidPersonalTag=applyOverride(classification({context:'personal'}),{messageId:'m1',addTags:['research'],removeTags:[],notJunk:false,source:'message',createdAt:0});
 assert.ok(!effectiveCategories(invalidPersonalTag).tags.includes('research'),'Work-only tags cannot leak into Personal');
 const removedJunk=applyOverride(junk,{messageId:'m1',addTags:[],removeTags:['junk'],notJunk:false,source:'message',createdAt:0});
 assert.notEqual(effectiveCategories(removedJunk).category,'noise','removing Junk is a not-junk correction');
 assert.ok(!effectiveCategories(removedJunk).tags.includes('junk'));
});

void test('a fingerprint changes only when classification-relevant content changes',()=>{
 const base=normalized({subject:'Launch',text:'Approve please'});
 assert.equal(contentFingerprint(base),contentFingerprint(normalized({subject:'Launch',text:'Approve please'})));
 assert.notEqual(contentFingerprint(base),contentFingerprint(normalized({subject:'Launch',text:'Approve please now'})));
});

void test('quoted requests do not create new obligations',()=>{
 const reply=deterministicClassify({id:'r1',subject:'Re: checklist',text:'Thanks, that all looks good.',
  quoted:'> Could you review the checklist and approve it by Friday?',
  from:{name:'S',address:'sarah@studio.example'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,14),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 assert.equal(reply.obligations.length,0,'an obligation quoted from history is not a new task');
});

void test('unsubscribe capability is read from the message, never guessed',()=>{
 const plan=(headers:Record<string,string|string[]>)=>{
  const headerValues:Record<string,string[]>={};
  const flat:Record<string,string>={};
  for(const [name,value] of Object.entries(headers)){
   headerValues[name]=Array.isArray(value)?value:[value];
   flat[name]=headerValues[name][headerValues[name].length-1];
  }
  return describeUnsubscribe({
   id:'m1',threadId:'t',messageId:'<m1>',receivedAt:Date.UTC(2026,8,20),
   from:{name:'News',address:'news@example.com'},to:[{name:'Alex',address:'alex@studio.example'}],cc:[],
   subject:'Issue 14',text:'Hello',quoted:'',signature:'',labels:['INBOX'],headers:flat,headerValues,
   attachments:[],htmlOnly:false,contentComplete:true,incompleteReasons:[]},testEnv);
 };
 // RFC 8058 only allows an automatic POST when the offer is covered by a passing signature.
 const signed={
  'authentication-results':'mx.google.com; dkim=pass header.d=list-manage.com; spf=pass',
  'dkim-signature':'v=1; a=rsa-sha256; d=list-manage.com; h=from:subject:list-unsubscribe:list-unsubscribe-post; b=xx',
 };

 const automatic=plan({...signed,'list-unsubscribe':'<https://news.list-manage.com/u?id=1>','list-unsubscribe-post':'List-Unsubscribe=One-Click'});
 assert.equal(automatic.capability,'one-click');
 assert.equal(automatic.automatic,'https://news.list-manage.com/u?id=1');

 // The same endpoint without the marker is a page to open, not a request to submit.
 assert.equal(plan({...signed,'list-unsubscribe':'<https://news.list-manage.com/u?id=1>'}).capability,'manual-page');

 // One-click claimed for a destination this server will not call: still offer the link.
 const unknownProvider=plan({...signed,'list-unsubscribe':'<https://mailer.unknown.example/u>','list-unsubscribe-post':'List-Unsubscribe=One-Click'});
 assert.equal(unknownProvider.capability,'manual-page','an unverified destination is not submitted automatically');
 assert.ok(unknownProvider.page,'but the person is not left with nothing');

 // A link that is not openable at all is reported as unverified, not offered.
 assert.equal(plan({'list-unsubscribe':'<https://user:pass@news.example/u>'}).capability,'unverified');
 assert.equal(plan({'list-unsubscribe':'<mailto:stop@news.example>'}).capability,'email-required');
 assert.equal(plan({}).capability,'none');
 // A footer link is never treated as instructions: only the header counts.
 assert.equal(plan({'list-id':'<weekly.news.example.com>'}).capability,'none');

 // An unsigned one-click claim is not automatic: anyone can write the header.
 assert.equal(plan({'list-unsubscribe':'<https://news.list-manage.com/u>','list-unsubscribe-post':'List-Unsubscribe=One-Click'}).capability,
  'manual-page','without a covering signature the offer is not trusted');
 // A signature that does not cover the two headers is the same as none.
 assert.equal(plan({'list-unsubscribe':'<https://news.list-manage.com/u>','list-unsubscribe-post':'List-Unsubscribe=One-Click',
  'authentication-results':'mx.google.com; dkim=pass header.d=list-manage.com',
  'dkim-signature':'v=1; d=list-manage.com; h=from:subject; b=xx'}).capability,'manual-page','the offer must be under the signature');
 // A pass reported for one domain cannot authorise another domain's signature.
 assert.equal(plan({'list-unsubscribe':'<https://news.list-manage.com/u>','list-unsubscribe-post':'List-Unsubscribe=One-Click',
  'authentication-results':'mx.google.com; dkim=pass header.d=attacker.example',
  'dkim-signature':'v=1; d=list-manage.com; h=list-unsubscribe:list-unsubscribe-post; b=xx'}).capability,'manual-page');
});

void test('malformed, folded, repeated and conflicting unsubscribe headers',()=>{
 // A folded header is one value split across lines; the continuation is not a new entry.
 const folded=parseListUnsubscribe(['<https://a.example/u>,\r\n  <mailto:stop@a.example>']);
 assert.deepEqual(folded.https,['https://a.example/u']);
 assert.deepEqual(folded.mailto,['mailto:stop@a.example']);

 // The same header twice with the same content is a harmless duplicate.
 const duplicate=parseListUnsubscribe(['<https://a.example/u>','<https://a.example/u>']);
 assert.equal(duplicate.conflicting,false);
 assert.deepEqual(duplicate.https,['https://a.example/u']);

 // Two headers pointing somewhere different: neither can be attributed to the sender.
 const conflicting=parseListUnsubscribe(['<https://a.example/u>','<https://b.example/u>']);
 assert.equal(conflicting.conflicting,true);
 assert.deepEqual(conflicting.https,[],'nothing is picked when the sender contradicts itself');

 // Values that carry no usable method.
 for(const bad of ['','   ','https://a.example/u','<>','not a header'])
  assert.deepEqual(parseListUnsubscribe([bad]).https,[],JSON.stringify(bad));
 assert.equal(parseListUnsubscribe(['<https://a.example/'+'x'.repeat(3000)+'>']).https.length,0,'an oversized value is refused');
 assert.equal(parseListUnsubscribe(undefined).https.length,0);
});

void test('a server unsubscribe request never reaches a private or deceptive address',()=>{
 for(const url of [
  'https://127.0.0.1/u','https://10.0.0.5/u','https://192.168.1.1/u','https://172.16.4.4/u',
  'https://169.254.169.254/latest/meta-data','https://100.64.0.1/u','https://localhost/u',
  'https://intranet/u','https://mail.internal/u','https://[::1]/u','https://0.0.0.0/u',
  'https://list-manage.com.attacker.example/u','https://notlist-manage.com/u',
  'http://news.list-manage.com/u','https://news.list-manage.com:8443/u','https://user:pass@news.list-manage.com/u',
 ])assert.equal(safeUnsubscribe(url,testEnv),false,url);
 assert.equal(safeUnsubscribe('https://news.list-manage.com/u',testEnv),true);
 // A trailing dot is the same host and must not slip past the boundary check.
 assert.equal(safeUnsubscribe('https://news.list-manage.com./u',testEnv),true);
 assert.equal(privateDestination('news.list-manage.com'),false);
});

void test('two newsletters from one publisher keep separate identities',()=>{
 const weekly=newsletterIdentity('m1','Weekly Roundup <weekly.news.example.com>');
 const alerts=newsletterIdentity('m2','<alerts.news.example.com>');
 assert.equal(weekly.scope,'list');
 assert.equal(weekly.listId,'weekly.news.example.com','the bracketed identity, without the display phrase');
 assert.notEqual(requestKey('acct-1',weekly),requestKey('acct-1',alerts),'one sender, two lists, two records');
 // The same newsletter in two mailboxes is two separate records.
 assert.notEqual(requestKey('acct-1',weekly),requestKey('acct-2',weekly));
 // With no List-ID the record stays tied to the message rather than claiming the sender.
 const unnamed=newsletterIdentity('m3',undefined);
 assert.equal(unnamed.scope,'message');
 assert.equal(requestKey('acct-1',unnamed),'acct-1:message:m3');
 // A display phrase with no bracketed identity identifies nothing.
 assert.equal(newsletterIdentity('m4','Our Weekly Roundup').scope,'message');
 assert.equal(listIdOf('<'+'x'.repeat(300)+'>'),undefined,'an oversized value is refused');
});

void test('stored capability and outcome values are validated, not trusted',()=>{
 for(const good of ['one-click','manual-page','email-required','none','unverified','unavailable'])
  assert.equal(asCapability(good),good);
 for(const bad of ['unsubscribed',42,null,undefined,{},'ONE-CLICK'])
  assert.equal(asCapability(bad),undefined,JSON.stringify(bad));
 for(const good of ['none','pending','accepted','action-required','failed','unknown'])
  assert.equal(asOutcome(good),good);
 for(const bad of ['ok',true,'accepted ',''])assert.equal(asOutcome(bad),undefined,JSON.stringify(bad));
 // A row written by an older version drops the unknown value instead of surfacing it.
 assert.equal(completeStoredEmail({id:'m1',unsubscribeCapability:'totally-unsubscribed'})?.unsubscribeCapability,undefined);
 assert.equal(completeStoredEmail({id:'m1',unsubscribeCapability:'one-click'})?.unsubscribeCapability,'one-click');
});

void test('a completion elsewhere in the message does not resolve a live deadline',()=>{
 // Found by rating a labelled set: "everyone received the point", three paragraphs below,
 // marked a problem set due in two days as completed, which removed it from Important.
 const result=deterministicClassify({id:'ext1',subject:'Problem set 4 deadline moved to Monday',
  text:'Problem set 4 is now due Monday at 11:59pm. No extensions beyond that date.\n\nQuestion 3 was poorly worded and everyone received the point.',
  quoted:'',from:{name:'Dan',address:'dan@berkeley.edu'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,25),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 const deadline=result.obligations.find(o=>o.kind==='deadline');
 assert.ok(deadline,'the deadline is still extracted');
 assert.equal(deadline!.state,'open','an unrelated completion sentence does not finish it');

 // A completion stated in the obligation's own sentence still resolves it.
 const done=deterministicClassify({id:'ext2',subject:'Problem set 4',
  text:'Problem set 4 was due Monday at 11:59pm and I received your submission, so you are all set.',
  quoted:'',from:{name:'Dan',address:'dan@berkeley.edu'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,25),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 assert.equal(done.obligations.find(o=>o.kind==='deadline')?.state,'completed','a real completion still counts');
});

void test('an instruction for how to cancel is not a cancellation',()=>{
 // Found by rating a labelled set: "Reply CANCEL to release this slot" convinced the
 // classifier that an appointment the next morning had been cancelled.
 const reminder=deterministicClassify({id:'cx1',subject:'Appointment reminder: tomorrow 11:20am',
  text:'This is a reminder of your appointment tomorrow at 11:20am. Please arrive ten minutes early.\n\nReply CANCEL to release this slot.',
  quoted:'',from:{name:'Clinic',address:'clinic@uhs.berkeley.edu'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,25),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 const meeting=reminder.obligations.find(o=>o.kind==='meeting');
 assert.ok(meeting,'the appointment is still an obligation');
 assert.notEqual(meeting!.meetingState,'cancelled','an instruction is not a cancellation');
 assert.equal(meeting!.state,'open');

 // A real cancellation is still read as one.
 const called=deterministicClassify({id:'cx2',subject:'Cancelled: sprint planning Friday',
  text:'Cancelling Friday sprint planning, we will fold it into Monday standup instead.',
  quoted:'',from:{name:'Sarah',address:'sarah@studio.example'},to:[{address:'alex@studio.example'}],cc:[],
  receivedAt:Date.UTC(2026,8,25),labels:['INBOX'],attachments:[],contentComplete:true},'alex@studio.example');
 assert.equal(called.obligations.find(o=>o.kind==='meeting')?.meetingState,'cancelled','a real cancellation still counts');
});

void test('deterministic classification tolerates missing recipient arrays',()=>{
 const input={id:'missing-recipients',subject:'Hello',text:'No action needed.',quoted:'',
  from:{name:'S',address:'sender@example.com'},receivedAt:Date.UTC(2026,8,14),
  labels:['INBOX'],attachments:[],contentComplete:true} as unknown as Parameters<typeof deterministicClassify>[0];
 assert.doesNotThrow(()=>deterministicClassify(input,'alex@example.com'));
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

void test('evaluation: the new classifier is measured against the previous one',()=>{
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

/**
 * Promotion outcomes, reported separately because they fail in different directions: a
 * promotion in Work or Important costs attention, legitimate mail in Noise costs a missed
 * obligation. A promotion is any fixture whose expected section is Noise.
 */
function promotionReport(fixtures:typeof FIXTURES){
 const out={promotions:0,promotionsInWork:0,promotionsImportant:0,promotionsToNoise:0,legit:0,legitToNoise:0,importantLegit:0,importantDemoted:0,misses:[] as string[]};
 for(const fixture of fixtures){
  const result=deterministicClassify(fixture.message,'alex@studio.example');
  const section=applyPolicy(result,EVAL_NOW).category;
  const important=evaluateImportance({...fixture.message,classification:result} as never,EVAL_NOW).important;
  if(fixture.expect.section==='noise'){
   out.promotions++;
   if(section==='work'){out.promotionsInWork++;out.misses.push(`${fixture.id}: promotion in Work`);}
   if(important){out.promotionsImportant++;out.misses.push(`${fixture.id}: promotion Important`);}
   if(section==='noise')out.promotionsToNoise++;
  }else{
   out.legit++;
   if(section==='noise'){out.legitToNoise++;out.misses.push(`${fixture.id}: legitimate mail in Noise`);}
   if(fixture.expect.important){out.importantLegit++;if(!important){out.importantDemoted++;out.misses.push(`${fixture.id}: important mail demoted`);}}
  }
 }
 return out;
}

void test('evaluation: promotions are kept out of Work and Important without burying legitimate mail',()=>{
 const report:string[]=[];
 for(const [name,set] of [['dev',DEV_FIXTURES],['held-out',HELDOUT_FIXTURES],['all',FIXTURES]] as const){
  const r=promotionReport(set);
  report.push(
   `${name} (promotions ${r.promotions}, legitimate ${r.legit})`,
   `  promotions filed in Work          ${r.promotionsInWork}`,
   `  promotions marked Important       ${r.promotionsImportant}`,
   `  promotions routed to Noise        ${r.promotionsToNoise}/${r.promotions} (${percent(r.promotionsToNoise,r.promotions)})`,
   `  legitimate mail routed to Noise   ${r.legitToNoise}`,
   `  important legitimate mail demoted ${r.importantDemoted}/${r.importantLegit}`,
  );
 }
 const all=promotionReport(FIXTURES);
 if(all.misses.length)report.push('  misses: '+all.misses.join('; '));
 console.log('\n'+report.join('\n')+'\n');
 // A small synthetic suite measures these rules; it is not evidence of production accuracy.
 assert.equal(all.promotionsInWork,0,all.misses.join('; '));
 assert.equal(all.promotionsImportant,0,all.misses.join('; '));
 assert.equal(all.legitToNoise,0,all.misses.join('; '));
 assert.equal(all.importantDemoted,0,all.misses.join('; '));
});

void test('evaluation fixtures keep threads and near-duplicates in one split',()=>{
 const splits=new Map<string,string>();
 for(const fixture of FIXTURES){
  const family=fixture.family??fixture.id.replace(/-(same-sender|reschedule|cancelled|marketing|newsletter)$/,'');
  const existing=splits.get(family);
  if(existing)assert.equal(existing,fixture.split,`${family} spans splits`);
  splits.set(family,fixture.split);
 }
 assert.ok(DEV_FIXTURES.length>0&&HELDOUT_FIXTURES.length>0);
});

void test('disconnecting removes manual corrections along with mail data',async()=>{
 const tables:string[]=[];
 const token=await encrypt('refresh','user-a',testEnv);
 // Disconnect now names one owned mailbox, so the fake connection must look real.
 const connection={id:'acct-1',user_id:'user-a',provider_identity:null,email:'a@example.com',token,token_version:1,last_sync:null,sync_lock:0,error:null,created:0};
 const fakeDb={prepare(sql:string){tables.push(sql);return {bind(){return this;},async first(){return sql.includes('FROM connections')?connection:null;},async run(){return {};},async all(){return {results:[]};}};},
  async batch(statements:unknown[]){return statements;}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database};
 globalThis.__briefTestHeaders=new Headers({'x-brief-identity-secret':'test-ingress-secret-for-authenticated-proxy', 'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.fetch=async()=>Response.json({});
 try{
  const {POST:disconnect}=await import('../app/api/disconnect/route');
  await disconnect(new Request('https://brief.example/api/disconnect',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({accountId:'acct-1'})}));
  assert.ok(tables.some(sql=>sql.includes('DELETE FROM overrides')),'overrides must be cleared with the rest of the account data');
  assert.ok(tables.some(sql=>sql.includes('DELETE FROM connections WHERE id = ? AND user_id = ?')),'only the named account is removed');
 }finally{globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});

// ── Multi-account: composite identity and account-scoped keys ───────────────

void test('the same message id in two mailboxes has distinct keys',()=>{
 const a={id:'m1',accountId:'acct-1',address:'sender@x.example'} as unknown as Email;
 const b={id:'m1',accountId:'acct-2',address:'sender@x.example'} as unknown as Email;
 assert.notEqual(emailKey(a),emailKey(b),'React keys must not collide across mailboxes');
 assert.notEqual(senderKey(a),senderKey(b),'unsubscribing in one mailbox is not the other');
});

void test('a message-specific action refuses to run without a real mailbox',()=>{
 // The combined view is a way of looking at mail, not an account that can act.
 assert.throws(()=>actionAccountId({accountId:'all'}),/Refresh your inbox/);
 // An unattributed message reached the browser damaged; guessing an account here is how a
 // reply leaves from the wrong address, so it is refused with a recoverable instruction.
 assert.throws(()=>actionAccountId({accountId:undefined}),/Refresh your inbox/);
 assert.throws(()=>actionAccountId({accountId:''}),/Refresh your inbox/);
 // A genuine mailbox passes through untouched.
 assert.equal(actionAccountId({accountId:'acct-2'}),'acct-2');
});

void test('Gmail links name the mailbox instead of assuming the first account',()=>{
 const link=gmailThreadUrl('second@example.com','thread-1');
 assert.ok(link.includes('authuser=second%40example.com'));
 assert.ok(!link.includes('/u/0/'),'a hardcoded account index opens the wrong mailbox');
});

void test('the combined view is never accepted as a sending account',async()=>{
 const {ALL_INBOXES}=await import('../server/gmail');
 assert.equal(ALL_INBOXES,'all');
});

void test('an attached invitation survives an AI outage and a cancellation',()=>{
 const base={id:'m1',subject:'Attachment',text:'See the file.',quoted:'',from:{name:'S',address:'s@org.example'},
  to:[{address:'me@org.example'}],cc:[],receivedAt:Date.UTC(2026,8,24),labels:['INBOX'],attachments:[],contentComplete:true};
 // The deterministic classifier is the fallback when the model is unavailable. Without
 // reading the invitation, an ICS-only meeting would simply disappear until the next
 // successful classification.
 const invited=deterministicClassify({...base,calendar:{method:'REQUEST',summary:'Design review',
  start:'2026-10-14T16:00:00Z',status:'CONFIRMED',uid:'u1'}} as never,'me@org.example');
 const meeting=invited.obligations.find(o=>o.kind==='meeting');
 assert.ok(meeting,'the invitation became a meeting obligation');
 assert.equal(meeting.due?.time,'2026-10-14T16:00:00.000Z','with the exact start it states');
 assert.equal(meeting.due?.ambiguous,false,'an invitation is never an ambiguous date');
 assert.equal(meeting.meetingState,'confirmed');
 assert.equal(meeting.required,true);

 const cancelled=deterministicClassify({...base,calendar:{method:'CANCEL',summary:'Design review',
  start:'2026-10-14T16:00:00Z',status:'CANCELLED',uid:'u1'}} as never,'me@org.example');
 const off=cancelled.obligations.find(o=>o.kind==='meeting');
 assert.equal(off?.state,'cancelled');
 assert.equal(off?.meetingState,'cancelled');
 assert.equal(off?.required,false,'a called-off meeting is not required work');

 // A malformed start invents nothing, and wording still works without an invitation.
 const broken=deterministicClassify({...base,calendar:{summary:'x',start:'not-a-date'}} as never,'me@org.example');
 assert.ok(!broken.obligations.some(o=>o.kind==='meeting'),'an unreadable start creates no meeting');
 const worded=deterministicClassify({...base,text:'Are you free for a meeting on Friday?'} as never,'me@org.example');
 assert.ok(worded.obligations.some(o=>o.kind==='meeting'),'wording alone still detects a meeting');
});

void test('an oversized calendar part is reported as incomplete content',()=>{
 // Gmail stores large bodies separately. A deferred invitation that is never fetched must
 // mark the message incomplete rather than leaving it looking complete with no meeting.
 const message=normalizeMessage({id:'c',threadId:'t',snippet:'',internalDate:'1790000000000',labelIds:['INBOX'],
  payload:{mimeType:'multipart/mixed',headers:[{name:'From',value:'S <s@org.example>'},{name:'Subject',value:'Invite'}],
   parts:[{mimeType:'text/plain',body:{data:encode('See attached.')}},
          {mimeType:'text/calendar',body:{attachmentId:'att-1',size:900000}}]}});
 assert.equal(message.contentComplete,false,'the message says its content is incomplete');
 assert.ok(message.incompleteReasons.length>0,'and says why');
});

// A real message from the Berkeley bulk mailer. It names a genuine date, but taking the
// survey is an invitation with a prize draw, not a task the reader owes anyone.
const pulseSurvey={
 id:'pulse',subject:'Chance at $100 - Take the Pulse Survey by September 25',
 text:`Dear Berkeley undergraduate student,
We invite you to take the fall 2026 Student Pulse Survey. These confidential, three-minute Pulse Surveys capture your feedback so UC Berkeley can better support you. As a token of our appreciation, if you complete the survey, you will have a chance to win a $100 gift card of your choice.
This Pulse Survey asks for your thoughts on your experiences around basic needs, and campus software and hardware. The last day to submit your responses is Friday, September 25, 2026.
Congratulations to the following recipients of $100 gift cards from the Spring 2026 Pulse Survey.
Thanking you in advance for your participation in the survey.`,
 quoted:'',from:{name:"Oliver O'Reilly",address:'communications@berkeley.edu'},
 to:[{address:'ethan_ko@berkeley.edu'}],cc:[],receivedAt:Date.UTC(2026,8,22,16,0,0),
 labels:['INBOX'],attachments:[],contentComplete:true,
};

void test('an invitation with a deadline is not a task the reader owes',()=>{
 const now=Date.UTC(2026,8,24,12,0,0);
 const classification=deterministicClassify(pulseSurvey as never,'ethan_ko@berkeley.edu');
 const email={id:'pulse',accountId:'a',category:'work',priority:'normal',needsReply:false,
  subject:pulseSurvey.subject,body:pulseSurvey.text,summary:'',receivedAt:pulseSurvey.receivedAt,
  classification} as unknown as Email;

 // The deadline is real and is read correctly; what changes is whose job it is.
 const deadline=classification.obligations.find(o=>o.kind==='deadline');
 assert.ok(deadline,'the stated date is still recognised');
 assert.equal(deadline.due?.date,'2026-09-25');
 assert.equal(deadline.required,false,'an invitation is not a requirement');

 // "We invite you" is not a meeting. Nothing here is scheduled.
 assert.ok(!classification.obligations.some(o=>o.kind==='meeting'),'the word "invite" alone is not a meeting');
 assert.ok(!effectiveCategories(classification).tags.includes('meetings'));

 // So it stays ordinary mail: readable, filed, tagged — just not demanding attention.
 assert.equal(isImportantEmail(email,now),false,'it no longer claims a place in Important now');
 assert.notEqual(effectiveCategories(classification).category,'noise','and it is not junk either');
 assert.ok(effectiveCategories(classification).tags.includes('deadlines'),'the date is still visible as a deadline');
});

void test('a genuine institutional deadline is still important',()=>{
 const now=Date.UTC(2026,8,24,12,0,0);
 // Same shape of sender and the same closeness of date. The difference is that this one
 // asks the reader to do something, and says what happens if they do not.
 const enrolment=deterministicClassify({...pulseSurvey,id:'benefits',
  subject:'Action required: benefits enrolment closes September 25',
  text:'Please submit your benefit elections. Open enrolment closes on Friday, September 25, 2026. If you do not respond, your current elections carry over.',
 } as never,'ethan_ko@berkeley.edu');
 const email={id:'benefits',accountId:'a',category:'work',priority:'normal',needsReply:false,
  subject:'Action required',body:'',summary:'',receivedAt:pulseSurvey.receivedAt,
  classification:enrolment} as unknown as Email;
 assert.ok(enrolment.obligations.some(o=>o.required),'a real instruction is still required work');
 assert.equal(isImportantEmail(email,now),true,'and still reaches Important now');
});

void test('a real meeting is still detected without the word invite',()=>{
 const meeting=deterministicClassify({...pulseSurvey,id:'sync',
  subject:'Design review',
  text:'Can we meet Thursday? I have booked a Zoom meeting for the design review at 10am.',
 } as never,'ethan_ko@berkeley.edu');
 assert.ok(meeting.obligations.some(o=>o.kind==='meeting'),'wording that names a meeting still works');
});

void test('an invitation is judged by what is attached to it, not by the word invited',()=>{
 const now=Date.UTC(2026,8,24,12,0,0),received=Date.UTC(2026,8,23,9,0,0);
 const rate=(subject:string,text:string,from='recruiting@acme.example')=>{
  const classification=deterministicClassify({id:'x',subject,text,quoted:'',from:{name:'R',address:from},
   to:[{address:'ethan_ko@berkeley.edu'}],cc:[],receivedAt:received,labels:['INBOX'],
   attachments:[],contentComplete:true} as never,'ethan_ko@berkeley.edu');
  return {classification,important:isImportantEmail({id:'x',accountId:'a',category:'work',priority:'normal',
   needsReply:false,subject,body:text,summary:'',receivedAt:received,classification} as unknown as Email,now)};
 };

 // Being invited says nothing by itself. A job interview is an appointment the reader
 // has every reason to see, and it must not be quietened by the word "invited".
 assert.equal(rate('Interview invitation',
  'You are invited to a job interview for the Software Engineer position on Friday, September 25, 2026 at 10am. Please let me know if that time works.').important,
  true,'an interview invitation is important');
 assert.equal(rate('Next steps',
  'We would like to invite you to interview with our team. Could you confirm your availability by September 25, 2026?').important,
  true,'however the invitation happens to be phrased');

 // What makes one optional is the incentive attached, or wording that says so outright.
 const survey=rate('Chance at $100 - Pulse Survey',
  'We invite you to take the Pulse Survey. You will have a chance to win a $100 gift card. The last day to submit your responses is Friday, September 25, 2026.',
  'communications@berkeley.edu');
 assert.equal(survey.important,false,'a prize draw is an offer, not work');
 assert.ok(survey.classification.obligations.every(o=>!o.required));
 assert.equal(rate('Feedback survey',
  'We invite you to share feedback. Participation is voluntary. The survey closes on Friday, September 25, 2026.',
  'communications@berkeley.edu').important,false,'stated voluntariness is believed');

 // An explicit requirement overrides the invitation framing entirely.
 assert.equal(rate('Mandatory compliance training',
  'You are invited to the mandatory compliance training. You must complete it by Friday, September 25, 2026.',
  'hr@acme.example').important,true,'"you must complete it by Friday" is real work');

 // And nothing here loosened the guard on marketing.
 assert.equal(rate('Flash sale',
  'Order now before the deal ends Friday, September 25, 2026. Limited time, 50% off, hurry while supplies last.',
  'offers@shop.example').important,false,'a countdown is still not a deadline');
 assert.equal(rate('Weekly digest','Here is your weekly product update. No action needed.',
  'newsletter@acme.example').important,false,'a newsletter still asks nothing');
});

void test('a date the message states reaches the obligation it states',()=>{
 const received=Date.UTC(2026,8,23,9,0,0);
 // The date used to be attached only when the wording matched the deadline pattern, so
 // "you must complete it by Friday" produced an action that could never become urgent.
 const mandatory=deterministicClassify({id:'x',subject:'Training',
  text:'You must complete the compliance training by Friday, September 25, 2026.',quoted:'',
  from:{name:'HR',address:'hr@acme.example'},to:[{address:'ethan_ko@berkeley.edu'}],cc:[],
  receivedAt:received,labels:['INBOX'],attachments:[],contentComplete:true} as never,'ethan_ko@berkeley.edu');
 const action=mandatory.obligations.find(o=>o.kind==='action');
 assert.ok(action,'the requirement became an obligation');
 assert.equal(action.due?.date,'2026-09-25','carrying the date the message gave');

 // A meeting described in plain text carries its date too.
 const meeting=deterministicClassify({id:'y',subject:'Design review',
  text:'Can we meet on Friday, September 25, 2026? I have booked a Zoom meeting at 10am.',quoted:'',
  from:{name:'S',address:'s@acme.example'},to:[{address:'ethan_ko@berkeley.edu'}],cc:[],
  receivedAt:received,labels:['INBOX'],attachments:[],contentComplete:true} as never,'ethan_ko@berkeley.edu');
 assert.equal(meeting.obligations.find(o=>o.kind==='meeting')?.due?.date,'2026-09-25');
});

void test('a manual unsubscribe page is reported as a page to open', () => {
  assert.equal(reasonFor('manual-page', 'none'), 'open-page');
  assert.equal(notice('open-page').action, 'page');
  assert.equal(reasonFor('none', 'none'), 'no-instructions');
});
