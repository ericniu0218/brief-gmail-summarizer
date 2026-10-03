'use client';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Clock3, Mail, Search, SlidersHorizontal, UserRound, X } from 'lucide-react';
import { emailKey, type Email } from '@/lib/mail';
import { sectionName } from '@/lib/categories';
import { parseMailSearch, searchExcerpt, searchMail } from '@/lib/mail-search';
import { receivedLabel } from '@/lib/email-time';

const FILTER_CHIPS=[['has:attachment','Has attachment'],['newer_than:7d','Last 7 days'],['is:unread','Unread'],['needs:reply','Needs a reply']] as const;

export function HeaderMailSearch({query,onQuery,emails,scope,now,onSelect}:{query:string;onQuery:(value:string)=>void;emails:Email[];scope:string;now:number|null;onSelect:(email:Email)=>void}){
  const [open,setOpen]=useState(false);
  const [advanced,setAdvanced]=useState(false);
  const [contextQuery,setContextQuery]=useState(query);
  const [recent,setRecent]=useState<string[]>([]);
  const container=useRef<HTMLElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  const suggestionId=useId();
  const historyKey=`brief:mail-search:${scope}`;
  function openSearch(){
    try{
      const stored:unknown=JSON.parse(localStorage.getItem(historyKey)||'[]');
      setRecent(Array.isArray(stored)?stored.filter((item):item is string=>typeof item==='string'&&item.length<=300).slice(0,6):[]);
    }catch{setRecent([]);}
    setOpen(true);input.current?.focus();
  }
  useEffect(()=>{
    const timer=window.setTimeout(()=>setContextQuery(query),180);
    return()=>window.clearTimeout(timer);
  },[query]);
  useLayoutEffect(()=>{
    if(!open)return;
    const search=container.current,topbar=search?.closest('.topbar');
    const breadcrumb=topbar?.querySelector('.breadcrumb');
    if(!search||!topbar||!breadcrumb)return;
    const measure=()=>{
      const width=Math.max(38,search.getBoundingClientRect().right-breadcrumb.getBoundingClientRect().right-14);
      search.style.setProperty('--search-expanded-width',`${width}px`);
    };
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(topbar);observer.observe(breadcrumb);
    if(search.parentElement)observer.observe(search.parentElement);
    window.addEventListener('resize',measure);
    return()=>{observer.disconnect();window.removeEventListener('resize',measure);};
  },[open]);
  useEffect(()=>{if(open)input.current?.focus();},[open]);
  const matches=useMemo(()=>contextQuery.trim()?searchMail(emails,contextQuery,'',now??0):[],[emails,contextQuery,now]);
  const senders=useMemo(()=>{
    const {terms,filters}=parseMailSearch(contextQuery),needles=filters.from?[filters.from]:terms;
    if(!needles.some(term=>term.length>=2))return [];
    const found=new Map<string,Email>();
    for(const email of emails){
      const identity=`${email.sender} ${email.address}`.toLowerCase();
      if(needles.some(term=>term.length>=2&&identity.includes(term))&&!found.has(email.address.toLowerCase()))found.set(email.address.toLowerCase(),email);
    }
    return [...found.values()].slice(0,3);
  },[emails,contextQuery]);
  const recentMatches=recent.filter(item=>!contextQuery.trim()||item.toLowerCase().includes(contextQuery.toLowerCase())).slice(0,5);
  function remember(value:string){
    const text=value.trim().slice(0,300);if(!text)return;
    const updated=[text,...recent.filter(item=>item!==text)].slice(0,6);
    setRecent(updated);try{localStorage.setItem(historyKey,JSON.stringify(updated));}catch{/* Optional browser history. */}
  }
  function chooseQuery(value:string){onQuery(value);setContextQuery(value);remember(value);input.current?.focus();}
  function setField(field:string,value:string){
    const rest=query.replace(new RegExp(`(?:^|\\s)${field}:(?:"[^"]*"|\\S*)`,'gi'),' ').trim();
    onQuery([rest,value.trim()?`${field}:"${value.replaceAll('"','')}"`:''].filter(Boolean).join(' '));
  }
  const fields=parseMailSearch(query).filters;
  const rawField=(field:string)=>new RegExp(`(?:^|\\s)${field}:"([^"]*)"`,'i').exec(query)?.[1]??fields[field as 'from'|'subject']??'';
  function toggleChip(token:string){
    const tokens=query.match(/(?:from|subject|category):(?:"[^"]*"|\S*)|"[^"]+"|\S+/gi)||[];
    onQuery(tokens.some(item=>item.toLowerCase()===token)?tokens.filter(item=>item.toLowerCase()!==token).join(' '):[query.trim(),token].filter(Boolean).join(' '));
    input.current?.focus();
  }
  function close(){setOpen(false);trigger.current?.focus();}
  function handleKeyDown(event:KeyboardEvent<HTMLElement>){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
      if(event.key==='Enter'&&event.target===input.current){event.preventDefault();remember(query);close();}
      if((event.key==='ArrowDown'||event.key==='ArrowUp')&&(event.target===input.current||(event.target as HTMLElement).hasAttribute('data-search-suggestion'))){
        const items=Array.from(container.current?.querySelectorAll<HTMLButtonElement>('[data-search-suggestion]')||[]);
        if(!items.length)return;
        const index=items.indexOf(event.target as HTMLButtonElement);
        event.preventDefault();
        if(event.key==='ArrowUp'&&index<=0)input.current?.focus();
        else items[Math.min(items.length-1,Math.max(0,index+(event.key==='ArrowDown'?1:-1)))]?.focus();
      }
    }
  return <search ref={container} className={`header-mail-search${open?' is-open':''}${query?' has-query':''}`} aria-label="Search mail"
    onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);}}
    >
    <div className="header-mail-search-box">
      <div className="header-mail-search-row">
        <button ref={trigger} type="button" className="header-mail-search-trigger" aria-label="Search emails" aria-expanded={open}
          title="Search emails" onClick={openSearch}><Search size={19}/></button>
        <input ref={input} onKeyDown={handleKeyDown} type="search" aria-label="Search emails by sender, subject, or content" aria-controls={open?suggestionId:undefined} aria-hidden={!open} tabIndex={open?0:-1}
          value={query} onChange={event=>onQuery(event.target.value)} placeholder="Search mail"/>
        {open&&query&&<button type="button" className="header-mail-search-clear" aria-label="Clear search" onClick={()=>{onQuery('');setContextQuery('');input.current?.focus();}}><X size={16}/></button>}
        {open&&<button type="button" className="header-mail-search-options" aria-label="Search filters" aria-expanded={advanced} onClick={()=>setAdvanced(value=>!value)}><SlidersHorizontal size={19}/></button>}
      </div>
      {open&&<div className="mail-search-dropdown" id={suggestionId} aria-label="Search suggestions">
        <div className="mail-search-chips">{FILTER_CHIPS.map(([token,label])=><button key={token} type="button" aria-pressed={query.toLowerCase().split(/\s+/).includes(token)} onClick={()=>toggleChip(token)}>{label}</button>)}</div>
        {advanced&&<div className="mail-search-advanced">
          <label>From<input aria-label="Filter by sender" value={rawField('from')} onChange={event=>setField('from',event.target.value)} placeholder="Name or email"/></label>
          <label>Subject<input aria-label="Filter by subject" value={rawField('subject')} onChange={event=>setField('subject',event.target.value)} placeholder="Subject contains…"/></label>
          <label>Category<select value={fields.category||''} onChange={event=>setField('category',event.target.value)}><option value="">All categories</option><option value="work">Work</option><option value="personal">Personal</option><option value="noise">Noise</option></select></label>
        </div>}
        <div className="mail-search-suggestions" aria-busy={query!==contextQuery}>
          {recentMatches.map(value=><button key={value} type="button" onKeyDown={handleKeyDown} data-search-suggestion onClick={()=>chooseQuery(value)}><Clock3 size={17}/><span>{value}</span><small>Recent search</small></button>)}
          {senders.map(email=><button key={email.address} type="button" onKeyDown={handleKeyDown} data-search-suggestion onClick={()=>{setField('from',email.address);input.current?.focus();}}><UserRound size={17}/><span><strong>{email.sender}</strong><small>{email.address}</small></span><small>Sender</small></button>)}
          {matches.slice(0,4).map(email=><button key={emailKey(email)} type="button" onKeyDown={handleKeyDown} data-search-suggestion onClick={()=>{remember(query);setOpen(false);onSelect(email);}}><Mail size={17}/><span><strong>{email.subject}</strong><small>{email.sender} · {searchExcerpt(email,contextQuery)}</small></span></button>)}
          {!contextQuery.trim()&&!recentMatches.length&&<p className="mail-search-prompt">Search a name, subject, or words you remember from an email.</p>}
          {!!contextQuery.trim()&&!matches.length&&!senders.length&&!recentMatches.length&&<p className="mail-search-prompt">No matching synced emails. Try fewer words or adjust the filters.</p>}
          {!!contextQuery.trim()&&<button type="button" onKeyDown={handleKeyDown} data-search-suggestion className="mail-search-view-all" onClick={()=>{remember(query);close();}}><Search size={17}/><span>View all results</span><small>{matches.length} matches</small></button>}
        </div>
      </div>}
    </div>
  </search>;
}

export function MailSearchResults({emails,query,hasMore,showAccount,now,onSelect}:{emails:Email[];query:string;hasMore:boolean;showAccount:boolean;now:number|null;onSelect:(email:Email)=>void}){
  const [limit,setLimit]=useState(50);
  return <section className="inbox-section standalone-inbox mail-search-results" aria-label="Email search results">
    <div className="section-title-row"><h2>Search results <span>{emails.length}</span></h2></div>
    <output className="mail-search-hint">{emails.length} {emails.length===1?'match':'matches'} across all synced categories, including Noise. {hasMore?'Older emails are still syncing.':'Newest first.'}</output>
    {emails.length===0&&<p className="mail-search-empty">No matching emails. Try fewer words or a different sender.</p>}
    {emails.slice(0,limit).map(email=><button type="button" key={emailKey(email)} className="mail-search-result" onClick={()=>onSelect(email)}>
      <div className="mail-search-result-meta"><strong>{email.sender}</strong><span>{receivedLabel(email,now)}</span></div>
      <div className="mail-search-result-subject">{email.subject}</div>
      <p>{searchExcerpt(email,query)}</p>
      <small>{email.address} · {sectionName(email.category)}{showAccount&&email.accountEmail?` · To ${email.accountEmail}`:''}</small>
    </button>)}
    {limit<emails.length&&<button type="button" className="button white" onClick={()=>setLimit(value=>value+50)}>Show more matches</button>}
  </section>;
}
