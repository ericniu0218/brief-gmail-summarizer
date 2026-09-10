import { demoEmails, type Email } from './mail';

export function reconcileInbox<T extends {accountId:string}>(status:{connected:boolean;accounts:{id:string}[];defaultAccountId:string|null},emails:Email[],snapshots:T[],selected?:string|null){
  const ids=new Set(status.accounts.map(account=>account.id));
  const activeAccountId=selected==='all'&&status.connected?'all':selected&&ids.has(selected)?selected:status.defaultAccountId;
  return {
    emails:status.connected?emails.filter(email=>!!email.accountId&&ids.has(email.accountId)):demoEmails,
    snapshots:status.connected?snapshots.filter(snapshot=>ids.has(snapshot.accountId)):[],
    activeAccountId,
  };
}
