import { replySuggestion } from '@/server/ai';
import { failure, inputObject, HttpError, json, mutation, userId } from '@/server/runtime';
import { demoEmails } from '@/lib/mail';
// Sample-inbox replies. The message is looked up server-side by id, so this route
// generates only from the fixed demo corpus and never from caller-supplied text.
export async function POST(request:Request){
  try{
    mutation(request);await userId();
    const input=await inputObject(request) as {id?:string;tone?:string;variation?:number};
    const email=demoEmails.find(m=>m.id===input.id);
    if(!email)throw new HttpError(400,'Choose an email from the sample inbox.');
    const tone=['Concise','Friendly','Professional'].includes(input.tone||'')?input.tone!:'Concise';
    const variation=typeof input.variation==='number'&&Number.isInteger(input.variation)?Math.min(Math.max(input.variation,0),50):0;
    return json(await replySuggestion(email,tone,variation));
  }catch(error){return failure(error);}
}
