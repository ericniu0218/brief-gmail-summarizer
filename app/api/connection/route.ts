import { failure, googleCallbackUrl, json, missingSettings, runtime, userId } from '@/server/runtime';
import { ownedConnections } from '@/server/gmail';
import { userProfile } from '@/server/profile';

/**
 * Connection status for settings and inbox startup. It exposes only safe metadata for
 * each mailbox the signed-in user owns: never a token, never another user's account.
 */
export async function GET(){
  try{
    const e=runtime(); const user=await userId();
    const connections=await ownedConnections(user,e);
    const preference=await e.DB.prepare('SELECT default_account_id FROM account_preferences WHERE user_id = ?').bind(user).first<{default_account_id:string}>();
    // A remembered default that no longer exists falls back to the first connection, so
    // the dashboard always opens on a mailbox the user still owns.
    const owned=new Set(connections.map(c=>c.id));
    const defaultAccountId=preference&&owned.has(preference.default_account_id)?preference.default_account_id:connections[0]?.id||null;
    const heartbeat=await e.DB.prepare('SELECT last_run FROM agent_status WHERE id = ?').bind('scheduler').first<{last_run:number}>();
    const missing=missingSettings(e);
    return json({
      // The signed-in user's own id, used only to scope their browser-side preferences.
      userId:user,
      accounts:connections.map(c=>({
        id:c.id,email:c.email,lastSync:c.last_sync,error:c.error,
        // The one error a user can act on directly gets its own flag.
        reconnectRequired:!!c.error&&/reconnect|renew|expired/i.test(c.error),
      })),
      defaultAccountId,
      // The person's own sending settings, shared by every connected mailbox.
      profile:await userProfile(user,e),
      connected:connections.length>0,
      configured:!missing.length,missingSettings:missing,callbackUrl:googleCallbackUrl(e),
      aiConfigured:!!e.GEMINI_API_KEY,
      schedulerActive:!!heartbeat&&Date.now()-heartbeat.last_run<40*60000,intervalMinutes:30,
    });
  }catch(error){return failure(error);}
}
