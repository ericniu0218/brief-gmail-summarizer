import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneClickAuthenticated, parseListUnsubscribe } from '../lib/unsubscribe';
import { replyAddress } from '../lib/reply-address';
import { database } from './database';

const signature=(domain:string,covered=true)=>`v=1; d=${domain}; s=mail; h=from:subject${covered?':list-unsubscribe:list-unsubscribe-post':''}; b=abc`;
const authenticated=(results:string,signatures:string[])=>oneClickAuthenticated({
  'authentication-results':[results],'dkim-signature':signatures,
},{});

void test('unsubscribe authentication binds each passing result to its own signature',()=>{
  assert.equal(authenticated('mx.google.com; dkim=fail header.d=evil.example; dkim=pass header.d=good.example',
    [signature('evil.example'),signature('good.example',false)]),false);
  assert.equal(authenticated('mx.google.com; dkim=fail (dkim=pass header.d=evil.example) header.d=evil.example',
    [signature('evil.example')]),false);
  assert.equal(authenticated('mx.google.com; dkim=fail reason="dkim=pass header.d=evil.example" header.d=evil.example',
    [signature('evil.example')]),false);
  assert.equal(authenticated('mx.google.com; dkim=pass header.d=sender.example; dkim=pass header.d=service.example',
    [signature('sender.example',false),signature('service.example')]),true);
  assert.equal(authenticated('mx.google.com; dkim=pass header.i=person@service.example',
    [signature('service.example')]),true);
  assert.equal(authenticated('mx.google.com; dkim=pass header.d=service.example header.s=mail',
    [signature('service.example'),signature('service.example',false).replace('s=mail','s=other')]),true);
  assert.equal(authenticated('mx.google.com; dkim=pass header.d=service.example',
    [signature('service.example'),signature('service.example',false)]),false);
});

void test('unsubscribe URL comparison ignores hostname case but preserves tokens',()=>{
  const same=parseListUnsubscribe(['<HTTPS://NEWS.Example.com/Unsubscribe?token=AbC>',
    '<https://news.example.com/Unsubscribe?token=AbC>']);
  assert.equal(same.conflicting,false);
  assert.equal(same.https[0],'https://news.example.com/Unsubscribe?token=AbC');
  assert.equal(parseListUnsubscribe(['<https://news.example.com/ABC>','<https://news.example.com/abc>']).conflicting,true);
});

void test('Reply-To uses the verified header and rejects partial parses and injection',()=>{
  const destination=(value:string)=>replyAddress([{name:'Reply-To',value}],'from@example.com');
  assert.equal(replyAddress([],'from@example.com'),'from@example.com');
  assert.equal(destination('"Support, Team" <reply@example.com>'),'reply@example.com');
  assert.equal(destination('Support\r\n <reply@example.com>'),'reply@example.com');
  for(const invalid of ['reply@example.com\r\nBcc: attacker@example.com','<reply@example.com> trailing',
    '<reply@example.com>, bad','reply@example.com, other@example.com','bad','',
    'reply@example.com\0','reply@example.com; Bcc: attacker@example.com'])
    assert.equal(destination(invalid),undefined,invalid);
  assert.equal(replyAddress([{name:'Reply-To',value:'a@example.com'},{name:'Reply-To',value:'b@example.com'}],'from@example.com'),undefined);
});

void test('retired unsubscribe table rejects old workers inserting sender suppression',()=>{
  const {sql}=database();
  try{
    for(const verb of ['INSERT','INSERT OR REPLACE','INSERT OR IGNORE'])
      sql.exec(`${verb} INTO unsubscribed(id,user_id,account_id,address,created) VALUES ('old','user','account','news@example.com',1)`);
    assert.equal((sql.prepare('SELECT COUNT(*) AS n FROM unsubscribed').get() as {n:number}).n,0);
  }finally{sql.close();}
});
