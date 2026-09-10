import { polishReply, replyOptions } from '@/server/ai';
import { failure, HttpError, json, mutation, userId } from '@/server/runtime';
import { demoEmails } from '@/lib/mail';
// Sample-inbox replies. The message is looked up server-side by id, so this route
// generates only from the fixed demo corpus and never from caller-supplied text.
export async function POST(request:Request){
  try{
    mutation(request);await userId();
    const input=await request.json() as {id?:string;action?:string;tone?:string;variation?:number;notes?:string};
    const email=demoEmails.find(m=>m.id===input.id);
    if(!email)throw new HttpError(400,'Choose an email from the sample inbox.');
    const tone=['Concise','Friendly','Professional'].includes(input.tone||'')?input.tone!:'Concise';
    if(input.action==='polish'){
      if(typeof input.notes!=='string'||!input.notes.trim())throw new HttpError(400,'Describe what you want to say first.');
      if(input.notes.length>4000)throw new HttpError(400,'Keep your notes under 4,000 characters.');
      return json(await polishReply(email,input.notes,tone));
    }
    const variation=typeof input.variation==='number'&&Number.isInteger(input.variation)?Math.min(Math.max(input.variation,0),50):0;
    return json(await replyOptions(email,tone,variation));
  }catch(error){return failure(error);}
}
