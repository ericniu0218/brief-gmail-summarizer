import { appUrl, configured, encrypt, googleClient, HttpError, notConfigured, runtime, userId } from '@/server/runtime';

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
    const saved=await e.DB.prepare('DELETE FROM oauth_states WHERE state = ? AND user_id = ? AND expires > ? RETURNING verifier').bind(state,user,Date.now()).first<{verifier:string}>();
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
    const encryptedToken=await encrypt(token.refresh_token,user,e);
    const now=Date.now();
    // Inspect the old mailbox before replacing it, in the same atomic batch.
    // An active refresh must finish before its connection can be replaced.
    // Manual corrections are per message, so a different mailbox clears them too.
    const results=await e.DB.batch([
      ...['snapshots','unsubscribed','operations','overrides'].map(table=>
        e.DB.prepare(`DELETE FROM ${table} WHERE user_id = ? AND EXISTS (SELECT 1 FROM connections WHERE user_id = ? AND email != ? AND sync_lock < ?)`).bind(user,user,email,now)),
      e.DB.prepare('INSERT INTO connections (user_id,email,token,last_sync,sync_lock,error) VALUES (?,?,?,NULL,0,NULL) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,token=excluded.token,last_sync=NULL,sync_lock=0,error=NULL WHERE connections.sync_lock < ?').bind(user,email,encryptedToken,now),
    ]);
    // The connection write is last; index-free so adding a cleanup cannot silently break it.
    if(!results.at(-1)!.meta.changes)throw new HttpError(409,'Your inbox is still refreshing. Please try connecting Gmail again when it finishes.');
    return Response.redirect(origin+'/?connected=1',302);
  }catch(error){
    // Unexpected failures (database, encryption) otherwise leave no trace in the hosting logs.
    if(!(error instanceof HttpError))console.error('Gmail connection failed:',error instanceof Error?error.message:String(error));
    const message=error instanceof HttpError?error.message:'Could not connect Gmail. Please try again.';
    return Response.redirect(origin+'/?connection_error='+encodeURIComponent(message),302);
  }
}
