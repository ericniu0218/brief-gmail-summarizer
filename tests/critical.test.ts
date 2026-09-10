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
 assert.equal(parsed.category,'noise');assert.equal(parsed.priority,'normal');assert.equal(parsed.address,'hello@news.example');assert.equal(parsed.body,'Hello, reader.');
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
  assert.match((await response.json() as {error:string}).error,/Google app credentials are not configured/);
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
