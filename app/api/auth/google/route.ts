import { appUrl, configured, encode, failure, googleCallbackUrl, googleClient, HttpError, notConfigured, runtime, SignInRequiredError, userId } from '@/server/runtime';
import { chatGPTSignInPath } from '@/app/chatgpt-auth';
export async function GET(request?:Request){
  try{
    const user=await userId();const e=runtime();
    if(!configured(e))throw notConfigured(e);
    const state=encode(crypto.getRandomValues(new Uint8Array(32)));
    const verifier=encode(crypto.getRandomValues(new Uint8Array(48)));
    const challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
    await e.DB.prepare('INSERT INTO oauth_states (state, user_id, verifier, expires) VALUES (?, ?, ?, ?)').bind(state,user,verifier,Date.now()+600000).run();
    const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search=new URLSearchParams({client_id:googleClient(e).client_id,redirect_uri:googleCallbackUrl(e)!,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose',access_type:'offline',prompt:'consent select_account',state,code_challenge:challenge,code_challenge_method:'S256'}).toString();
    return Response.redirect(auth.toString(),302);
  }catch(error){
    if(request?.headers.get('accept')?.includes('text/html')){
      const origin=appUrl()||new URL(request.url).origin;
      if(error instanceof SignInRequiredError)return Response.redirect(new URL(chatGPTSignInPath('/api/auth/google'),origin),302);
      const message=error instanceof HttpError?error.message:'Could not start the Gmail connection. Please try again.';
      return Response.redirect(origin+'/?connection_error='+encodeURIComponent(message),302);
    }
    return failure(error);
  }
}
