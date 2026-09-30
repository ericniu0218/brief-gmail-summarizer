/**
 * A single mailbox address safe to write into a To header, or undefined.
 *
 * Internationalised addresses are real addresses: a local part in any script (RFC 6531) and
 * a domain in Unicode or its `xn--` form are accepted, the domain written in its ASCII form.
 * Anything that could end or extend the header is refused — whitespace, control characters,
 * brackets, quotes, commas, a second `@` — so the address can only ever be one recipient.
 */
export function mailboxAddress(value:string):string|undefined{
  const at=value.lastIndexOf('@');
  if(at<=0||at!==value.indexOf('@')||value.length>320)return undefined;
  const local=value.slice(0,at),domain=value.slice(at+1);
  if(local.length>64||/[\s\p{Cc}<>()[\],;:"\\]/u.test(local)||/^\.|\.$|\.\./.test(local))return undefined;
  if(!domain||/[\s\p{Cc}<>()[\],;:"\\@/?#%]/u.test(domain))return undefined;
  let ascii:string;
  try{ascii=new URL(`http://${domain}`).hostname;}catch{return undefined;}
  const labels=ascii.split('.');
  if(labels.length<2||labels.some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))return undefined;
  // A top-level domain is letters, or an internationalised one in its xn-- form.
  if(!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels[labels.length-1]))return undefined;
  return `${local}@${ascii}`;
}

/** Only mailbox addresses are emitted into To; unparseable Reply-To fails closed. */
export function replyAddress(headers:readonly {name?:string;value?:string}[],from:string):string|undefined{
  const values=headers.filter(h=>h.name?.toLowerCase()==='reply-to').map(h=>h.value??'');
  if(!values.length)return mailboxAddress(from);
  if(values.length!==1)return undefined;
  const value=values[0].replace(/\r?\n[ \t]+/g,' ').trim();
  if(Array.from(value).some(char=>{const code=char.charCodeAt(0);return code<32||code===127;}))return undefined;
  // Multi-address/group Reply-To values are left to Gmail rather than partially parsed.
  const match=/^(?:"[^"<>]*"|[^"<>,:;]*)\s*<([^<>]+)>$/.exec(value);
  const address=(match?.[1]||value).trim();
  return mailboxAddress(address);
}
