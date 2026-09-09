export type Email = {
  id: string; threadId?: string; sender: string; address: string; initials: string;
  subject: string; summary: string; body: string; time: string; category: 'work' | 'personal' | 'noise';
  priority: 'high' | 'normal'; needsReply: boolean; unread: boolean; color: string; label?: string;
  messageId?: string; unsubscribe?: string; oneClick?: boolean;
};
export const demoEmails: Email[] = [
  { id:'1', sender:'Sarah Chen', address:'sarah@studio.example', initials:'SC', subject:'Website launch — final approval', summary:'The launch is ready. Sarah needs your sign-off on the final designs by 2 PM.', body:'Hi Alex,\n\nThe final website designs are ready for your review. We’ve incorporated the feedback from yesterday, and the engineering team is all set.\n\nCould you give us your final approval by 2 PM so we can stay on track for Thursday’s launch?\n\nThanks!\nSarah', time:'9:42 AM', category:'work', priority:'high', needsReply:true, unread:true, color:'purple', label:'Due today' },
  { id:'2', sender:'James Miller', address:'james@studio.example', initials:'JM', subject:'Q3 budget review', summary:'The revised budget is ready. Two line items need your input before tomorrow’s review.', body:'Hi Alex,\n\nI’ve updated the Q3 budget with the latest forecasts. Could you review the contractor and software line items before our meeting tomorrow?\n\nLet me know if you need more context.\nJames', time:'9:18 AM', category:'work', priority:'high', needsReply:true, unread:true, color:'blue', label:'Needs your input' },
  { id:'3', sender:'Emily Park', address:'emily@partner.example', initials:'EP', subject:'A quick check-in before Thursday', summary:'Emily would like to confirm your availability for a 30-minute project check-in.', body:'Hey Alex,\n\nAre you available for a 30-minute project check-in on Thursday at 10 AM? We’ll go over the latest milestones and next steps.\n\nThanks,\nEmily', time:'8:56 AM', category:'work', priority:'normal', needsReply:true, unread:true, color:'rose', label:'Scheduling' },
  { id:'4', sender:'Daniel Kim', address:'daniel@studio.example', initials:'DK', subject:'Your weekly product update', summary:'Onboarding is shipped, the mobile refresh is in review, and all milestones are on track.', body:'Hi team,\n\nThis week: the new onboarding flow is live, our mobile refresh is in design review, and the roadmap is on track. No action needed — just keeping you in the loop.\n\nDaniel', time:'8:30 AM', category:'work', priority:'normal', needsReply:false, unread:false, color:'green', label:'FYI' },
  { id:'5', sender:'Notion', address:'team@notion.example', initials:'N', subject:'You were mentioned in Design team', summary:'Olivia mentioned you in the launch checklist. Take a look when you have a moment.', body:'Olivia mentioned you in the launch checklist:\n\n“Alex, could you take a look at the handoff notes when you get a chance?”', time:'8:12 AM', category:'work', priority:'normal', needsReply:false, unread:false, color:'gray', label:'Update' },
  { id:'6', sender:'Mia Thompson', address:'mia@personal.example', initials:'MT', subject:'Dinner this weekend?', summary:'Mia is planning dinner on Saturday and wants to know if you can make it.', body:'Hey!\n\nA few of us are grabbing dinner on Saturday around 7. Would love to see you there. Can you make it?\n\nMia', time:'Yesterday', category:'personal', priority:'normal', needsReply:true, unread:false, color:'amber', label:'Personal' },
  ...[
    ['7','The Daily Edit','DE','Your daily dose of inspiration','A roundup of design inspiration and this week’s stories.','purple'],
    ['8','The Daily Edit','DE','Five things worth a look','Five links from around the web.','purple'],
    ['9','Shop Supply','SS','A little something for your desk','New arrivals and a limited-time promotion.','rose'],
    ['10','Shop Supply','SS','Your weekend offer is here','This weekend’s sale and product picks.','rose'],
    ['11','Product Digest','PD','This week in product','A weekly collection of product launches.','blue'],
    ['12','Product Digest','PD','Meet your next favorite tool','The latest apps and tools from Product Digest.','blue'],
    ['13','Travel Notes','TN','Your next escape starts here','Travel ideas and special offers for the season.','green'],
    ['14','Travel Notes','TN','A change of scenery','Featured destinations and this month’s deals.','green'],
  ].map(([id,sender,initials,subject,summary,color])=>({id,sender,initials,subject,summary,color,address:sender.toLowerCase().replaceAll(' ','')+'@newsletter.example',body:summary,time:'Today',category:'noise' as const,priority:'normal' as const,needsReply:false,unread:false,oneClick:true}))
];
