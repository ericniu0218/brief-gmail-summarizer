import type { Runtime } from './runtime';

/**
 * The person's own sending settings: the name that signs AI-written emails and the signature
 * added under new ones. Both are text the user typed, never read from a mail header or from
 * the name on an account, so neither can be put there by a stranger.
 */
export const MAX_SIGNATURE=500;
export const MAX_NAME=80;
// The name is placed in AI instructions and email sign-offs, so only letters, numbers, spaces
// and a few name punctuation marks survive.
export function cleanName(value:unknown):string {
  if(typeof value!=='string')return '';
  return value.normalize('NFC').replace(/\s+/g,' ').replace(/[^\p{L}\p{M}\p{N} .,'’-]/gu,'').replace(/ {2,}/g,' ').trim().slice(0,MAX_NAME);
}
// Plain text only: line breaks are kept, other control and invisible characters are dropped.
export function cleanSignature(value:unknown):string {
  if(typeof value!=='string')return '';
  return value.normalize('NFC').replace(/\r\n?/g,'\n').replace(/[^\P{C}\n\t]/gu,'').replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').trim().slice(0,MAX_SIGNATURE);
}
export type Profile={name:string;signature:string};
export async function userProfile(user:string,e:Runtime):Promise<Profile> {
  const row=await e.DB.prepare('SELECT display_name, signature FROM user_profiles WHERE user_id = ?').bind(user).first<{display_name:string|null;signature:string|null}>();
  return {name:cleanName(row?.display_name),signature:cleanSignature(row?.signature)};
}
/** Saves only the fields given; the other keeps its value. An empty string clears a field. */
export async function saveProfile(user:string,e:Runtime,change:Partial<Profile>):Promise<Profile> {
  const current=await userProfile(user,e);
  const next={name:change.name??current.name,signature:change.signature??current.signature};
  await e.DB.prepare('INSERT INTO user_profiles (user_id, display_name, signature) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name, signature=excluded.signature')
    .bind(user,next.name||null,next.signature||null).run();
  return next;
}
export { signatureBlock } from '@/lib/signature';
