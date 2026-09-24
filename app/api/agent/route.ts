import { runAgent } from '@/server/sync';
import { failure, HttpError, json, runtime } from '@/server/runtime';

/**
 * Protected HTTP entry point for manually starting the background inbox agent. Hosting
 * services call this route with a shared secret; ordinary browser sessions never do.
 */

// Hash both values before comparing them so a caller cannot learn where the secret first
// differs by measuring how quickly the comparison returns.
async function sameSecret(actual:string,expected:string){
  const encoder=new TextEncoder();
  const [left,right]=await Promise.all([actual,expected].map(value=>crypto.subtle.digest('SHA-256',encoder.encode(value))));
  const a=new Uint8Array(left);const b=new Uint8Array(right);let mismatch=0;
  for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];
  return mismatch===0;
}

export async function POST(request:Request){
  try{
    // Authenticate the scheduler before doing any mailbox or database work.
    const e=runtime();
    if(!e.AGENT_CRON_SECRET)throw new HttpError(503,'The background agent is not configured.');
    if(!await sameSecret(request.headers.get('authorization')||'',`Bearer ${e.AGENT_CRON_SECRET}`))throw new HttpError(401,'The background agent request was not authorized.');
    await runAgent(e);
    return json({ok:true});
  }catch(error){return failure(error);}
}
