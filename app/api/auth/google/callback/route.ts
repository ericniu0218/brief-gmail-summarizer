import { appUrl, configured, CURRENT_TOKEN_VERSION, encrypt, googleClient, HttpError, notConfigured, runtime, userId } from '@/server/runtime';

/**
 * Completes Gmail OAuth: consume the one-time state, exchange the authorization code,
 * verify the granted mailbox, encrypt the refresh token, and save the connection.
 */
/** Google's token errors that a retry cannot fix are almost always site or Cloud Console configuration. */
function tokenError(error:unknown,callback:string){
  if(error==='invalid_client'||error==='unauthorized_client')return 'Google rejected this site’s OAuth client. Check that GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the site settings belong to the same Web application client, then redeploy.';
  if(error==='redirect_uri_mismatch')return `Google did not accept this site’s callback. Add ${callback} to the OAuth client’s Authorized redirect URIs.`;
  if(error==='invalid_grant')return 'This Google sign-in expired or was already used. Please connect Gmail again.';
  return 'Google could not finish the connection. Please try again.';
}
export async function GET(request:Request){
  const e=runtime();
  const origin=appUrl(e) || new URL(request.url).origin;
  try{
    const user=await userId(); const url=new URL(request.url);
    if(!configured(e))throw notConfigured(e);
    if(url.searchParams.has('error'))throw new HttpError(400,'Google connection was cancelled.');
    const state=url.searchParams.get('state'); const code=url.searchParams.get('code');
    if(!state||!code)throw new HttpError(400,'The Google connection could not be completed.');
    // Deleting and returning the row in one statement makes every state value single-use.
    // Consuming and reading the intent happen in one statement, so state stays single-use
    // and the action cannot be swapped between validation and use.
    const saved=await e.DB.prepare('DELETE FROM oauth_states WHERE state = ? AND user_id = ? AND expires > ? RETURNING verifier, action, target_account_id').bind(state,user,Date.now()).first<{verifier:string;action:string;target_account_id:string|null}>();
    if(!saved)throw new HttpError(400,'This connection link expired. Please try again.');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,...googleClient(e),redirect_uri:origin+'/api/auth/google/callback',grant_type:'authorization_code',code_verifier:saved.verifier}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new HttpError(400,tokenError((await response.json().catch(()=>null) as {error?:unknown}|null)?.error,origin+'/api/auth/google/callback'));
    const token=await response.json() as {access_token:string;refresh_token?:string;scope?:string};
    // Brief needs offline access for scheduled refreshes and verifies every required Gmail
    // permission before storing the long-lived credential.
    if(!token.refresh_token)throw new HttpError(400,'Offline Gmail access was not granted. Please reconnect and allow access.');
    const scopes=token.scope||'';
    if(!['gmail.readonly','gmail.send','gmail.compose'].every(scope=>scopes.includes('/auth/'+scope)))throw new HttpError(400,'Please allow the requested Gmail permissions to connect Brief.');
    const profile=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});
    if(!profile.ok)throw new HttpError(400,'Gmail access could not be verified. Check that the Gmail API is enabled.');
    const {emailAddress}=await profile.json() as {emailAddress:string};
    const email=emailAddress.toLowerCase();
    const now=Date.now();
    // A mailbox this user has already connected keeps its account id, so reconnecting
    // renews credentials in place. A mailbox they have not connected gets a new opaque id
    // and becomes an additional account: connecting a second Gmail address never replaces
    // or clears the first one's mail, corrections or send receipts.
    // A reconnect is aimed at one specific account, recorded server-side when the flow
    // started. If the mailbox Google returned is not that account, the target is left
    // exactly as it was: silently repointing it would move someone's mail to a different
    // address without them asking. Adding a mailbox is a separate, explicit action.
    if(saved.action==='reconnect'&&saved.target_account_id){
      const target=await e.DB.prepare('SELECT email FROM connections WHERE id = ? AND user_id = ?').bind(saved.target_account_id,user).first<{email:string}>();
      if(!target)throw new HttpError(404,'That Gmail account is no longer connected.');
      if(target.email!==email)throw new HttpError(400,`That Google account does not match ${target.email}. Choose ${target.email} to reconnect it, or use Add Gmail account to connect ${email} as a separate mailbox.`);
    }
    const existing=await e.DB.prepare('SELECT id FROM connections WHERE user_id = ? AND email = ?').bind(user,email).first<{id:string}>();
    const accountId=existing?.id||crypto.randomUUID();
    // Credentials written here are bound to owner *and* account (version 2). A legacy v1
    // token is therefore upgraded naturally the next time its mailbox is reconnected.
    const encryptedToken=await encrypt(token.refresh_token,user,e,accountId);
    // The unique index on (user_id, email) is what actually prevents duplicates, so two
    // callbacks racing for the same mailbox collide in the database rather than in code.
    const results=await e.DB.batch([
      e.DB.prepare('INSERT INTO connections (id,user_id,provider_identity,email,token,token_version,last_sync,sync_lock,error,created) VALUES (?,?,NULL,?,?,?,NULL,0,NULL,?) ON CONFLICT(user_id,email) DO UPDATE SET token=excluded.token,token_version=excluded.token_version,last_sync=NULL,sync_lock=0,error=NULL WHERE connections.sync_lock < ?')
        .bind(accountId,user,email,encryptedToken,CURRENT_TOKEN_VERSION,now,now),
      // The first mailbox a user connects becomes their default; later ones do not take it.
      e.DB.prepare('INSERT INTO account_preferences (user_id,default_account_id) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING').bind(user,accountId),
    ]);
    if(!results[0].meta.changes)throw new HttpError(409,'That inbox is still refreshing. Please try connecting Gmail again when it finishes.');
    return Response.redirect(origin+'/?connected=1',302);
  }catch(error){
    // Unexpected failures (database, encryption) otherwise leave no trace in the hosting logs.
    if(!(error instanceof HttpError))console.error('Gmail connection failed:',error instanceof Error?error.message:String(error));
    const message=error instanceof HttpError?error.message:'Could not connect Gmail. Please try again.';
    return Response.redirect(origin+'/?connection_error='+encodeURIComponent(message),302);
  }
}
