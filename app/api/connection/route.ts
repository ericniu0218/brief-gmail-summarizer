import { configured, failure, json, runtime, userId } from '@/server/runtime';
export async function GET(){
  try{
    const e=runtime(); const user=await userId();
    const c=await e.DB.prepare('SELECT email, last_sync, error FROM connections WHERE user_id = ?').bind(user).first<{email:string;last_sync:number|null;error:string|null}>();
    const heartbeat=await e.DB.prepare('SELECT last_run FROM agent_status WHERE id = ?').bind('scheduler').first<{last_run:number}>();
    return json({connected:!!c,configured:configured(e),aiConfigured:!!e.GEMINI_API_KEY,email:c?.email||null,lastSync:c?.last_sync||null,error:c?.error||null,schedulerActive:!!heartbeat&&Date.now()-heartbeat.last_run<40*60000,intervalMinutes:30});
  }catch(error){return failure(error);}
}
