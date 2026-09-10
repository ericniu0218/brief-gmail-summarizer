import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { encrypt, encode, type Runtime } from '../server/runtime';
import { connection } from '../server/gmail';
import { mailbox } from '../server/mailbox';
import type { ConnectionStatus } from '../hooks/use-inbox';
import { demoEmails, emailKey } from '../lib/mail';
import { POST as reply } from '../app/api/reply/route';
import { GET as status, POST as setDefault } from '../app/api/connection/route';
import { POST as disconnect } from '../app/api/disconnect/route';
import { POST as unsubscribe } from '../app/api/unsubscribe/route';
import { GET as oauthCallback } from '../app/api/auth/google/callback/route';
import { POST as refresh } from '../app/api/sync/route';

// Execute the actual migration and SQL through SQLite, using D1's async interface.
function database(migrate=true){
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync('drizzle/0000_warm_patch.sql','utf8'));
  if(migrate)sql.exec(readFileSync('drizzle/0001_multiple_gmail_accounts.sql','utf8'));
  const db={
    prepare(query:string){
      let values:(string|number|null)[]=[];
      return {bind(...input:(string|number|null)[]){values=input;return this;},
        async first(){return sql.prepare(query).get(...values)||null;},
        async all(){return {results:sql.prepare(query).all(...values)};},
        async run(){return {meta:{changes:Number(sql.prepare(query).run(...values).changes)}};}};
    },
    async batch(statements:{run:()=>Promise<unknown>}[]){
      sql.exec('BEGIN');
      try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}
      catch(error){sql.exec('ROLLBACK');throw error;}
    },
  };
  return {sql,db:db as unknown as D1Database};
}
function urlOf(input:RequestInfo|URL){return input instanceof Request?input.url:input.toString();}
function tokenBody(body:BodyInit|null|undefined){return body instanceof URLSearchParams?body:new URLSearchParams(typeof body==='string'?body:'');}
async function readStatus(){return await (await status()).json() as ConnectionStatus;}
function request(path:string,body:unknown){return new Request(`https://brief.example/api/${path}`,{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:JSON.stringify(body)});}
async function fixture(){
  const {sql,db}=database();
  const e={DB:db,APP_URL:'https://brief.example',TOKEN_ENCRYPTION_KEY:encode(crypto.getRandomValues(new Uint8Array(32))),GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'} as Runtime;
  for(const [id,user,email] of [['a','user-a','a@example.com'],['b','user-a','b@example.com'],['foreign','user-b','other@example.com']]){
    sql.prepare('INSERT INTO connections(id,user_id,email,token) VALUES(?,?,?,?)').run(id,user,email,await encrypt(`refresh-${id}`,user,e));
    const data={emails:[{...demoEmails[0],id:'same-id',receivedAt:id==='b'?200:100}],updated:1,ai:false,hasMore:id==='b'};
    sql.prepare('INSERT INTO snapshots VALUES(?,?,?,?)').run(user,id,JSON.stringify(data),1);
  }
  sql.prepare('INSERT INTO account_preferences VALUES(?,?)').run('user-a','a');
  globalThis.__briefTestEnv=e;
  globalThis.__briefTestHeaders=new Headers({'oai-authenticated-user-id':'user-a','oai-authenticated-user-email':'a@example.com'});
  const originalFetch=globalThis.fetch;
  return {sql,e,close(){sql.close();globalThis.fetch=originalFetch;globalThis.__briefTestHeaders=new Headers();}};
}

void test('migration preserves legacy tokens, cached emails, preferences, and send receipts',()=>{
  const {sql}=database(false);
  try{
    sql.exec("INSERT INTO connections VALUES('user-a','A@example.com','encrypted-token',123,0,NULL); INSERT INTO snapshots VALUES('user-a','{\"emails\":[]}',123); INSERT INTO operations VALUES('receipt','user-a','complete','sent'); INSERT INTO unsubscribed VALUES('mute','user-a','sender@example.com',123);");
    sql.exec(readFileSync('drizzle/0001_multiple_gmail_accounts.sql','utf8'));
    assert.equal(sql.prepare('SELECT token FROM connections WHERE id=?').get('user-a')?.token,'encrypted-token');
    assert.equal(sql.prepare('SELECT default_account_id FROM account_preferences').get()?.default_account_id,'user-a');
    for(const table of ['snapshots','operations','unsubscribed'])assert.equal(sql.prepare(`SELECT account_id FROM ${table}`).get()?.account_id,'user-a');
    sql.exec("INSERT INTO connections(id,user_id,email,token) VALUES('second','user-a','b@example.com','another-token')");
    assert.equal(sql.prepare('SELECT count(*) AS count FROM connections').get()?.count,2);
  }finally{sql.close();}
});
void test('combined inbox retains colliding message ids, sorts by date, and excludes other users',async()=>{
  const f=await fixture();
  try{
    const data=await mailbox('user-a',f.e);
    assert.deepEqual(data.emails.map(m=>m.accountId),['b','a']);
    assert.equal(new Set(data.emails.map(emailKey)).size,2);
    assert.deepEqual(data.emails.map(m=>m.accountEmail),['b@example.com','a@example.com']);
    assert.equal(data.accounts.find(a=>a.accountId==='b')?.hasMore,true);
    await assert.rejects(connection('user-a',f.e,'foreign'));
  }finally{f.close();}
});
void test('default account is persisted and cannot be changed to another user’s account',async()=>{
  const f=await fixture();
  try{
    assert.equal((await setDefault(request('connection',{accountId:'b'}))).status,200);
    assert.equal((await readStatus()).defaultAccountId,'b');
    assert.equal((await connection('user-a',f.e)).id,'b');
    assert.equal((await setDefault(request('connection',{accountId:'foreign'}))).status,409);
    assert.equal((await connection('user-a',f.e)).id,'b');
  }finally{f.close();}
});
void test('disconnect removes only the chosen account and picks a remaining default',async()=>{
  const f=await fixture();
  globalThis.fetch=async()=>new Response('',{status:200});
  try{
    assert.equal((await disconnect(request('disconnect',{accountId:'a'}))).status,200);
    const data=await mailbox('user-a',f.e);
    assert.deepEqual(data.emails.map(m=>m.accountId),['b']);
    assert.equal((await readStatus()).defaultAccountId,'b');
    assert.ok(f.sql.prepare('SELECT id FROM connections WHERE id=?').get('foreign'));
    assert.equal((await disconnect(request('disconnect',{accountId:'b'}))).status,200);
    assert.equal((await readStatus()).connected,false);
  }finally{f.close();}
});
void test('reply sends through its owning account and deduplicates separately for matching message ids',async()=>{
  const f=await fixture();const sends:string[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:tokenBody(init?.body).get('refresh_token')});
    const auth=new Headers(init?.headers).get('Authorization')!;
    if(url.includes('messages/send')){sends.push(auth);return Response.json({id:`sent-${sends.length}`});}
    return Response.json({id:'same-id',threadId:'thread',snippet:'Hello',internalDate:'100',labelIds:[],payload:{headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'Subject',value:'Hello'}]}});
  };
  try{
    for(const id of ['a','b','b'])assert.equal((await reply(request('reply',{id:'same-id',accountId:id,action:'send',body:'Thank you.'}))).status,200);
    assert.deepEqual(sends,['Bearer refresh-a','Bearer refresh-b']);
    assert.equal((await reply(request('reply',{id:'same-id',accountId:'foreign',action:'send',body:'Thank you.'}))).status,409);
    assert.equal((await reply(request('reply',{id:'same-id',action:'send',body:'Thank you.'}))).status,400);
    assert.equal(sends.length,2);
  }finally{f.close();}
});
void test('unsubscribe is isolated to the selected account',async()=>{
  const f=await fixture();
  globalThis.fetch=async(input)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('gmail.googleapis.com'))return Response.json({id:'same-id',threadId:'thread',snippet:'News',internalDate:'100',labelIds:[],payload:{headers:[{name:'From',value:'Sarah <sarah@studio.example>'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}]}});
    return new Response('',{status:200});
  };
  try{
    assert.equal((await unsubscribe(request('unsubscribe',{id:'same-id',accountId:'a'}))).status,200);
    const data=await mailbox('user-a',f.e);
    assert.deepEqual(data.emails.map(m=>m.accountId),['b']);
    assert.equal(f.sql.prepare('SELECT account_id FROM unsubscribed').get()?.account_id,'a');
  }finally{f.close();}
});
void test('OAuth adds and reconnects one account without replacing other mail or the default',async()=>{
  const f=await fixture();let email='new@example.com';
  globalThis.fetch=async(input)=>urlOf(input).includes('/token')?Response.json({access_token:'access',refresh_token:'new-refresh',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose'}):Response.json({emailAddress:email});
  try{
    for(const address of ['new@example.com','a@example.com']){
      email=address;
      f.sql.prepare('INSERT INTO oauth_states VALUES(?,?,?,?)').run('state','user-a','verifier',Date.now()+10000);
      const result=await oauthCallback(new Request('https://brief.example/api/auth/google/callback?state=state&code=code'));
      assert.equal(result.headers.get('location'),'https://brief.example/?connected=1');
    }
    const result=await readStatus();
    assert.equal(result.accounts.length,3);
    assert.equal(result.defaultAccountId,'a');
    assert.equal((await mailbox('user-a',f.e)).emails.length,2);
  }finally{f.close();}
});
void test('combined refresh keeps failed accounts cached while updating healthy accounts',async()=>{
  const f=await fixture();
  globalThis.fetch=async(_input,init)=>{
    if(tokenBody(init?.body).get('refresh_token')==='refresh-a')return new Response('',{status:401});
    if(urlOf(_input).includes('/token'))return Response.json({access_token:'b'});
    return Response.json({messages:[]});
  };
  try{
    const response=await refresh(request('sync',{accountId:'all'}));
    assert.equal(response.status,200);
    const result=await response.json() as Awaited<ReturnType<typeof mailbox>> & {errors:{accountId:string}[]};
    assert.equal(result.errors.length,1);
    assert.equal(result.errors[0].accountId,'a');
    assert.deepEqual(result.emails.map(m=>m.accountId),['a']);
    assert.equal(f.sql.prepare('SELECT sync_lock FROM connections WHERE id=?').get('b')?.sync_lock,0);
  }finally{f.close();}
});

void test('a confirmed reply remains successful when Gmail is unavailable on retry',async()=>{
  const f=await fixture();
  globalThis.fetch=async(input)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('messages/send'))return Response.json({id:'sent-once'});
    return Response.json({id:'same-id',threadId:'thread',snippet:'Hello',internalDate:'100',labelIds:[],payload:{headers:[{name:'From',value:'sender@example.com'}]}});
  };
  const body={id:'same-id',accountId:'a',action:'send',body:'Thank you.'};
  try{
    assert.equal((await reply(request('reply',body))).status,200);
    globalThis.fetch=async()=>{throw new Error('Gmail is offline');};
    const response=await reply(request('reply',body));
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{id:'sent-once',status:'sent'});
  }finally{f.close();}
});
void test('a stale sync snapshot cannot restore a replied flag or an unsubscribed sender',async()=>{
  const f=await fixture();
  globalThis.fetch=async(input)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('messages/send'))return Response.json({id:'sent-once'});
    if(url.includes('gmail.googleapis.com'))return Response.json({id:'same-id',threadId:'thread',snippet:'Hello',internalDate:'100',labelIds:[],payload:{headers:[{name:'From',value:'sarah@studio.example'},{name:'List-Unsubscribe',value:'<https://news.list-manage.com/u>'},{name:'List-Unsubscribe-Post',value:'List-Unsubscribe=One-Click'}]}});
    return new Response('',{status:200});
  };
  try{
    const stale=f.sql.prepare('SELECT data FROM snapshots WHERE account_id=?').get('a')!.data;
    assert.equal((await reply(request('reply',{id:'same-id',accountId:'a',action:'send',body:'Thanks.'}))).status,200);
    f.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(stale,'a');
    assert.equal((await mailbox('user-a',f.e)).emails.find(m=>m.accountId==='a')?.needsReply,false);
    assert.equal((await unsubscribe(request('unsubscribe',{id:'same-id',accountId:'a'}))).status,200);
    f.sql.prepare('UPDATE snapshots SET data=? WHERE account_id=?').run(stale,'a');
    assert.deepEqual((await mailbox('user-a',f.e)).emails.map(m=>m.accountId),['b']);
  }finally{f.close();}
});
void test('AI failure does not prevent newly fetched Gmail messages from appearing',async()=>{
  const f=await fixture();globalThis.__briefTestEnv={...f.e,OPENAI_API_KEY:'test-key'};
  globalThis.fetch=async(input)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('/responses'))return new Response('quota',{status:429});
    if(url.includes('messages?'))return Response.json({messages:[{id:'new-mail'}]});
    return Response.json({id:'new-mail',threadId:'thread',snippet:'New mail preview',internalDate:'200',labelIds:[],payload:{headers:[{name:'From',value:'sender@example.com'}]}});
  };
  try{
    const response=await refresh(request('sync',{accountId:'a'}));
    const result=await response.json() as Awaited<ReturnType<typeof mailbox>>;
    assert.ok(result.emails.some(m=>m.id==='new-mail'&&m.accountId==='a'));
    assert.equal(result.accounts.find(a=>a.accountId==='a')?.ai,false);
  }finally{f.close();}
});

void test('live reply suggestions use the selected account and do not assume the sender is Alex',async()=>{
  const f=await fixture();globalThis.__briefTestEnv={...f.e,OPENAI_API_KEY:'test-key'};
  let instructions='';let replyFrom='';
  globalThis.fetch=async(input,init)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('/responses')){
      const payload=JSON.parse(typeof init?.body==='string'?init.body:'{}') as {instructions:string;input:string};
      instructions=payload.instructions;replyFrom=(JSON.parse(payload.input) as {replyFrom:string}).replyFrom;
      return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'{"reply":"Thank you."}'}]}]});
    }
    return Response.json({id:'same-id',threadId:'thread',snippet:'Hello',internalDate:'100',labelIds:[],payload:{headers:[{name:'From',value:'sender@example.com'}]}});
  };
  try{
    assert.equal((await reply(request('reply',{id:'same-id',accountId:'b',action:'generate'}))).status,200);
    assert.equal(replyFrom,'b@example.com');assert.doesNotMatch(instructions,/signed as Alex/);
  }finally{f.close();}
});

void test('malformed action requests return 400 before contacting Google',async()=>{
  const f=await fixture();
  globalThis.fetch=async()=>{throw new Error('Invalid requests must not contact Google');};
  try{
    for(const handler of [reply,unsubscribe,disconnect,setDefault,refresh]){
      assert.equal((await handler(request('action',null))).status,400);
      assert.equal((await handler(request('action',[]))).status,400);
      const malformed=new Request('https://brief.example/api/action',{method:'POST',headers:{origin:'https://brief.example','Content-Type':'application/json'},body:'{'});
      assert.equal((await handler(malformed)).status,400);
    }
  }finally{f.close();}
});

void test('temporary Google failures do not tell users to reconnect a valid account',async()=>{
  const f=await fixture();
  globalThis.fetch=async()=>new Response('Unavailable',{status:503});
  try{
    const response=await refresh(request('sync',{accountId:'a'}));
    const result=await response.json() as {errors:{message:string}[]};
    assert.match(result.errors[0].message,/temporarily unavailable/i);
    assert.doesNotMatch(result.errors[0].message,/reconnect/i);
  }finally{f.close();}
});
void test('sync skips a message removed from Gmail after the inbox was listed',async()=>{
  const f=await fixture();
  globalThis.fetch=async(input)=>{
    const url=urlOf(input);
    if(url.includes('/token'))return Response.json({access_token:'access'});
    if(url.includes('messages?'))return Response.json({messages:[{id:'removed'},{id:'new-mail'}]});
    if(url.includes('messages/removed'))return new Response('',{status:404});
    return Response.json({id:'new-mail',threadId:'thread',snippet:'Still here',internalDate:'200',labelIds:[],payload:{headers:[{name:'From',value:'sender@example.com'}]}});
  };
  try{
    const response=await refresh(request('sync',{accountId:'a'}));
    const result=await response.json() as Awaited<ReturnType<typeof mailbox>>;
    assert.deepEqual(result.emails.filter(m=>m.accountId==='a').map(m=>m.id),['new-mail']);
  }finally{f.close();}
});
void test('a reconnected account refreshes even when its previous snapshot is recent',async()=>{
  const f=await fixture();let listed=false;
  f.sql.prepare('UPDATE snapshots SET updated=? WHERE account_id=?').run(Date.now(),'a');
  globalThis.fetch=async(input)=>{
    if(urlOf(input).includes('/token'))return Response.json({access_token:'access'});
    listed=true;return Response.json({messages:[]});
  };
  try{
    assert.equal((await refresh(request('sync',{accountId:'a'}))).status,200);
    assert.equal(listed,true);
  }finally{f.close();}
});
