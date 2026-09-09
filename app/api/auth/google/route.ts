import { configured, encode, failure, HttpError, runtime, userId } from '@/server/runtime';
export async function GET(){
  try{
    const user=await userId();const e=runtime();
    if(!configured(e))throw new HttpError(503,'Google app credentials are not configured yet. Open Settings & connections for setup details.');
    const state=encode(crypto.getRandomValues(new Uint8Array(32)));
    const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));
    const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    await e.DB.prepare('INSERT INTO oauth_states (state, user_id, verifier, expires) VALUES (?, ?, ?, ?)').bind(state,user,verifier,Date.now()+600000).run();
    const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search=new URLSearchParams({client_id:e.GOOGLE_CLIENT_ID!,redirect_uri:e.APP_URL+'/api/auth/google/callback',response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose',access_type:'offline',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return Response.redirect(auth.toString(),302);
  }catch(error){return failure(error);}
}
