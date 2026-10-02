import { mailboxAddress } from './reply-address';

/** The one definition of a usable recipient: the app's own header-safe mailbox check. */
export function normalizeAddress(address:string):string|undefined {return mailboxAddress(address.trim());}
export function isValidAddress(address:string){return normalizeAddress(address)!==undefined;}

/**
 * Everyone a reply-all should copy: the original To and Cc, minus the user's own address and
 * anyone already named as the main recipient. Computed from message headers on the server
 * (the authority) and in the browser (only to show who would be copied).
 */
export function replyAllCc(email:{to?:string[];cc?:string[]},exclude:string[]):string[] {
  const skip=new Set(exclude.map(address=>address.toLowerCase()));
  const seen=new Map<string,string>();
  for(const address of [...(email.to||[]),...(email.cc||[])]){
    const key=address.toLowerCase();
    if(isValidAddress(address)&&!skip.has(key)&&!seen.has(key))seen.set(key,address);
  }
  return [...seen.values()];
}
