import { activeJunkPreference, automaticBaseline, composeClassification, loadOverrides, loadSenderRules, manualCorrectionView, senderRuleFor, withSenderRule } from './overrides';
import { parseSnapshot } from './snapshots';
import { loadMessages } from './messages';
import { ALL_INBOXES, getOwnedConnection, ownedConnections } from './gmail';
import type { Runtime } from './runtime';
import type { StoredEmail } from './sync';
import { receivedAtOf } from '@/lib/importance';

/**
 * Builds the mail view for one mailbox, or the combined view across every connected
 * mailbox, from account-scoped snapshots.
 *
 * Each message keeps the account it came from, and per-account state is reported rather
 * than flattened: a mailbox that has never synced or is currently failing is listed, so
 * the combined view is never described as fully loaded when part of it is missing.
 */
export async function readMailbox(user:string,requested:string,e:Runtime){
  const connections=requested===ALL_INBOXES
    ? await ownedConnections(user,e)
    : [await getOwnedConnection(user,requested,e)];
  if(!connections.length)return {emails:[],accounts:[],ai:false,updated:null,pending:0,skipped:0,hasMore:false};

  const now=Date.now();
  const emails:StoredEmail[]=[];
  const accounts=[];
  let pending=0,skipped=0,hasMore=false,updated:number|null=null,ai=true;
  for(const c of connections){
    const stored=await e.DB.prepare('SELECT data FROM snapshots WHERE account_id = ? AND user_id = ?').bind(c.id,user).first<{data:string}>();
    const snapshot=stored?parseSnapshot(stored.data):undefined;
    // Independently stored messages remain usable if the small summary snapshot is lost.
    const rows=await loadMessages(user,c.id,e);
    accounts.push({id:c.id,email:c.email,lastSync:c.last_sync,error:c.error||(stored&&!snapshot?'Cached mailbox summary is damaged. Refresh Gmail to repair it.':null),loaded:!!snapshot||rows.length>0,
      pending:snapshot?.pending||0,skipped:snapshot?.skipped||0,hasMore:!!snapshot?.hasMore});
    if(!snapshot&&!rows.length){ai=false;continue;}
    // New databases store one row per email. A legacy snapshot remains a read-only
    // fallback until its first sync imports those records.
    const accountEmails=rows.length?rows:(snapshot?.emails||[]).filter((email):email is StoredEmail=>!!email&&typeof email==='object'&&typeof email.id==='string');
    const overrides=await loadOverrides(user,c.id,e,accountEmails.map(email=>email.id));
    const senderRules=await loadSenderRules(user,c.id,e);
    for(const email of accountEmails){
      const source={...email,accountId:c.id,accountEmail:c.email};
      if(!email.classification&&!email.automaticClassification){emails.push(source);continue;}
      const automatic=automaticBaseline(email.automaticClassification)??automaticBaseline(email.classification);
      const manual=overrides.get(email.id),senderRule=senderRuleFor(senderRules,email.address);
      const effective=withSenderRule(manual,senderRule,email.id);
      // A legacy corrected snapshot has no recoverable automatic baseline. Keep its last
      // visible result until sync reclassifies it, and tell reset that recovery is needed.
      if(!automatic){emails.push({...source,correctionRevision:manual?.revision??0,
        manuallyCorrected:manual?.active!==false&&!!manual,manualCorrection:manualCorrectionView(manual),
        automaticClassificationAvailable:false});continue;}
      const {classification,category,tags,priority,label}=composeClassification(automatic,effective,now);
      emails.push({...source,automaticClassification:automatic,classification,category,tags,priority,label,
        correctionRevision:manual?.revision??0,manuallyCorrected:manual?.active!==false&&!!manual,
        manualCorrection:manualCorrectionView(manual),
        senderJunkPreference:activeJunkPreference(senderRule),senderRuleRevision:senderRule?.revision??0,
        automaticClassificationAvailable:true});
    }
    pending+=snapshot?.pending||0;skipped+=snapshot?.skipped||0;
    hasMore=hasMore||!!snapshot?.hasMore;ai=ai&&!!snapshot?.ai;
    if(snapshot)updated=updated===null?snapshot.updated:Math.min(updated,snapshot.updated);
  }
  // Stable order: newest first, with the composite identity breaking ties so the list
  // never reshuffles between renders when two messages share a timestamp.
  emails.sort((a,b)=>{
    const aAt=receivedAtOf(a,now)??-Infinity,bAt=receivedAtOf(b,now)??-Infinity;
    if(aAt!==bAt)return bAt-aAt;
    return `${a.accountId}:${a.id}`.localeCompare(`${b.accountId}:${b.id}`);
  });
  return {emails,accounts,ai,updated,pending,skipped,hasMore};
}
