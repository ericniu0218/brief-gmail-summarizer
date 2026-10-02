import { failure, HttpError, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { cleanName, cleanSignature, MAX_SIGNATURE, saveProfile, userProfile } from '@/server/profile';

/**
 * Saves the name that signs AI-written replies and drafts, and the signature added to new
 * emails. Either can be sent alone; an empty value clears it. Both belong to the person, so
 * they apply whichever connected mailbox an email leaves from.
 */
export async function GET(){
  try{return json(await userProfile(await userId(),runtime()));}
  catch(error){return failure(error);}
}
export async function POST(request:Request){
  try{
    mutation(request);const user=await userId();const e=runtime();
    const input=await inputObject(request);
    const change:{name?:string;signature?:string}={};
    if('name' in input){
      if(typeof input.name!=='string')throw new HttpError(400,'Enter your name.');
      const name=cleanName(input.name);
      if(input.name.trim()&&!name)throw new HttpError(400,'Use letters and numbers for your name.');
      change.name=name;
    }
    if('signature' in input){
      if(typeof input.signature!=='string')throw new HttpError(400,'Enter your signature as text.');
      if(input.signature.trim().length>MAX_SIGNATURE)throw new HttpError(400,`Keep your signature under ${MAX_SIGNATURE} characters.`);
      change.signature=cleanSignature(input.signature);
    }
    if(!Object.keys(change).length)throw new HttpError(400,'There is nothing to save.');
    return json(await saveProfile(user,e,change));
  }catch(error){return failure(error);}
}
