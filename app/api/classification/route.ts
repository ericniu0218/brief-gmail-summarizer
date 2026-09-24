import { failure, inputObject, json, mutation, runtime, userId } from '@/server/runtime';
import { applyOverride, clearOverride, saveOverride, type Override } from '@/server/overrides';
import { applyPolicy } from '@/lib/classification';
import type { Section, Tag } from '@/lib/categories';
import type { Snapshot } from '@/server/sync';

const SECTIONS:Section[]=['work','personal','noise'];
const TAGS:Tag[]=['deadlines','meetings','requests','actions','research','low-priority','junk'];
const STATES=['open','completed','cancelled','superseded','unknown'] as const;

function tagList(value:unknown):Tag[]{
  return Array.isArray(value)?value.filter((tag):tag is Tag=>TAGS.includes(tag as Tag)):[];
}

export async function POST(request:Request){
  try{
    mutation(request);
    const user=await userId();const e=runtime();
    const body=await inputObject(request);
    const messageId=typeof body.messageId==='string'?body.messageId:'';
    if(!messageId)return json({error:'Tell us which message to correct.'},400);

    if(body.reset===true)await clearOverride(user,messageId,e);
    else{
      const category=SECTIONS.includes(body.category as Section)?body.category as Section:undefined;
      const obligationState=STATES.includes(body.obligationState as typeof STATES[number])?body.obligationState as Override['obligationState']:undefined;
      // A correction applies to this message only. A sender-wide rule is a separate,
      // explicit choice and is never created as a side effect.
      await saveOverride(user,{messageId,category,addTags:tagList(body.addTags),removeTags:tagList(body.removeTags),
        notJunk:body.notJunk===true,obligationState,source:body.scope==='rule'?'rule':'message',createdAt:Date.now()},e);
    }

    const stored=await e.DB.prepare('SELECT data FROM snapshots WHERE user_id = ?').bind(user).first<{data:string}>();
    if(!stored)return json({updated:false});
    const snapshot=JSON.parse(stored.data) as Snapshot;
    const now=Date.now();
    const overrides=await (await import('@/server/overrides')).loadOverrides(user,e);
    snapshot.emails=snapshot.emails.map(email=>{
      if(email.id!==messageId||!email.classification)return email;
      const {classification,category,tags,priority,label}=applyPolicy(applyOverride(email.classification,overrides.get(messageId)),now);
      return {...email,classification,category,tags,priority,label};
    });
    await e.DB.prepare('UPDATE snapshots SET data=? WHERE user_id=?').bind(JSON.stringify(snapshot),user).run();
    return json({updated:true,emails:snapshot.emails});
  }catch(error){return failure(error);}
}
