import type { Section, Tag } from './categories';
import type { Classification } from './classification';

export type Email = {
  id: string; accountId?: string; accountEmail?: string; threadId?: string; sender: string; address: string; initials: string;
  subject: string; summary: string; body: string; time: string; category: Section;
  priority: 'high' | 'normal'; needsReply: boolean; unread: boolean; color: string; label?: string;
  tags?: Tag[];
  /** Quoted history, kept separate so old requests are not read as new tasks. */
  quoted?: string;
  contentComplete?: boolean;
  incompleteReasons?: string[];
  classification?: Classification;
  receivedAt?: number; messageId?: string; unsubscribe?: string; oneClick?: boolean;
};
// These deterministic classifications keep the demo useful when Gemini is unavailable.
// AI replaces them with richer summaries and labels when `/api/demo` succeeds.
type Seed = {id:string;sender:string;address:string;subject:string;body:string;time:string;color:string;unread:boolean;unsubscribe?:string;oneClick?:boolean;category?:Section;tags?:Tag[]};
const workIds=new Set(['1','2','3','4','5','15','16','17','18','19','20','21','22','50','52','53']);
const highPriorityIds=new Set(['1','2','15','16','17','20','40','41','50','54']);
const replyIds=new Set(['1','2','3','5','6','17','20','21','23','25','50','52']);
// Demo tags are explicit so the sample workspace exercises every subcategory and the
// overlapping cases (a research meeting that also carries a submission deadline).
const demoTags:Record<string,Tag[]>={
  '1':['requests','deadlines'],'2':['requests','deadlines'],'3':['meetings'],'4':[],'5':['requests'],
  '6':['meetings'],'15':['deadlines','actions'],'16':['actions','deadlines'],'17':['requests','deadlines'],
  '18':[],'19':['deadlines','actions'],'20':['meetings','requests'],'21':['requests','deadlines'],'22':[],
  '23':['meetings'],'24':['low-priority'],'25':['meetings'],'40':['actions'],'41':['actions'],
  '50':['research','meetings','deadlines'],'51':['research'],'52':['research','requests'],
  '53':['research','deadlines'],'54':['meetings'],'55':['low-priority'],
};
function seed(s:Seed):Email {
  const category:Section=s.category||(s.oneClick?'noise':workIds.has(s.id)?'work':'personal');
  const priority:Email['priority']=highPriorityIds.has(s.id)?'high':'normal';
  const tags:Tag[]=s.tags||demoTags[s.id]||(category==='noise'?['junk']:[]);
  return {id:s.id,sender:s.sender,address:s.address,initials:s.sender.split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase(),
    subject:s.subject,summary:s.body.replace(/\s+/g,' ').trim().slice(0,140),body:s.body,time:s.time,
    category,priority,needsReply:replyIds.has(s.id),unread:s.unread,color:s.color,label:category==='noise'?'Newsletter':priority==='high'?'Important':category==='work'?'Work':'Personal',
    tags,unsubscribe:s.unsubscribe,oneClick:s.oneClick};
}
export const demoEmails: Email[] = [
  seed({id:'1',sender:'Sarah Chen',address:'sarah@studio.example',subject:'Website launch — final approval',body:'Hi Alex,\n\nThe final website designs are ready for your review. We’ve incorporated the feedback from yesterday, and the engineering team is all set.\n\nCould you give us your final approval by 2 PM so we can stay on track for Thursday’s launch?\n\nThanks!\nSarah',time:'9:42 AM',color:'purple',unread:true}),
  seed({id:'2',sender:'James Miller',address:'james@studio.example',subject:'Q3 budget review',body:'Hi Alex,\n\nI’ve updated the Q3 budget with the latest forecasts. Could you review the contractor and software line items before our meeting tomorrow?\n\nLet me know if you need more context.\nJames',time:'9:18 AM',color:'blue',unread:true}),
  seed({id:'3',sender:'Emily Park',address:'emily@partner.example',subject:'A quick check-in before Thursday',body:'Hey Alex,\n\nAre you available for a 30-minute project check-in on Thursday at 10 AM? We’ll go over the latest milestones and next steps.\n\nThanks,\nEmily',time:'8:56 AM',color:'rose',unread:true}),
  seed({id:'4',sender:'Daniel Kim',address:'daniel@studio.example',subject:'Your weekly product update',body:'Hi team,\n\nThis week: the new onboarding flow is live, our mobile refresh is in design review, and the roadmap is on track. No action needed — just keeping you in the loop.\n\nDaniel',time:'8:30 AM',color:'green',unread:false}),
  seed({id:'5',sender:'Notion',address:'team@notion.example',subject:'You were mentioned in Design team',body:'Olivia mentioned you in the launch checklist:\n\n“Alex, could you take a look at the handoff notes when you get a chance?”',time:'8:12 AM',color:'gray',unread:false}),
  seed({id:'6',sender:'Mia Thompson',address:'mia@personal.example',subject:'Dinner this weekend?',body:'Hey!\n\nA few of us are grabbing dinner on Saturday around 7. Would love to see you there. Can you make it?\n\nMia',time:'Yesterday',color:'amber',unread:false}),
  seed({id:'15',sender:'Priya Nair',address:'priya@studio.example',subject:'Benefits enrollment closes Friday',body:'Hi Alex,\n\nJust a reminder that open enrollment for benefits closes this Friday at 5 PM. If you want to make any changes to your plan, please submit them before then — otherwise your current elections will carry over automatically.\n\nPriya, People Ops',time:'Yesterday',color:'blue',unread:true}),
  seed({id:'16',sender:'Marcus Lee',address:'marcus@studio.example',subject:'Action needed: rotate your VPN password',body:'Hi Alex,\n\nAs part of our quarterly security review, please rotate your VPN password by end of week. You can do this from the IT portal — it takes about two minutes.\n\nLet us know if you run into any issues.\n\nMarcus, IT Security',time:'Yesterday',color:'rose',unread:true}),
  seed({id:'17',sender:'Sofia Alvarez',address:'sofia@legalpartner.example',subject:'NDA signature needed for the Meridian contract',body:'Hi Alex,\n\nWe’re ready to move forward with Meridian, but we need your signature on the attached NDA before we can share the next round of materials. Could you sign and return it by tomorrow?\n\nSofia',time:'2 days ago',color:'purple',unread:true}),
  seed({id:'18',sender:'Tom Bradley',address:'tom@studio.example',subject:'Heads up: staging environment down Sunday 2–4 AM',body:'Hi all,\n\nWe’ll be taking the staging environment offline Sunday from 2 to 4 AM for a database migration. No action needed on your end — just flagging in case you’re testing anything over the weekend.\n\nTom',time:'2 days ago',color:'green',unread:false}),
  seed({id:'19',sender:'Grace Liu',address:'grace@studio.example',subject:'Expense reports due end of month',body:'Hi Alex,\n\nFriendly reminder that all expense reports for this quarter are due by the end of the month. If you have any outstanding receipts, please submit them through the finance portal.\n\nGrace, Finance',time:'2 days ago',color:'amber',unread:false}),
  seed({id:'20',sender:'Kevin Osei',address:'kevin@studio.example',subject:'Can you join the client call tomorrow at 11?',body:'Hey Alex,\n\nThe Meridian team pushed our call to tomorrow at 11 AM — could you join? They specifically asked if you’d be there to walk through the roadmap slide.\n\nLet me know either way.\nKevin',time:'2 days ago',color:'blue',unread:true}),
  seed({id:'21',sender:'Ana Rodriguez',address:'ana@studio.example',subject:'Feedback needed: new onboarding mockups',body:'Hi Alex,\n\nI’ve attached the latest onboarding flow mockups. Could you take a look and share feedback by Wednesday? We’d like to lock the design before development starts next sprint.\n\nThanks,\nAna',time:'3 days ago',color:'rose',unread:false}),
  seed({id:'22',sender:'Chris Park',address:'chris@studio.example',subject:'Office closed Monday for maintenance',body:'Hi everyone,\n\nThe office will be closed Monday for scheduled HVAC maintenance. Everyone should plan to work remotely that day. We expect things to be back to normal Tuesday morning.\n\nChris, Facilities',time:'3 days ago',color:'gray',unread:false}),
  seed({id:'23',sender:'David Chen',address:'david@family.example',subject:'Mom’s birthday dinner — can you make Sunday?',body:'Hey,\n\nWe’re doing dinner for Mom’s birthday this Sunday at 6, at the usual place. Can you make it? Let me know so I can give the restaurant a headcount.\n\nDavid',time:'3 days ago',color:'purple',unread:true}),
  seed({id:'24',sender:'Lauren Wells',address:'lauren@personal.example',subject:'Loved catching up yesterday!',body:'Hey!\n\nHad such a good time catching up yesterday, it had been way too long. We should make it a regular thing. Let’s not wait another six months!\n\nLauren',time:'4 days ago',color:'amber',unread:false}),
  seed({id:'25',sender:'Jordan Reyes',address:'jordan@personal.example',subject:'Still on for 6 AM tomorrow?',body:'Hey, still good for the gym at 6 tomorrow? Let me know if you need to push it — no worries either way.\n\nJordan',time:'4 days ago',color:'green',unread:true}),
  seed({id:'40',sender:'GitHub',address:'noreply@github.com',subject:'Your GitHub verification code',body:'Use verification code 482917 to finish signing in. If you did not request this code, secure your account.',time:'Today',color:'gray',unread:true}),
  seed({id:'41',sender:'GitHub Security',address:'security@github.com',subject:'Complete your two-factor authentication setup',body:'Your account setup is incomplete. Complete two-factor authentication to keep repository access secure.',time:'Today',color:'gray',unread:true}),
  seed({id:'50',sender:'Dr. Helena Voss',address:'h.voss@lab.example.edu',subject:'Rebuttal meeting Thursday — camera-ready manuscript due Friday',body:'Hi Alex,\n\nCan we meet Thursday at 3 PM to go over the reviewer rebuttal? The camera-ready manuscript is due Friday at 5 PM, so this is our last chance to fold in the new experiment results.\n\nPlease confirm Thursday works.\n\nHelena',time:'8:05 AM',color:'purple',unread:true}),
  seed({id:'51',sender:'Nature Briefing',address:'briefing@nature-newsletter.example',subject:'This week in genomics: three preprints worth reading',body:'Your weekly research digest. This week: a large-scale dataset release on variant calling, a preprint on reproducible sequencing pipelines, and commentary on peer review reform.',time:'7:40 AM',color:'green',unread:false,unsubscribe:'https://list-manage.com/unsubscribe?id=nature',oneClick:true,category:'work'}),
  seed({id:'52',sender:'Journal of Applied Systems',address:'reviews@jas-journal.example.org',subject:'Peer review request: manuscript JAS-2291',body:'Dear Dr. Alex,\n\nWe would value your review of manuscript JAS-2291, “Reproducibility in distributed experiment pipelines.” Could you let us know whether you are able to review it?\n\nEditorial Office',time:'Yesterday',color:'blue',unread:true}),
  seed({id:'53',sender:'Research Grants Office',address:'grants@university.example.edu',subject:'NSF grant proposal deadline moved to March 14',body:'A reminder that the NSF funding call proposal deadline has moved to March 14. Budget justification and the data management plan must be submitted by that date.',time:'Yesterday',color:'amber',unread:false}),
  seed({id:'54',sender:'David Chen',address:'david@family.example',subject:'Dad’s surgery moved to tomorrow — can you call tonight?',body:'Hey,\n\nThe hospital moved Dad’s surgery up to tomorrow morning. Can you call me tonight so we can sort out who’s driving him? It’s pretty urgent.\n\nDavid',time:'Today',color:'rose',unread:true}),
  seed({id:'55',sender:'Book Club',address:'hello@bookclub.example',subject:'Next month we’re reading Piranesi',body:'No rush on this one — we picked Piranesi for next month. Meeting details will come later.',time:'5 days ago',color:'gray',unread:false,category:'personal'}),
  ...[
    ['26','The Daily Edit','Your daily dose of inspiration','A roundup of design inspiration and this week’s stories.','purple'],
    ['27','The Daily Edit','Five things worth a look','Five links from around the web.','purple'],
    ['28','Shop Supply','A little something for your desk','New arrivals and a limited-time promotion.','rose'],
    ['29','Shop Supply','Your weekend offer is here','This weekend’s sale and product picks.','rose'],
    ['30','Product Digest','This week in product','A weekly collection of product launches.','blue'],
    ['31','Product Digest','Meet your next favorite tool','The latest apps and tools from Product Digest.','blue'],
    ['32','Travel Notes','Your next escape starts here','Travel ideas and special offers for the season.','green'],
    ['33','Travel Notes','A change of scenery','Featured destinations and this month’s deals.','green'],
    ['34','TechWeekly','This week in tech','The five stories everyone in tech is talking about.','gray'],
    ['35','TechWeekly','Your Friday reading list','Longform picks for the weekend.','gray'],
    ['36','FitLife','Your workout plan is ready','A new plan tailored to your goals, plus a member discount.','amber'],
    ['37','FitLife','Don’t lose your streak','Members like you are hitting new goals this month.','amber'],
    ['38','HomeGoods Co.','New arrivals for fall','Fresh picks for the season, up to 30% off.','rose'],
    ['39','HomeGoods Co.','Your cart misses you','Items in your cart are almost sold out.','rose'],
  ].map(([id,sender,subject,body,color])=>seed({id,sender,subject,body,color,unread:false,time:'Today',address:sender.toLowerCase().replaceAll(' ','').replaceAll('.','')+'@newsletter.example',oneClick:true})),
];

export function emailKey(email: Email): string { return JSON.stringify([email.accountId || 'demo', email.id]); }
export function senderKey(email: Email): string { return JSON.stringify([email.accountId || 'demo', email.address]); }
export function gmailLink(email: Email): string {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email.accountEmail || '')}#all/${encodeURIComponent(email.threadId || email.id)}`;
}
