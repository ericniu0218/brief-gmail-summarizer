'use client';
import { Check, ChevronDown, Inbox, Mail, Plus, Settings2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { GmailAccount } from '@/hooks/use-inbox';

/** Account picker that keeps mailbox switching and connection management in one menu. */
export function AccountSwitcher({accounts,activeAccountId,defaultAccountId,onSelect,onSettings}:{accounts:GmailAccount[];activeAccountId?:string|null;defaultAccountId?:string|null;onSelect:(id:string)=>void;onSettings:()=>void}) {
  const active=accounts.find(a=>a.id===activeAccountId);
  return <DropdownMenu>
    <DropdownMenuTrigger className="connect-button account-switcher" aria-label="Switch Gmail account"><Mail size={15}/><span>{activeAccountId==='all'?'All inboxes':active?.email||'Gmail accounts'}</span><ChevronDown size={14}/></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="account-menu">
      <DropdownMenuItem onClick={()=>onSelect('all')}><Inbox size={16}/><span>All inboxes<small>Overview of every connected account</small></span>{activeAccountId==='all'&&<Check size={14}/>}</DropdownMenuItem>
      <DropdownMenuSeparator/>
      {accounts.map(account=><DropdownMenuItem key={account.id} onClick={()=>onSelect(account.id)}><Mail size={16}/><span>{account.email}<small>{account.reconnectRequired?'Needs reconnection':account.error?'Refresh needed':account.id===defaultAccountId?'Default account':'Connected'}</small></span>{account.id===activeAccountId&&<Check size={14}/>}</DropdownMenuItem>)}
      {accounts.length>0&&<DropdownMenuSeparator/>}
      <DropdownMenuItem onClick={onSettings}><Plus size={16}/>Add Gmail account</DropdownMenuItem>
      <DropdownMenuItem onClick={onSettings}><Settings2 size={16}/>Account settings</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
