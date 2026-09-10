import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, encode, mutation, type Runtime } from '../server/runtime';
import { parseMessage, safeUnsubscribe } from '../server/gmail';
import { POST as reply } from '../app/api/reply/route';
import { POST as suggest } from '../app/api/suggest/route';

declare global { var __briefTestEnv: Runtime; var __briefTestHeaders: Headers; }
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
void test('one-click targets require trusted HTTPS domains without credentials or custom ports',()=>{
 assert.equal(safeUnsubscribe('https://news.list-manage.com/unsubscribe?id=1',testEnv),true);
 for(const url of ['http://news.list-manage.com/unsubscribe','https://list-manage.com.attacker.example','https://attacker.example','https://127.0.0.1','https://localhost','https://user:pass@list-manage.com','https://list-manage.com:8443'])assert.equal(safeUnsubscribe(url,testEnv),false,url);
});
void test('newsletter headers cannot promote marketing to an urgent work item',()=>{
 const parsed=parseMessage({id:'abc',threadId:'thread',snippet:'Newsletter',internalDate:'1788960000000',labelIds:['INBOX','IMPORTANT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Daily News <hello@news.example>'},{name:'Subject',value:'Our latest issue'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}],body:{data:encode('Hello, reader.')}}});
 assert.equal(parsed.category,'noise');assert.equal(parsed.priority,'normal');assert.equal(parsed.address,'hello@news.example');assert.equal(parsed.body,'Hello, reader.');
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
void test('sample replies generate only from the demo inbox, never from caller-supplied text',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,OPENAI_API_KEY:'test-key'};
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{
  for(const id of ['does-not-exist','','99'])assert.equal((await suggest(sampleRequest({id,tone:'Concise'}))).status,400,id);
  assert.equal(called,false);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
void test('sample replies send the chosen tone and regeneration attempt to the model',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 globalThis.__briefTestEnv={...testEnv,OPENAI_API_KEY:'test-key',OPENAI_MODEL:'test-model'};
 const original=globalThis.fetch;let sent:{instructions:string;input:string;model:string}|null=null;
 globalThis.fetch=async(_input,init)=>{sent=JSON.parse(typeof init?.body==='string'?init.body:'{}') as typeof sent;return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'{"reply":"Hi Sarah, sending approval before 2 PM."}'}]}]});};
 try{
  const response=await suggest(sampleRequest({id:'1',tone:'Professional',variation:2}));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{reply:'Hi Sarah, sending approval before 2 PM.'});
  const payload=sent!;
  assert.equal(payload.model,'test-model');
  assert.match(payload.instructions,/Tone: Professional/);
  assert.match(payload.instructions,/regeneration/);
  const modelInput=JSON.parse(payload.input) as {subject:string;tone:string;attempt:number};
  assert.equal(modelInput.subject,'Website launch — final approval');
  assert.equal(modelInput.tone,'Professional');
  assert.equal(modelInput.attempt,2);
 }finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
});
void test('a known successful send returns its receipt without sending a duplicate',async()=>{
 globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
 const encrypted=await encrypt('refresh','user-a',testEnv);
 const fakeDb={prepare(sql:string){return {bind(){return this;},async first(){if(sql.includes('FROM connections'))return {id:'user-a',user_id:'user-a',email:'a@example.com',token:encrypted};if(sql.includes('FROM operations'))return {status:'complete',result:'{"id":"sent-1","status":"sent"}'};return null;}};}};
 globalThis.__briefTestEnv={...testEnv,DB:fakeDb as unknown as D1Database,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'};
 const original=globalThis.fetch;let sends=0;
 globalThis.fetch=async(input)=>{const url=input instanceof Request?input.url:input.toString();if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'access'});if(url.includes('messages/send')){sends++;return Response.json({id:'unexpected'});}return Response.json({id:'abc',threadId:'thread',snippet:'Can you review?',internalDate:'1788960000000',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Review'}],body:{data:encode('Can you review?')}}});};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',accountId:'user-a',action:'send',body:'Thanks, received.'})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'sent-1',status:'sent'});assert.equal(sends,0);}finally{globalThis.fetch=original;globalThis.__briefTestEnv=testEnv;globalThis.__briefTestHeaders=new Headers();}
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

void test('a Gmail token failure does not masquerade as a dashboard sign-in failure',async()=>{
 const {failure,HttpError}=await import('../server/runtime');
 const response=failure(new HttpError(401,'Reconnect Gmail.'));
 const body=await response.json() as {signInUrl?:string};
 assert.equal(response.status,401);
 assert.equal(body.signInUrl,undefined);
});

void test('configured Gmail starts OAuth with PKCE and the exact callback origin',async()=>{
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

void test('calendar weeks cross month boundaries and begin on Monday',async()=>{
 const {weekDays,dateKey}=await import('../lib/calendar');
 assert.deepEqual(weekDays(new Date(2026,8,6)).map(dateKey),['2026-08-31','2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05','2026-09-06']);
});
void test('calendar resolves email dates against receipt date and rejects invalid dates',async()=>{
 const {emailDates}=await import('../lib/calendar');
 const {demoEmails}=await import('../lib/mail');
 const email={...demoEmails[0],subject:'Plans',body:'Tomorrow and Thursday. September 12, 2026. 2026-09-31.',receivedAt:new Date(2026,8,9,12).getTime()};
 assert.deepEqual(emailDates(email).sort(),['2026-09-10','2026-09-12']);
 assert.deepEqual(emailDates({...email,receivedAt:undefined,body:'Tomorrow'}),[]);
 assert.deepEqual(emailDates({...email,body:'Tomorrow',receivedAt:new Date(2026,11,31,12).getTime()}),['2027-01-01']);
});

void test('next event skips past dates and noise and selects the nearest date',async()=>{
 const {nextEmailEvent}=await import('../lib/calendar');
 const {demoEmails}=await import('../lib/mail');
 const make=(id:string,body:string)=>({...demoEmails[0],id,subject:'Event',body});
 const emails=[make('later','2026-09-15'),make('past','2026-09-08'),{...make('noise','2026-09-09'),category:'noise' as const},make('next','2026-09-10')];
 assert.equal(nextEmailEvent(emails,new Date(2026,8,9))?.email.id,'next');
 assert.equal(nextEmailEvent(emails,new Date(2026,8,16)),undefined);
});

void test('calendar resolves multiline weekdays and does not invent dates from explicit weekday labels',async()=>{
 const {emailDates}=await import('../lib/calendar');
 const {demoEmails}=await import('../lib/mail');
 const email={...demoEmails[0],subject:'Plans',receivedAt:new Date(2026,8,20,12).getTime()};
 assert.deepEqual(emailDates({...email,body:'Thursday, September 10, 2026.'}),['2026-09-10']);
 assert.deepEqual(emailDates({...email,body:'This\nSaturday'}),['2026-09-19']);
});
void test('account state discards disconnected mailbox data and restores the demo after the last disconnect',async()=>{
 const {reconcileInbox}=await import('../lib/inbox-state');
 const {demoEmails}=await import('../lib/mail');
 const mail=[{...demoEmails[0],accountId:'a'},{...demoEmails[0],accountId:'b'}];
 const remaining={connected:true,accounts:[{id:'b'}],defaultAccountId:'b'};
 const result=reconcileInbox(remaining,mail,[{accountId:'a'},{accountId:'b'}],'a');
 assert.equal(result.activeAccountId,'b');
 assert.deepEqual(result.emails.map(m=>m.accountId),['b']);
 assert.deepEqual(result.snapshots,[{accountId:'b'}]);
 const empty=reconcileInbox({connected:false,accounts:[],defaultAccountId:null},mail,[],'all');
 assert.equal(empty.activeAccountId,null);
 assert.equal(empty.emails,demoEmails);
});

void test('the client reports an unreadable API response without exposing parser errors',async()=>{
 const {api,ApiError}=await import('../hooks/use-inbox');
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('<html>Service unavailable</html>',{status:503});
 try{await assert.rejects(api('/api/mailbox'),error=>error instanceof ApiError&&error.message.includes('Please try again'));}finally{globalThis.fetch=original;}
});

void test('the launch approval appears once in the calendar and ignores past feedback references',async()=>{
 const {emailDates}=await import('../lib/calendar');
 const {demoEmails}=await import('../lib/mail');
 const today=new Date(2026,8,10,12);
 assert.deepEqual(emailDates(demoEmails[0],today),['2026-09-10']);
 assert.deepEqual(emailDates({...demoEmails[0],body:'We incorporated feedback from last Monday. The launch is Thursday.'},today),['2026-09-10']);
 // An invitation received earlier in the week still belongs on its scheduled day.
 assert.deepEqual(emailDates({...demoEmails[0],receivedAt:new Date(2026,8,7,12).getTime(),body:'Meeting tomorrow.'}),['2026-09-08']);
});
