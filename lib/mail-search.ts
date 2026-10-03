import type { Email } from './mail';

const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
/** Immutable mailbox objects retain their index across keystrokes; replaced or edited records rebuild it. */
type SearchIndex={fields:string[];sender:string;subject:string;content:string;source:string;lower:string;offsets?:number[]};
const indexes=new WeakMap<Email,SearchIndex>();
function indexFor(email:Email):SearchIndex{
  const fields=[email.sender,email.address,email.subject,email.body,email.quoted||'',email.signature||'',email.summary];
  const hit=indexes.get(email);
  if(hit&&fields.every((field,i)=>field===hit.fields[i]))return hit;
  const source=([email.body,email.quoted||'',email.signature||''].filter(Boolean).join('\n\n')||email.summary).normalize('NFKC').replace(/\s+/g,' ').trim();
  const next={fields,sender:normalize(`${email.sender} ${email.address}`),subject:normalize(email.subject),content:normalize(fields.join('\n')),source,lower:normalize(source)};
  indexes.set(email,next);
  return next;
}
/** Lowercasing can itself expand Unicode characters. Map folded UTF-16 positions to visible text. */
function sourceOffset(index:SearchIndex,offset:number){
  if(!index.offsets){
    const offsets:number[]=[];
    let position=0;
    for(const char of index.source){for(let i=0;i<char.toLocaleLowerCase().length;i++)offsets.push(position);position+=char.length;}
    offsets.push(position);index.offsets=offsets;
  }
  return index.offsets[offset]??index.source.length;
}
/** Words can appear anywhere in the message; quotes keep a phrase together. */
export function searchTerms(query:string){
  return (query.match(/"[^"]+"|\S+/g)||[]).map(term=>normalize(term.replace(/^"|"$/g,''))).filter(Boolean);
}
export function parseMailSearch(query:string){
  const tokens=query.match(/(?:from|subject|category):(?:"[^"]*"|\S*)|"[^"]+"|\S+/gi)||[];
  const terms:string[]=[],filters:{from?:string;subject?:string;category?:string;attachment?:boolean;unread?:boolean;reply?:boolean;days?:number}={};
  for(const token of tokens){
    const field=/^(from|subject|category):(.*)$/i.exec(token);
    if(field){filters[field[1].toLowerCase() as 'from'|'subject'|'category']=normalize(field[2].replace(/^"|"$/g,''));continue;}
    const lower=token.toLowerCase();
    if(lower==='has:attachment'){filters.attachment=true;continue;}
    if(lower==='is:unread'){filters.unread=true;continue;}
    if(lower==='needs:reply'){filters.reply=true;continue;}
    const days=/^newer_than:(\d{1,4})d$/i.exec(token);
    if(days){filters.days=Number(days[1]);continue;}
    terms.push(...searchTerms(token));
  }
  return {terms,filters};
}

export function searchMail(emails:Email[],query:string,sender='',now=Date.now()):Email[]{
  const {terms,filters}=parseMailSearch(query),from=normalize(sender);
  return emails.filter(email=>{
    const index=(from||filters.from||filters.subject||terms.length)?indexFor(email):undefined;
    if(from&&!index!.sender.includes(from))return false;
    if(filters.from&&!index!.sender.includes(filters.from))return false;
    if(filters.subject&&!index!.subject.includes(filters.subject))return false;
    if(filters.category&&email.category!==filters.category)return false;
    if(filters.attachment&&!email.hasAttachments&&!email.incompleteReasons?.includes('attachments-not-read'))return false;
    if(filters.unread&&!email.unread)return false;
    if(filters.reply&&!email.needsReply)return false;
    if(filters.days!==undefined&&(!email.receivedAt||email.receivedAt<now-filters.days*86400000||email.receivedAt>now))return false;
    return terms.every(term=>index!.content.includes(term));
  }).sort((a,b)=>(b.receivedAt||0)-(a.receivedAt||0));
}

/** Prefer matching source text over the generated summary, and reveal the matching passage. */
export function searchExcerpt(email:Email,query:string){
  const index=indexFor(email),clean=index.source,lower=index.lower;
  const offsets=parseMailSearch(query).terms.map(term=>lower.indexOf(term)).filter(index=>index>=0);
  const at=offsets.length?sourceOffset(index,Math.min(...offsets)):0;
  const start=Math.max(0,at-70),end=Math.min(clean.length,start+230);
  return `${start?'…':''}${clean.slice(start,end)}${end<clean.length?'…':''}`;
}
