import { env } from 'cloudflare:workers';
import { chatGPTSignInPath, getChatGPTUser } from '@/app/chatgpt-auth';
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
  const origin = request.headers.get('origin');
  const expected = appUrl() || new URL(request.url).origin;
  if (!origin || origin !== expected) throw new HttpError(403, 'Please use this action from your dashboard.');
}
export async function inputObject(request:Request):Promise<Record<string,unknown>> {
  let value:unknown;
  try{value=await request.json();}catch{throw new HttpError(400,'Provide a valid JSON request.');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Provide a valid JSON object.');
  return value as Record<string,unknown>;
}
export function json(data: unknown, status=200) {
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
export async function encrypt(value:string,user:string,e=runtime()) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(user)},await key(e),new TextEncoder().encode(value));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function decrypt(value:string,user:string,e=runtime()) {
  const [iv, ciphertext]=value.split('.');
  const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:new TextEncoder().encode(user)},await key(e),decode(ciphertext));
  return new TextDecoder().decode(bytes);
}
