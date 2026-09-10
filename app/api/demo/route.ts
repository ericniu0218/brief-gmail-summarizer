import { analysisVersion, summarize } from '@/server/ai';
import { failure, json, runtime, userId } from '@/server/runtime';
import { demoEmails } from '@/lib/mail';
const DEMO_CORPUS_VERSION='2';
function fallback(){return {emails:demoEmails,updated:null,ai:false,hasMore:false};}
// The sample inbox is fixed, so its AI summaries are computed once per prompt/model
// version. A short-lived pending row prevents concurrent cold requests from multiplying
// Gemini usage; those callers receive the deterministic fallback while the cache warms.
export async function GET(){
  try{
    await userId();
    const e=runtime();
    if(!e.GEMINI_API_KEY)return json(fallback());
    const cacheId=`${analysisVersion(e)}:demo:${DEMO_CORPUS_VERSION}`;
    const cached=await e.DB.prepare('SELECT data, updated FROM demo_digest WHERE id = ?').bind(cacheId).first<{data:string;updated:number}>();
    if(cached){
      const value=JSON.parse(cached.data) as {emails?:unknown};
      if(Array.isArray(value.emails))return json(value);
      if(Date.now()-cached.updated<120000)return json(fallback());
      await e.DB.prepare('DELETE FROM demo_digest WHERE id = ? AND updated = ?').bind(cacheId,cached.updated).run();
    }
    const pending=JSON.stringify({pending:true});const started=Date.now();
    const claim=await e.DB.prepare('INSERT OR IGNORE INTO demo_digest (id,data,updated) VALUES (?,?,?)').bind(cacheId,pending,started).run();
    if(!claim.meta.changes)return json(fallback());
    let analysis;
    try{analysis=await summarize(demoEmails,e);}
    catch{
      await e.DB.prepare('DELETE FROM demo_digest WHERE id = ? AND data = ?').bind(cacheId,pending).run();
      return json(fallback());
    }
    const snapshot={emails:analysis.emails,updated:Date.now(),ai:analysis.ai,hasMore:false};
    await e.DB.prepare('UPDATE demo_digest SET data = ?, updated = ? WHERE id = ?').bind(JSON.stringify(snapshot),snapshot.updated,cacheId).run();
    return json(snapshot);
  }catch(error){return failure(error);}
}
