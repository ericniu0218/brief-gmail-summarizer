import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, encode, mutation, type Runtime } from '../server/runtime';
import { parseMessage, safeUnsubscribe } from '../server/gmail';
import { POST as reply } from '../app/api/reply/route';

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
test('one-click targets require trusted HTTPS domains without credentials or custom ports',()=>{
 assert.equal(safeUnsubscribe('https://news.list-manage.com/unsubscribe?id=1',testEnv),true);
 for(const url of ['http://news.list-manage.com/unsubscribe','https://list-manage.com.attacker.example','https://attacker.example','https://127.0.0.1','https://localhost','https://user:pass@list-manage.com','https://list-manage.com:8443'])assert.equal(safeUnsubscribe(url,testEnv),false,url);
});
test('newsletter headers cannot promote marketing to an urgent work item',()=>{
 const parsed=parseMessage({id:'abc',threadId:'thread',snippet:'Newsletter',internalDate:'1788960000000',labelIds:['INBOX','IMPORTANT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'Daily News <hello@news.example>'},{name:'Subject',value:'Our latest issue'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}],body:{data:encode('Hello, reader.')}}});
 assert.equal(parsed.category,'noise');assert.equal(parsed.priority,'normal');assert.equal(parsed.address,'hello@news.example');assert.equal(parsed.body,'Hello, reader.');
});
test('send endpoint rejects unauthenticated callers before contacting any provider',async()=>{
 const original=globalThis.fetch;let called=false;
 globalThis.fetch=async()=>{called=true;throw new Error('Must not contact a provider');};
 try{const response=await reply(new Request('https://brief.example/api/reply',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify({id:'abc',action:'send',body:'Hello'})}));assert.equal(response.status,401);assert.equal(called,false);}finally{globalThis.fetch=original;}
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
