'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Email } from '@/lib/mail';

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
  return sanitizeLinks(html)
    .replace(/<(script|iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<(script|iframe|object|embed|applet)\b[^>]*\/?>/gi,'')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi,'')
    .replace(/<base\b[^>]*>/gi,'')
    .replace(/<\/?form\b[^>]*>/gi,'')
    .replace(/<(button|textarea|select|option)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'')
    .replace(/<(?:input|button|textarea|select|option)\b[^>]*\/?>/gi,'');
}

/** Build an isolated document whose policy is declared before any sender-controlled HTML. */
export function buildEmailDocument(html:string,loadRemoteImages=false){
  const images=loadRemoteImages?"https: data: blob:":'data: blob:';
  const csp=`default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; connect-src 'none'; media-src 'none'; form-action 'none'; style-src 'unsafe-inline'; font-src data:; img-src ${images}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base href="about:blank" target="_blank"><style>html,body{margin:0;min-height:100%;background:#fff;color:#1f2937}body{overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${inertEmailHtml(html)}</body></html>`;
}

function preferenceKey(email:Email){
  return `brief:email-images:${email.accountId||'demo'}:${email.address.toLowerCase()}`;
}

/** Display rich mail without giving sender-controlled markup access to the application. */
export function EmailBody({email}:{email:Email}){
  const [remoteImages,setRemoteImages]=useState(false);
  const [always,setAlways]=useState(false);
  const key=preferenceKey(email);
  useEffect(()=>{
    // Read after hydration. The component is keyed by message, so it always begins with
    // images blocked and cannot inherit permission from the previously opened sender.
    const timer=window.setTimeout(()=>{
      let saved=false;
      try{saved=window.localStorage.getItem(key)==='allow';}catch{/* Storage may be disabled. */}
      setAlways(saved);setRemoteImages(saved);
    },0);
    return()=>window.clearTimeout(timer);
  },[key]);
  const document=useMemo(()=>email.html?buildEmailDocument(email.html,remoteImages):'', [email.html,remoteImages]);
  if(!email.html)return <div className="message-body">{email.body}</div>;
  function rememberSender(){
    try{window.localStorage.setItem(key,'allow');}catch{/* This email can still load once. */}
    setAlways(true);setRemoteImages(true);
  }
  function blockImages(){
    try{window.localStorage.removeItem(key);}catch{/* State still changes for this view. */}
    setAlways(false);setRemoteImages(false);
  }
  return <section className="formatted-email">
    <div className="email-image-controls">
      {!remoteImages?<><span>Remote images are blocked.</span><button type="button" onClick={()=>setRemoteImages(true)}>Load images</button><button type="button" onClick={rememberSender}>Always load from this sender</button></>
        :<><span>{always?'Images load automatically for this sender.':'Remote images loaded for this email.'}</span>{!always&&<button type="button" onClick={rememberSender}>Always load from this sender</button>}<button type="button" onClick={blockImages}>Block images</button></>}
    </div>
    <iframe title={`Email from ${email.sender}`} className="email-document" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={document}/>
  </section>;
}
