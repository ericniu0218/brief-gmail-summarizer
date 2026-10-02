import { emailKey, type Email } from './mail';
import type { Digest } from './digest';

/**
 * Hand-written wording for the sample inbox, in the style the AI produces for a real one. The
 * sample emails are ranked by the same importance policy as real mail; only the words are fixed.
 */
const item=(id:string,action:Digest['items'][number]['action'],headline:string,why:string)=>({id:emailKey({id} as Email),fp:'demo',action,headline,why});
export const demoDigest:Digest={generated:0,items:[
  item('1','decide','The website launch is ready for your sign-off.','Sarah needs your approval by 2 PM today to keep Thursday’s launch on track.'),
  item('15','deadline','Finish benefits changes before enrollment closes','Open enrollment closes Friday at 5 PM; your current elections carry over if you do nothing.'),
  item('16','review','Rotate your VPN password','IT Security asks you to rotate it from the IT portal by the end of the week; it takes about two minutes.'),
  item('17','decide','Sign the Meridian NDA','Sofia needs your signature on the NDA before the next round of Meridian materials can be shared.'),
  item('2','review','Two budget items need a second look.','James has shared the revised Q3 budget ahead of tomorrow’s review.'),
  item('20','reply','Confirm you can join the Meridian call','Kevin says Meridian moved the call to 11 AM and asked you to walk through the roadmap slide.'),
  item('21','reply','Share feedback on the onboarding mockups','Ana needs your feedback by Wednesday so the design can be locked before development starts.'),
  item('23','reply','Answer about Mom’s birthday dinner','David needs a headcount for dinner this Sunday at 6.'),
  item('3','reply','A quick yes or no for Emily.','She’s checking if Thursday at 10 AM works for a project catch-up.'),
  item('25','reply','Confirm the 6 AM gym session','Jordan is checking that you are still on, or want to push it.'),
  item('40','security','Use your GitHub verification code','GitHub sent a verification code to finish signing in; secure your account if it was not you.'),
  item('41','security','Finish GitHub two-factor setup','Complete two-factor authentication to keep repository access secure.'),
  item('50','meeting','Confirm Thursday’s rebuttal meeting','Helena wants to meet Thursday at 3 PM; the camera-ready manuscript is due Friday at 5 PM.'),
  item('52','reply','Decide on reviewing manuscript JAS-2291','The journal asks whether you are able to review the manuscript.'),
  item('54','reply','Call David about Dad’s surgery','David asks you to call about who is driving Dad to his moved-up surgery.'),
]};
