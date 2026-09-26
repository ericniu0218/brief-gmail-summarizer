import { env } from 'cloudflare:workers';
import { chatGPTSignInPath, getChatGPTUser } from '@/app/chatgpt-auth';

/**
 * Shared server boundary for environment bindings, authenticated identity, safe API
 * responses, request-origin checks, and encryption of stored Gmail credentials.
 */

export type Runtime = {
  DB: D1Database; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string; GEMINI_API_KEY?: string; GEMINI_MODEL?: string; APP_URL?: string; AGENT_CRON_SECRET?: string;
  UNSUBSCRIBE_ALLOWED_HOSTS?: string;
};
export function runtime() { return env as unknown as Runtime; }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export class SignInRequiredError extends HttpError {
  constructor() { super(401, 'Please sign in to connect your inbox.'); }
}
export async function userId() {
  const user = await getChatGPTUser();
  if (!user) throw new SignInRequiredError();
  return user.userId;
}
export function mutation(request: Request) {
  // State-changing browser requests must originate from this application.
  const origin = request.headers.get('origin');
  const expected = appUrl() || new URL(request.url).origin;
  if (!origin || origin !== expected) throw new HttpError(403, 'Please use this action from your dashboard.');
}
/** Default ceiling for a request body. Reply text needs more and asks for it explicitly. */
export const MAX_REQUEST_BYTES=16384;

/**
 * Read one JSON object, refusing an oversized body before it is parsed.
 *
 * A declared Content-Length is checked first so an obvious flood costs nothing, and the
 * decoded text is measured again because that header is not trustworthy on its own.
 */
export async function inputObject(request:Request,limit=MAX_REQUEST_BYTES):Promise<Record<string,unknown>> {
  const declared=Number(request.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>limit)throw new HttpError(413,'That request is too large.');
  // Read the stream in bounded chunks. Checking only after `request.text()` would still
  // let an undeclared oversized body consume memory before it was rejected.
  const chunks:Uint8Array[]=[];
  let length=0;
  try{
    const reader=request.body?.getReader();
    if(reader){
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        length+=value.byteLength;
        if(length>limit){try{await reader.cancel();}catch{/* rejection still wins */}throw new HttpError(413,'That request is too large.');}
        chunks.push(value);
      }
    }
  }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'Provide a valid JSON request.');}
  const bytes=new Uint8Array(length);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder().decode(bytes);
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new HttpError(400,'Provide a valid JSON request.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Provide a valid JSON object.');
  return value as Record<string,unknown>;
}

/** Persisted JSON is a trust boundary: a damaged row must not become a generic 500. */
export function parseStoredJson<T>(value:string|null|undefined,what:string,valid:(value:unknown)=>value is T):T{
  try{
    const parsed:unknown=JSON.parse(value??'');
    if(!valid(parsed))throw new Error('invalid shape');
    return parsed;
  }catch{throw new HttpError(409,`That ${what} could not be read. Refresh and try again.`);}
}
export function json(data: unknown, status=200) {
  // Mailbox and workspace data must not be cached by shared browsers or proxies.
  return Response.json(data, {status, headers: {'Cache-Control':'private, no-store'}});
}
export function failure(error: unknown) {
  return json({error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.', ...(error instanceof SignInRequiredError ? {signInUrl: chatGPTSignInPath('/')} : {})}, error instanceof HttpError ? error.status : 500);
}
/** The site's public origin. Hosting settings often carry a trailing slash, which Google treats as a different redirect URI. */
export function appUrl(e=runtime()) {
  const value=e.APP_URL?.trim().replace(/\/+$/,'');
  if(!value)return undefined;
  try{const url=new URL(value);return (url.protocol==='https:'||url.protocol==='http:')&&url.origin===value?value:undefined;}catch{return undefined;}
}
export function googleCallbackUrl(e=runtime()) { const url=appUrl(e); return url?url+'/api/auth/google/callback':null; }
/** Pasted credentials often carry whitespace, which Google rejects as invalid_client. */
export function googleClient(e=runtime()) { return {client_id:e.GOOGLE_CLIENT_ID?.trim()||'',client_secret:e.GOOGLE_CLIENT_SECRET?.trim()||''}; }
function validKey(value:string) {
  try{return [16,24,32].includes(decode(value.trim()).length);}catch{return false;}
}
/** Names (never values) of the settings that block Gmail OAuth, in display order. */
export function missingSettings(e=runtime()) {
  const missing:string[]=[];
  if(!e.GOOGLE_CLIENT_ID?.trim())missing.push('GOOGLE_CLIENT_ID');
  if(!e.GOOGLE_CLIENT_SECRET?.trim())missing.push('GOOGLE_CLIENT_SECRET');
  if(!e.TOKEN_ENCRYPTION_KEY||!validKey(e.TOKEN_ENCRYPTION_KEY))missing.push('TOKEN_ENCRYPTION_KEY');
  if(!appUrl(e))missing.push('APP_URL');
  return missing;
}
export function configured(e=runtime()) { return missingSettings(e).length===0; }
export function notConfigured(e=runtime()) {
  return new HttpError(503,`Gmail connection is not configured yet. Missing site settings: ${missingSettings(e).join(', ')}.`);
}
export function encode(input: string | Uint8Array) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return btoa(Array.from(bytes, b=>String.fromCharCode(b)).join('')).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function decode(input: string) { return Uint8Array.from(atob(input.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0)); }
async function key(e: Runtime) {
  if (!e.TOKEN_ENCRYPTION_KEY) throw new HttpError(503,'The Gmail connection is not configured yet.');
  return crypto.subtle.importKey('raw', decode(e.TOKEN_ENCRYPTION_KEY.trim()), 'AES-GCM', false, ['encrypt','decrypt']);
}
/**
 * Refresh tokens are bound to their owner so ciphertext cannot be moved between accounts.
 *
 * Version 1 bound the application user only, because a user had exactly one mailbox.
 * Version 2 binds user *and* account, so a token lifted from one mailbox row cannot be
 * pasted into another. Both stay readable: a connection's stored `token_version` selects
 * the binding, and a v1 token is rewritten as v2 only when the mailbox is reconnected,
 * which is already a credential write. Nothing downgrades a v2 token back to v1.
 */
export const LEGACY_TOKEN_VERSION=1;
export const CURRENT_TOKEN_VERSION=2;

function tokenBinding(user:string,accountId?:string){
  return accountId?`${user}:${accountId}`:user;
}

export async function encrypt(value:string,user:string,e=runtime(),accountId?:string) {
  // A fresh IV protects each token.
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(tokenBinding(user,accountId))},await key(e),new TextEncoder().encode(value));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function decrypt(value:string,user:string,e=runtime(),accountId?:string) {
  const [iv, ciphertext]=value.split('.');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:new TextEncoder().encode(tokenBinding(user,accountId))},await key(e),decode(ciphertext));
  return new TextDecoder().decode(bytes);
}
/**
 * Decrypt a stored refresh token using the format it was written with. An unknown version
 * is treated as legacy rather than failing, because an unreadable token would disconnect a
 * working mailbox. Ownership is enforced by the query that loaded the row, not here.
 */
export async function decryptToken(token:string,user:string,accountId:string,version:number,e=runtime()) {
  return version>=CURRENT_TOKEN_VERSION?decrypt(token,user,e,accountId):decrypt(token,user,e);
}
