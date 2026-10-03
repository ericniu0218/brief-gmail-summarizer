'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Maximize2, Minimize2 } from 'lucide-react';
import type { Email } from '@/lib/mail';
import { emailTextParts } from '@/lib/email-text';
import { readingDocument, readingSource, type ReadingBlock, type ReadingPart } from '@/lib/reading-text';

/** Protocols a link may use. Everything else loses its href and stays inert text. */
const SAFE_LINK=/^(?:https?:|mailto:)/i;

/**
 * Keep only links a reader can safely follow.
 *
 * `javascript:`, `data:` and similar schemes lose their href entirely. The sandbox already
 * withholds script execution, so this is defence in depth rather than the boundary — but
 * a link that cannot run is also a link that cannot mislead. Control characters are
 * stripped first, because `java\nscript:` is the same URL to a browser and a different
 * string to a naive test.
 */
function sanitizeLinks(html:string){
  return html.replace(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,(_match,double,single,bare)=>{
    // Matching control characters is the point: browsers strip tabs and newlines out of a
    // URL before resolving it, so `java&#9;script:` is a live scheme to them and an inert
    // string to a naive test. They are removed here before the scheme is checked.
    // oxlint-disable-next-line no-control-regex
    const value=String(double??single??bare??'').replace(/[\u0000-\u0020]/g,'').trim();
    return SAFE_LINK.test(value)?` href="${value.replace(/"/g,'&quot;')}"`:'';
  });
}

/**
 * Remove active document features as defense in depth. The iframe sandbox and CSP remain
 * the security boundary; this cleanup also prevents inert scripts and forms cluttering
 * the document or replacing the newsletter through an automatic refresh.
 */
function inertEmailHtml(html:string){
  // Scan tags once. A regex looking for a closing tag rescans the rest of a malformed
  // message for every unclosed opener, which can freeze the main browser thread.
  const blocked=new Set(['svg','script','iframe','object','embed','applet','button','textarea','select','option']);
  const tagEnd=(start:number)=>{
    let quote='';
    for(let index=start+1;index<html.length;index++){
      const char=html[index];
      if(quote){if(char===quote)quote='';}
      else if(char==='"'||char==="'")quote=char;
      else if(char==='>')return index;
    }
    return -1;
  };
  const stack:string[]=[];
  let cleaned='',cursor=0;
  while(cursor<html.length){
    const start=html.indexOf('<',cursor);
    if(start<0){if(!stack.length)cleaned+=html.slice(cursor);break;}
    if(!stack.length)cleaned+=html.slice(cursor,start);
    // Browser comments and bogus declarations do not use attribute quote rules.
    // Otherwise a quote in a comment can hide live tags after the browser's comment end.
    if(html.startsWith('<!--',start)){
      const after=start+4;
      if(html[after]==='>')cursor=after+1;
      else if(html.startsWith('->',after))cursor=after+2;
      else{const close=/--!?>/g;close.lastIndex=after;const match=close.exec(html);cursor=match?close.lastIndex:html.length;}
      continue;
    }
    if(html.startsWith('<!',start)||html.startsWith('<?',start)){
      const end=html.indexOf('>',start+2);cursor=end<0?html.length:end+1;continue;
    }
    const end=tagEnd(start);
    if(end<0){if(!stack.length)cleaned+=html.slice(start).replaceAll('<','&lt;');break;}
    const tag=html.slice(start,end+1);
    if(tag.length>16384){cursor=end+1;continue;}
    const match=/^<\s*(\/?)\s*([a-z][\w:-]*)\b/i.exec(tag);
    const name=match?.[2].toLowerCase();
    if(name&&blocked.has(name)){
      if(match?.[1]){
        const index=stack.lastIndexOf(name);
        if(index>=0)stack.length=index;
      }else if(!/\/\s*>$/.test(tag)&&name!=='embed')stack.push(name);
    }else if(!stack.length&&name!=='form'&&name!=='base'&&name!=='input'&&name!=='meta'&&name!=='link')
      // Escape nested openers: malformed attribute quotes must not smuggle live tags.
      cleaned+=sanitizeLinks('<'+tag.slice(1).replaceAll('<','&lt;')).replace(/\son[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,'');
    cursor=end+1;
  }
  return cleaned;
}

/**
 * Fit a sender's layout to the reading pane without scaling it down.
 *
 * Measured on wide newsletters, fixed-width marketing tables, receipts, long links and code
 * at desktop, laptop and phone widths, these rules removed every case of sideways scrolling
 * while keeping images and side-by-side columns. Fixed widths and minimum widths give way;
 * images shrink with their column; long links and code wrap. Words in table cells are not
 * broken mid-word (a receipt keeps "Discount" whole), and on a narrow pane an image layout
 * table stacks its columns while a data table such as a receipt keeps its columns.
 * Shrinking the whole message instead was rejected: it left text as small as 7px on phones.
 */
const FIT_TO_PANE='html,body{margin:0;min-height:100%;max-width:100%;background:#fff;color:#1f2937}'
  // Layout boxes count padding and borders inside their width, so a constrained table or
  // column cannot spill past the pane. Links and inline text keep the sender's own sizing:
  // "bulletproof" buttons draw their pill with a fixed width plus thick side borders, and
  // counting those borders inside the width squeezed or pushed the label off the button.
  +'*,*::before,*::after{box-sizing:border-box}a,span,font,b,strong,em,i,u{box-sizing:content-box}body{overflow-wrap:break-word}'
  +'table{max-width:100%!important}table{width:auto!important;table-layout:auto!important}'
  +'td,th{width:auto!important;min-width:0!important;overflow-wrap:break-word!important;word-break:normal!important}'
  +'a{overflow-wrap:anywhere}[style*="min-width"]{min-width:0!important}[style*="width"]:not(img){max-width:100%!important}'
  +'img{max-width:100%!important;height:auto!important}pre,code{white-space:pre-wrap!important;word-break:break-all}'
  +'@media (max-width:520px){table:has(img)>tbody>tr>td,table:has(img)>tr>td{display:block!important;width:100%!important}}'
  // A designed layout narrower than the pane sits in the middle, as it would in a mail app,
  // rather than against the left edge. Only table and width-capped layouts are centred;
  // a plain text message keeps the full width and its left alignment.
  +'.brief-fit:has(table,[style*="max-width"]){width:fit-content;max-width:100%;margin:0 auto}';

/** Build an isolated document whose policy is declared before any sender-controlled HTML. */
export function buildEmailDocument(html:string,loadRemoteImages=false){
  const images=loadRemoteImages?"https: data: blob:":'data: blob:';
  const csp=`default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; media-src 'none'; form-action 'none'; style-src 'unsafe-inline'; font-src data:; img-src ${images}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base href="about:blank" target="_blank"><style>${FIT_TO_PANE}</style></head><body><div class="brief-fit">${inertEmailHtml(html)}</div></body></html>`;
}

function preferenceKey(email:Email){
  return `brief:email-images:${email.accountId||'demo'}:${email.address.toLowerCase()}`;
}
function viewKey(email:Email){
  return `brief:email-view:${email.accountId||'demo'}:${email.address.toLowerCase()}`;
}

export type EmailView='reading'|'original';

/**
 * Which view a message opens in when the reader has not chosen one for its sender. A
 * conversation reads best as text; a designed newsletter — several images, or images with
 * little text, or anything filed as Noise — keeps its original layout.
 */
export function defaultView(email:Pick<Email,'html'|'body'|'category'>):EmailView{
  if(!email.html)return 'reading';
  const images=(email.html.match(/<img\b/gi)||[]).length;
  if(email.category==='noise'||images>=3)return 'original';
  if(images>0&&(email.body||'').replace(/\s+/g,' ').trim().length<200)return 'original';
  return 'reading';
}

function Parts({parts}:{parts:ReadingPart[]}){
  return <>{parts.map((part,index)=>part.kind==='text'?<Fragment key={index}>{part.value}</Fragment>
    :<a key={index} className="reading-link" href={part.href} target="_blank" rel="noreferrer" title={part.href}
      aria-label={`Open link to ${part.label}`}>{part.label}<ArrowUpRight size={11} aria-hidden="true"/></a>)}</>;
}

function Block({block}:{block:ReadingBlock}){
  switch(block.kind){
    case 'heading':return <h4><Parts parts={block.parts}/></h4>;
    case 'preformatted':return <pre>{block.text}</pre>;
    case 'table':return <div className="reading-table"><table><tbody>{block.rows.map((row,index)=><tr key={index}>{row.map((cell,column)=><td key={column}><Parts parts={cell}/></td>)}</tr>)}</tbody></table></div>;
    case 'list':{const List=block.ordered?'ol':'ul';return <List>{block.items.map((item,index)=><li key={index}><Parts parts={item}/></li>)}</List>;}
    default:return <p>{block.lines.map((line,index)=><Fragment key={index}>{index>0&&<br/>}<Parts parts={line}/></Fragment>)}</p>;
  }
}

/**
 * The message's own text in a consistent, readable layout. Mailing-list boilerplate at the
 * very end is folded behind a control that says what it holds; nothing is removed.
 */
export function ReadingEmailBody({body}:{body:string}){
  const document=useMemo(()=>readingDocument(body),[body]);
  const [visible,setVisible]=useState(400);
  return <div className="reading-body">
    {document.blocks.slice(0,visible).map((block,index)=><Block key={index} block={block}/>)}
    {visible<document.blocks.length&&<button type="button" className="email-expand" onClick={()=>setVisible(count=>count+400)}>
      Show more of this email ({document.blocks.length-visible} sections remaining)
    </button>}
    {visible>=document.blocks.length&&document.footer.length>0&&<details className="reading-footer">
      <summary>Mailing-list footer</summary>
      {document.footer.map((block,index)=><Block key={index} block={block}/>)}
    </details>}
  </div>;
}

/** Plain fallback with compact, inspectable links instead of exposed tracking strings. */
export function PlainEmailBody({body}:{body:string}){
  const parts=useMemo(()=>emailTextParts(body),[body]);
  return <div className="message-body">{parts.map((part,index)=>part.kind==='text'?part.value:
    <a key={`${index}:${part.href}`} className="message-link" href={part.href} target="_blank" rel="noreferrer"
      title={part.href} aria-label={`Open link to ${part.destination}`}>{part.label}</a>)}</div>;
}

/**
 * Display rich mail without giving sender-controlled markup access to the application.
 *
 * Two views: Reading (the message's text, laid out consistently, from the server-extracted
 * text — no sender HTML) and Original (the sender's HTML in a sandboxed frame, fitted to the
 * pane). `ready` holds back the frame until the panel has finished sliding in, so building
 * and painting a large newsletter never competes with the animation. `fullScreen` and
 * `onFullScreenChange` let the panel take the whole window for long messages.
 */
export function EmailBody({email,ready=true,fullScreen=false,onFullScreenChange,preferredView}:{email:Email;ready?:boolean;fullScreen?:boolean;onFullScreenChange?:(value:boolean)=>void;preferredView?:EmailView}){
  const [remoteImages,setRemoteImages]=useState(false);
  const [always,setAlways]=useState(false);
  const [view,setView]=useState<EmailView>(()=>preferredView??defaultView(email));
  const key=preferenceKey(email);
  const savedView=viewKey(email);
  useEffect(()=>{
    // Read after hydration. The component is keyed by message, so it always begins with
    // images blocked and cannot inherit permission from the previously opened sender.
    const timer=window.setTimeout(()=>{
      let saved=false,chosen:string|null=null;
      try{saved=window.localStorage.getItem(key)==='allow';chosen=window.localStorage.getItem(savedView);}catch{/* Storage may be disabled. */}
      setAlways(saved);setRemoteImages(saved);
      if(preferredView)setView(preferredView);
      else if(chosen==='reading'||chosen==='original')setView(chosen);
    },0);
    return()=>window.clearTimeout(timer);
  },[key,savedView,preferredView]);
  const document=useMemo(()=>email.html&&view==='original'?buildEmailDocument(email.html,remoteImages):'', [email.html,remoteImages,view]);
  const readingText=useMemo(()=>readingSource({html:email.html,body:email.body}),[email.html,email.body]);
  function choose(next:EmailView){
    setView(next);
    // A global default opens each message consistently; the toggle only changes this message.
    // Preserve legacy sender preferences for readers that do not supply a global default.
    if(!preferredView)try{window.localStorage.setItem(savedView,next);}catch{/* The choice still applies now. */}
  }
  const fullScreenButton=onFullScreenChange&&<button className="email-expand" type="button" aria-pressed={fullScreen}
    onClick={()=>onFullScreenChange(!fullScreen)}>{fullScreen?<><Minimize2 size={13} aria-hidden="true"/>Exit full screen</>:<><Maximize2 size={13} aria-hidden="true"/>Full screen</>}</button>;
  if(!email.html)return <section className="formatted-email">
    {fullScreenButton&&<div className="email-reader-toolbar">{fullScreenButton}</div>}
    <ReadingEmailBody body={email.body}/>
  </section>;
  function rememberSender(){
    try{window.localStorage.setItem(key,'allow');}catch{/* This email can still load once. */}
    setAlways(true);setRemoteImages(true);
  }
  function blockImages(){
    try{window.localStorage.removeItem(key);}catch{/* State still changes for this view. */}
    setAlways(false);setRemoteImages(false);
  }
  return <section className="formatted-email">
    <div className="email-reader-toolbar">
      <fieldset className="email-view-toggle">
        <legend className="sr-only">Email display</legend>
        <button type="button" data-active={view==='reading'||undefined} aria-pressed={view==='reading'} onClick={()=>choose('reading')}>Reading view</button>
        <button type="button" data-active={view==='original'||undefined} aria-pressed={view==='original'} onClick={()=>choose('original')}>Original</button>
      </fieldset>
      {fullScreenButton}
    </div>
    {view==='original'?<>
      <div className="email-image-controls">
        {!remoteImages?<><span>Remote images are blocked.</span><button type="button" onClick={()=>setRemoteImages(true)}>Load images</button><button type="button" onClick={rememberSender}>Always load from this sender</button></>
          :<><span>{always?'Images load automatically for this sender.':'Remote images loaded for this email.'}</span>{!always&&<button type="button" onClick={rememberSender}>Always load from this sender</button>}<button type="button" onClick={blockImages}>Block images</button></>}
      </div>
      {ready?<iframe title={`Email from ${email.sender}`} className={`email-document${fullScreen?' expanded':''}`} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={document}/>
        :<div className={`email-document email-document-pending${fullScreen?' expanded':''}`} aria-hidden="true"/>}
    </>:<ReadingEmailBody body={readingText}/>}
  </section>;
}
