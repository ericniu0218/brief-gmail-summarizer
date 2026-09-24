import { appUrl, configured, encode, failure, googleCallbackUrl, googleClient, HttpError, notConfigured, runtime, SignInRequiredError, userId } from '@/server/runtime';
import { chatGPTSignInPath } from '@/app/chatgpt-auth';
import { getOwnedConnection } from '@/server/gmail';

/**
 * Starts Gmail OAuth. It creates a short-lived state value to prevent forged callbacks
 * and a PKCE verifier so the authorization code is useful only to this browser flow.
 *
 * Two intents are supported. `add` connects an additional mailbox. `reconnect` renews one
 * specific account, and the account it targets is recorded in server-side state *after*
 * ownership is verified here — the callback never learns which connection to replace from
 * a query parameter it was handed.
 */
export async function GET(request?:Request){
  try{
    const user=await userId();const e=runtime();
    if(!configured(e))throw notConfigured(e);
    const requested=request?new URL(request.url).searchParams:new URLSearchParams();
    const action=requested.get('action')==='reconnect'?'reconnect':'add';
    // A reconnect target must belong to this user. An unowned or unknown id is refused
    // before Google is contacted, so a forged link cannot aim the flow at someone else.
    const target=action==='reconnect'?(await getOwnedConnection(user,requested.get('accountId')||'',e)).id:null;
    const state=encode(crypto.getRandomValues(new Uint8Array(32)));
    const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));
    const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    // Save the verifier and intent server-side; only the random state goes through Google.
    await e.DB.prepare('INSERT INTO oauth_states (state, user_id, verifier, action, target_account_id, expires) VALUES (?, ?, ?, ?, ?, ?)').bind(state,user,verifier,action,target,Date.now()+600000).run();
    const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search=new URLSearchParams({client_id:googleClient(e).client_id,redirect_uri:googleCallbackUrl(e)!,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose',access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return Response.redirect(auth.toString(),302);
  }catch(error){
    // Direct browser visits return to the dashboard with a readable error. Programmatic
    // requests receive the standard JSON error shape used by the rest of the API.
    if(request?.headers.get('accept')?.includes('text/html')){
      const origin=appUrl()||new URL(request.url).origin;
      if(error instanceof SignInRequiredError)return Response.redirect(new URL(chatGPTSignInPath('/api/auth/google'),origin),302);
      const message=error instanceof HttpError?error.message:'Could not start the Gmail connection. Please try again.';
      return Response.redirect(origin+'/?connection_error='+encodeURIComponent(message),302);
    }
    return failure(error);
  }
}
