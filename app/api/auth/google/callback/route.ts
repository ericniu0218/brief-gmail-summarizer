import { encrypt, HttpError, runtime, userId } from '@/server/runtime';
export async function GET(request:Request){
  const e=runtime();
  const origin=e.APP_URL || new URL(request.url).origin;
  try{
    const user=await userId(); const url=new URL(request.url);
    if(url.searchParams.has('error'))throw new HttpError(400,'Google connection was cancelled.');
    const state=url.searchParams.get('state'); const code=url.searchParams.get('code');
    if(!state||!code)throw new HttpError(400,'The Google connection could not be completed.');
    const saved=await e.DB.prepare('DELETE FROM oauth_states WHERE state = ? AND user_id = ? AND expires > ? RETURNING verifier').bind(state,user,Date.now()).first<{verifier:string}>();
    if(!saved)throw new HttpError(400,'This connection link expired. Please try again.');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({code,client_id:e.GOOGLE_CLIENT_ID!,client_secret:e.GOOGLE_CLIENT_SECRET!,redirect_uri:origin+'/api/auth/google/callback',grant_type:'authorization_code',code_verifier:saved.verifier}),signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new HttpError(400,'Google could not finish the connection. Please try again.');
    const token=await response.json() as {access_token:string;refresh_token?:string;scope?:string};
    if(!token.refresh_token)throw new HttpError(400,'Offline Gmail access was not granted. Please reconnect and allow access.');
    const scopes=token.scope||'';
    if(!['gmail.readonly','gmail.send','gmail.compose'].every(scope=>scopes.includes('/auth/'+scope)))throw new HttpError(400,'Please allow the requested Gmail permissions to connect Brief.');
    const profile=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});
    if(!profile.ok)throw new HttpError(400,'Gmail access could not be verified. Check that the Gmail API is enabled.');
    const {emailAddress}=await profile.json() as {emailAddress:string};
    const email=emailAddress.toLowerCase();
    await e.DB.batch([
      e.DB.prepare('INSERT INTO connections (user_id,email,token,last_sync,sync_lock,error) VALUES (?,?,?,NULL,0,NULL) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,token=excluded.token,last_sync=NULL,sync_lock=0,error=NULL').bind(user,email,await encrypt(token.refresh_token,user,e)),
      e.DB.prepare('DELETE FROM snapshots WHERE user_id = ?').bind(user),
      e.DB.prepare('DELETE FROM unsubscribed WHERE user_id = ?').bind(user),
    ]);
    return Response.redirect(origin+'/?connected=1',302);
  }catch(error){
    const message=error instanceof HttpError?error.message:'Could not connect Gmail. Please try again.';
    return Response.redirect(origin+'/?connection_error='+encodeURIComponent(message),302);
  }
}
