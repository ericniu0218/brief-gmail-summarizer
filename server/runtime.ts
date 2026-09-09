import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
export type Runtime = {
  DB: D1Database; GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string; OPENAI_API_KEY?: string; OPENAI_MODEL?: string; APP_URL?: string;
  UNSUBSCRIBE_ALLOWED_HOSTS?: string;
};
export function runtime() { return env as unknown as Runtime; }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function userId() {
  const user = await getChatGPTUser();
  if (!user) throw new HttpError(401, 'Please sign in to connect your inbox.');
  return user.userId;
}
export function mutation(request: Request) {
  const origin = request.headers.get('origin');
  const expected = runtime().APP_URL || new URL(request.url).origin;
  if (!origin || origin !== expected) throw new HttpError(403, 'Please use this action from your dashboard.');
}
export function json(data: unknown, status=200) {
  return Response.json(data, {status, headers: {'Cache-Control':'private, no-store'}});
}
export function failure(error: unknown) {
  return json({error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.'}, error instanceof HttpError ? error.status : 500);
}
export function configured(e=runtime()) { return !!(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET && e.TOKEN_ENCRYPTION_KEY && e.APP_URL); }
export function encode(input: string | Uint8Array) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return btoa(Array.from(bytes, b=>String.fromCharCode(b)).join('')).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export function decode(input: string) { return Uint8Array.from(atob(input.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0)); }
async function key(e: Runtime) {
  if (!e.TOKEN_ENCRYPTION_KEY) throw new HttpError(503,'The Gmail connection is not configured yet.');
  return crypto.subtle.importKey('raw', decode(e.TOKEN_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt','decrypt']);
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
