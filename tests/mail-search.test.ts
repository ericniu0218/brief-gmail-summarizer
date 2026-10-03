import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoEmails, type Email } from '../lib/mail';
import { searchMail, searchExcerpt } from '../lib/mail-search';

const mail=(id:string,over:Partial<Email>):Email=>({...demoEmails[0],id,subject:'Hello',body:'',summary:'',sender:'Finn',address:'finn@gmail.com',receivedAt:100,...over});
const emails=[mail('joke',{category:'noise',body:'Heard you use the teeth god gave you.',receivedAt:300}),
  mail('project',{sender:'Maya',address:'maya@work.example',body:'The quarterly forecast is attached.',receivedAt:200}),
  mail('quoted',{quoted:'Finn said: bring the camping stove.',accountId:'second',receivedAt:100})];

void test('sender and content combine, including Noise, quoted history, and separate mailboxes',()=>{
  assert.deepEqual(searchMail(emails,'teeth','finn').map(email=>email.id),['joke']);
  assert.deepEqual(searchMail(emails,'camping','FINN@GMAIL.COM').map(email=>email.id),['quoted']);
  assert.deepEqual(searchMail(emails,'forecast','Finn'),[]);
  assert.deepEqual(searchMail(emails,'','finn').map(email=>email.id),['joke','quoted']);
  assert.deepEqual(searchMail(emails,'quarterly attached').map(email=>email.id),['project']);
  assert.deepEqual(searchMail(emails,'"quarterly forecast"').map(email=>email.id),['project']);
  assert.deepEqual(searchMail(emails,'"forecast quarterly"'),[]);
});

void test('the excerpt exposes a match deep in source text rather than an unrelated summary',()=>{
  const email=mail('deep',{body:'Intro '.repeat(100)+'Bring the camping stove tomorrow.',summary:'A casual message.'});
  const excerpt=searchExcerpt(email,'camping');
  assert.match(excerpt,/camping stove/);assert.ok(excerpt.startsWith('…'));assert.ok(excerpt.length<235);
  assert.match(searchExcerpt(emails[2],'camping'),/camping stove/);
});

void test('contextual filters combine with typed content and preserve quoted sender and subject names',()=>{
  const now=Date.UTC(2026,9,3,17);
  const current=mail('current',{sender:'Finn Smith',subject:'Camping trip plans',body:'Bring a stove.',unread:true,needsReply:true,hasAttachments:true,receivedAt:now-3600000});
  const older=mail('older',{sender:'Finn Smith',subject:'Camping trip plans',body:'Bring a stove.',unread:false,needsReply:false,receivedAt:now-8*86400000});
  const query='stove from:"Finn Smith" subject:"camping trip" newer_than:7d is:unread needs:reply has:attachment category:work';
  assert.deepEqual(searchMail([older,current],query,'',now).map(email=>email.id),['current']);
  assert.deepEqual(searchMail([older,current],'newer_than:7d','',now).map(email=>email.id),['current']);
  assert.deepEqual(searchMail([current],'category:noise','',now),[]);
  const legacy={...current,hasAttachments:undefined,incompleteReasons:['attachments-not-read']};
  assert.equal(searchMail([legacy],'has:attachment','',now).length,1);
  assert.match(searchExcerpt(current,query),/stove/);
});
