import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { EmailBody } from '../components/email-body';
import { useEmailView } from '../hooks/use-email-view';
import { demoEmails } from '../lib/mail';
import { allByText, click, render, rerender, screen, setupDom, settle, teardownDom } from './dom';

function Preference({user}:{user:string}){
  const {defaultEmailView,setDefaultEmailView}=useEmailView(user);
  return createElement('button',{onClick:()=>setDefaultEmailView('original')},defaultEmailView);
}

void test('default email view survives remounts and is scoped to the signed-in user',async()=>{
  setupDom();try{
    await render(createElement(Preference,{user:'a'}));await settle();
    await click(allByText('button','reading')[0]);
    assert.equal(localStorage.getItem('brief:default-email-view:a'),'original');
    await rerender(createElement(Preference,{user:'b'}));await settle();
    assert.ok(allByText('button','reading').length,'another user keeps the default');
    await rerender(createElement(Preference,{key:'reloaded',user:'a'}));await settle();
    assert.ok(allByText('button','original').length,'the saved view returns on remount');
  }finally{teardownDom();}
});

void test('the global default takes precedence over old sender preferences and message toggles stay local',async()=>{
  setupDom();try{
    const email={...demoEmails[0],accountId:'a',address:'finn@gmail.com',html:'<p>Hello</p>',body:'Hello'};
    localStorage.setItem('brief:email-view:a:finn@gmail.com','reading');
    await render(createElement(EmailBody,{email,preferredView:'original',ready:false}));await settle();
    assert.equal(allByText('button','Original')[0].getAttribute('aria-pressed'),'true');
    await click(allByText('button','Reading view')[0]);
    assert.equal(allByText('button','Reading view')[0].getAttribute('aria-pressed'),'true');
    await rerender(createElement(EmailBody,{key:'next-email',email:{...email,id:'next'},preferredView:'original',ready:false}));await settle();
    assert.equal(allByText('button','Original')[0].getAttribute('aria-pressed'),'true');
    await rerender(createElement(EmailBody,{key:'reading-default',email,preferredView:'reading',ready:false}));await settle();
    assert.equal(allByText('button','Reading view')[0].getAttribute('aria-pressed'),'true');
    assert.equal(screen().querySelector('iframe'),null);
    assert.equal(localStorage.getItem('brief:email-images:a:finn@gmail.com'),null,'changing the view never permits remote images');
  }finally{teardownDom();}
});
