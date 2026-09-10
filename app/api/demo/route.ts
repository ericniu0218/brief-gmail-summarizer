import { summarize } from '@/server/ai';
import { failure, json, runtime, userId } from '@/server/runtime';
import { demoEmails } from '@/lib/mail';
// The sample inbox is fixed, so its AI summaries are computed once and cached, rather
// than re-billing every visitor's session against the same handful of Gemini calls.
export async function GET(){
  try{
    await userId();
    const e=runtime();
    const cached=await e.DB.prepare('SELECT data FROM demo_digest WHERE id = ?').bind('v1').first<{data:string}>();
    if(cached)return json(JSON.parse(cached.data));
    const analysis=await summarize(demoEmails,e);
    const snapshot={emails:analysis.emails,updated:Date.now(),ai:analysis.ai,hasMore:false};
    if(analysis.ai)await e.DB.prepare("INSERT INTO demo_digest (id,data,updated) VALUES ('v1',?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated").bind(JSON.stringify(snapshot),snapshot.updated).run();
    return json(snapshot);
  }catch(error){return failure(error);}
}
