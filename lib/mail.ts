export type Email = {
  id: string; threadId?: string; sender: string; address: string; initials: string;
  subject: string; summary: string; body: string; time: string; category: 'work' | 'personal' | 'noise';
  priority: 'high' | 'normal'; needsReply: boolean; unread: boolean; color: string; label?: string;
  messageId?: string; unsubscribe?: string; oneClick?: boolean;
};
// Only the raw message is authored here — sender, subject, body. The AI-derived fields
// (summary, category, priority, needsReply, label) are placeholders until `/api/demo`
// runs the same summarize() pass a connected mailbox gets; nothing here is hand-classified.
type Seed = {id:string;sender:string;address:string;subject:string;body:string;time:string;color:string;unread:boolean;unsubscribe?:string;oneClick?:boolean};
function seed(s:Seed):Email {
  return {id:s.id,sender:s.sender,address:s.address,initials:s.sender.split(/\s+/).slice(0,2).map(n=>n[0]).join('').toUpperCase(),
    subject:s.subject,summary:s.body.replace(/\s+/g,' ').trim().slice(0,140),body:s.body,time:s.time,
    category:'personal',priority:'normal',needsReply:false,unread:s.unread,color:s.color,label:'Mail',
    unsubscribe:s.unsubscribe,oneClick:s.oneClick};
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
