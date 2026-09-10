import { GMAIL_RECONNECT_MESSAGE } from './gmail';
import { configured, runtime } from './runtime';

export async function connectionStatus(user:string,e=runtime()){
  const rows=await e.DB.prepare('SELECT id, email, last_sync, error FROM connections WHERE user_id=? ORDER BY email').bind(user).all<{id:string;email:string;last_sync:number|null;error:string|null}>();
  const preference=await e.DB.prepare('SELECT default_account_id FROM account_preferences WHERE user_id=?').bind(user).first<{default_account_id:string}>();
  const accounts=rows.results.map(c=>({id:c.id,email:c.email,lastSync:c.last_sync,error:c.error,reconnectRequired:c.error===GMAIL_RECONNECT_MESSAGE}));
  const defaultAccount=accounts.find(c=>c.id===preference?.default_account_id)||accounts[0];
  const heartbeat=await e.DB.prepare('SELECT last_run FROM agent_status WHERE id = ?').bind('scheduler').first<{last_run:number}>();
  return {connected:accounts.length>0,configured:configured(e),aiConfigured:!!e.OPENAI_API_KEY,accounts,defaultAccountId:defaultAccount?.id||null,email:defaultAccount?.email||null,lastSync:defaultAccount?.lastSync||null,error:defaultAccount?.error||null,schedulerActive:!!heartbeat&&Date.now()-heartbeat.last_run<40*60000,intervalMinutes:30};
}
