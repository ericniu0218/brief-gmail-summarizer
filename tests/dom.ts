import { JSDOM } from 'jsdom';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A minimal browser for the interaction tests.
 *
 * The other suites render components to a string, which proves what the markup says but
 * never what a click does. These helpers mount real React into jsdom so a test can press
 * a button and assert on what the user is left looking at.
 *
 * Two known limitations, both verified rather than assumed:
 *
 * 1. Base UI overlays do not mount here. A `Dialog.Popup` renders nothing in jsdom even
 *    when opened directly with `open`, with no trigger and no animation involved, so the
 *    conversation sheet, the account menu and the mobile drawer cannot be opened by a
 *    test. Components that normally live inside them are mounted directly instead.
 * 2. Typing into a controlled field does not reach React. Setting the value through the
 *    prototype setter and dispatching `input` updates the DOM but leaves React's state at
 *    its previous value, so assertions that depend on typed text are not written here.
 *
 * Both are environment gaps, not application defects; the behaviour behind them is
 * covered by the server suites and by rendering the affected component on its own.
 */

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** Globals React and the component tree read directly off `globalThis`. */
const COPIED = ['HTMLElement','HTMLButtonElement','HTMLInputElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','DocumentFragment','NodeFilter','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','DOMRect','ResizeObserver'] as const;

let dom:JSDOM|undefined;
let root:Root|undefined;
let container:HTMLElement|undefined;
let mobile=false;

/** Some globals (notably `navigator`) are read-only getters in Node, so define rather than assign. */
function define(key:string,value:unknown){
  Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
}

/**
 * `matches` is fixed per test rather than computed: jsdom has no layout engine, so a real
 * media query would always report false and the mobile paths could never be exercised.
 */
function installMatchMedia(window:Window&typeof globalThis){
  define('matchMedia',(query:string)=>({
    matches:mobile,media:query,onchange:null,
    addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},
    dispatchEvent(){return false;},
  }));
  (window as unknown as {matchMedia:unknown}).matchMedia=(globalThis as unknown as {matchMedia:unknown}).matchMedia;
}

/**
 * jsdom implements no layout and no pointer capture, but the overlay components used by
 * the dashboard (sheets, dropdown menus) call these APIs while opening. Without them the
 * open never completes and the panel silently stays closed.
 */
function installOverlaySupport(window:Window&typeof globalThis){
  class Observer{observe(){}unobserve(){}disconnect(){}takeRecords(){return [];}}
  for(const name of ['ResizeObserver','IntersectionObserver']){
    if(!(name in window)){
      (window as unknown as Record<string,unknown>)[name]=Observer;
      define(name,Observer);
    }
  }
  const element=window.Element.prototype as unknown as Record<string,unknown>;
  element.hasPointerCapture??=()=>false;
  element.setPointerCapture??=()=>{};
  element.releasePointerCapture??=()=>{};
  element.scrollIntoView??=()=>{};
  // Overlays wait for their open/close animation before committing. jsdom has no Web
  // Animations API, so an unanswered wait would leave the panel permanently closed.
  element.getAnimations??=()=>[];
  element.animate??=()=>({finished:Promise.resolve(),cancel(){},finish(){},play(){},pause(){},
    addEventListener(){},removeEventListener(){},onfinish:null,currentTime:0,playState:'finished'});
  // Some libraries construct PointerEvent directly; jsdom does not implement it.
  const globals=window as unknown as Record<string,unknown>;
  if(!globals.PointerEvent){
    globals.PointerEvent=window.MouseEvent;
    define('PointerEvent',window.MouseEvent);
  }
}

/** Starts a fresh document. `viewport:'mobile'` makes the layout hook report a phone. */
export function setupDom(options:{viewport?:'desktop'|'mobile'}={}){
  mobile=options.viewport==='mobile';
  dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://brief.example/',pretendToBeVisual:true});
  const window=dom.window as unknown as Window&typeof globalThis;
  define('window',window);
  define('document',window.document);
  define('navigator',window.navigator);
  define('localStorage',window.localStorage);
  for(const key of COPIED)if((window as unknown as Record<string,unknown>)[key])define(key,(window as unknown as Record<string,unknown>)[key]);
  installMatchMedia(window);
  installOverlaySupport(window);
  globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  container=window.document.createElement('div');
  window.document.body.appendChild(container);
}

export function teardownDom(){
  if(root)act(()=>{root!.unmount();});
  root=undefined;container=undefined;
  dom?.window.close();
  dom=undefined;
}

/** Mounts a tree and lets its initial effects settle. */
export async function render(element:ReactElement){
  if(!container)throw new Error('setupDom must run before render');
  root=createRoot(container);
  await act(async()=>{root!.render(element);});
  return container;
}

/**
 * Re-renders into the existing root, the way a parent passing new props would, so a test can
 * observe what happens to work already in flight when the data underneath it changes.
 */
export async function rerender(element:ReactElement){
  if(!root)throw new Error('render must run before rerender');
  await act(async()=>{root!.render(element);});
  return container;
}

/**
 * Lets pending work finish: promises, timers and animation frames.
 *
 * Overlay components schedule their mount across a frame, and those callbacks run outside
 * React's batching, so waiting only on microtasks would observe a panel that never opened.
 */
export async function settle(times=3){
  for(let i=0;i<times;i++){
    await act(async()=>{
      await new Promise(resolve=>setTimeout(resolve,0));
      if(dom)await new Promise(resolve=>dom!.window.requestAnimationFrame(()=>resolve(null)));
    });
  }
}

/**
 * The whole document body, not just the mounted container: sheets, dialogs and menus are
 * rendered through portals, so a container-scoped query would never find them.
 */
export function screen(){
  if(!dom)throw new Error('setupDom must run before screen');
  return dom.window.document.body;
}

/** Every element whose visible text matches, ignoring surrounding whitespace. */
export function allByText(selector:string,text:string|RegExp){
  return [...screen().querySelectorAll(selector)].filter(node=>{
    const content=(node.textContent||'').replace(/\s+/g,' ').trim();
    return typeof text==='string'?content===text:text.test(content);
  }) as HTMLElement[];
}

/** Every element whose accessible label matches; icon-only controls have no text. */
export function allByLabel(label:string|RegExp){
  return [...screen().querySelectorAll('[aria-label]')].filter(node=>{
    const value=node.getAttribute('aria-label')||'';
    return typeof label==='string'?value===label:label.test(value);
  }) as HTMLElement[];
}

/** The single element carrying this accessible label. */
export function byLabel(label:string|RegExp){
  const found=allByLabel(label);
  if(found.length!==1)throw new Error(`Expected exactly one element labelled ${String(label)}, found ${found.length}`);
  return found[0];
}

/** The single element whose text matches; throws when the match is absent or ambiguous. */
export function byText(selector:string,text:string|RegExp){
  const found=allByText(selector,text);
  if(found.length!==1)throw new Error(`Expected exactly one ${selector} matching ${String(text)}, found ${found.length}`);
  return found[0];
}

/** Unmounts the tree while keeping the document, so a test can simulate a page reload. */
export async function unmountTree(){
  if(root)await act(async()=>{root!.unmount();});
  root=undefined;
}

/** Clicks an element the way a user would, then lets the resulting work settle. */
export async function click(element:Element){
  await act(async()=>{
    element.dispatchEvent(new (globalThis as unknown as {MouseEvent:typeof MouseEvent}).MouseEvent('click',{bubbles:true,cancelable:true}));
  });
  await settle();
}
