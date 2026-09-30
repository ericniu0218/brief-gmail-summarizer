/** Shared provider domains identify a mailbox service, never a working relationship. */
const PUBLIC_DOMAINS=new Set(['gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com','yahoo.com','ymail.com','aol.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','pm.me','fastmail.com','mail.com','gmx.com','gmx.de','hey.com']);
export function isPublicMailDomain(domain:string){return PUBLIC_DOMAINS.has(domain.toLowerCase());}
export function sameOrganization(sender:string,user:string){
  const domain=sender.toLowerCase().split('@')[1];
  return !!domain&&!isPublicMailDomain(domain)&&domain===user.toLowerCase().split('@')[1];
}

export const MAX_SENDER_ADDRESS=320;

/** Canonical sender key accepted by rules. Invalid or synthetic identities are rejected. */
export function normalizeSenderAddress(value:unknown):string|undefined{
  if(typeof value!=='string')return undefined;
  const address=value.trim().toLowerCase();
  const at=address.indexOf('@');
  let control=false;
  for(let index=0;index<address.length;index++){
    const code=address.charCodeAt(index);
    if(code<=31||code===127){control=true;break;}
  }
  if(!address||address.length>MAX_SENDER_ADDRESS||/\s/.test(address)||control||
    at<=0||at!==address.lastIndexOf('@')||at===address.length-1)return undefined;
  return address;
}
