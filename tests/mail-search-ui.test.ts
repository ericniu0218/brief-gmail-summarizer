import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { HeaderMailSearch } from '../components/mail-search';
import { demoEmails } from '../lib/mail';
import { allByText, byLabel, click, render, rerender, screen, setupDom, teardownDom } from './dom';

void test('search suggestions narrow with the query, apply sender filters, and open the selected email',async()=>{
  setupDom();
  try{
    const emails=[{...demoEmails[0],id:'finn',sender:'Finn Smith',address:'finn@gmail.com',subject:'Camping plans',body:'Bring the stove.'},
      {...demoEmails[0],id:'maya',sender:'Maya',address:'maya@example.com',subject:'Quarterly forecast',body:'The forecast is ready.'}];
    let changed='',selected='';
    const props={onQuery:(value:string)=>{changed=value;},emails,scope:'user:a',now:Date.now(),onSelect:(email:typeof emails[number])=>{selected=email.id;}};
    await render(createElement(HeaderMailSearch,{...props,query:'finn'}));
    await click(byLabel('Search emails'));
    assert.equal(document.activeElement,byLabel('Search emails by sender, subject, or content'));
    const sender=allByText('button',/Finn Smith.*Sender/)[0];assert.ok(sender);
    await click(sender);assert.equal(changed,'finn from:"finn@gmail.com"');
    await rerender(createElement(HeaderMailSearch,{...props,query:'forecast'}));
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,220));});
    assert.equal(allByText('[data-search-suggestion]',/Camping plans/).length,0);
    const preview=allByText('[data-search-suggestion]',/Quarterly forecast/)[0];assert.ok(preview);
    await click(preview);assert.equal(selected,'maya');
    assert.equal(screen().querySelector('.mail-search-dropdown'),null);
  }finally{teardownDom();}
});

void test('recent searches stay scoped and chips apply real filters',async()=>{
  setupDom();
  try{
    localStorage.setItem('brief:mail-search:user:a',JSON.stringify(['camping']));
    localStorage.setItem('brief:mail-search:other:a',JSON.stringify(['private search']));
    let changed='';
    await render(createElement(HeaderMailSearch,{query:'',onQuery:value=>{changed=value;},emails:demoEmails,scope:'user:a',now:Date.now(),onSelect:()=>{}}));
    await click(byLabel('Search emails'));
    assert.ok(allByText('button',/camping.*Recent search/).length);
    assert.equal(allByText('button',/private search/).length,0);
    await click(allByText('button','Last 7 days')[0]);assert.equal(changed,'newer_than:7d');
    await click(byLabel('Search filters'));assert.ok(byLabel('Filter by sender'));
  }finally{teardownDom();}
});
