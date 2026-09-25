'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, Mails, Sparkles, BriefcaseBusiness, UserRound, Layers3 } from 'lucide-react';
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton, useSidebar } from '@/components/ui/sidebar';
import { SECTIONS, parseView, sectionCount, tagCount, toggleExpanded, type Section } from '@/lib/categories';
import type { Email } from '@/lib/mail';

const SECTION_ICONS:Record<Section,typeof Inbox>={work:BriefcaseBusiness,personal:UserRound,noise:Layers3};

/**
 * Sidebar navigation. Work, Personal and Noise are grouped inside Inbox so the sidebar
 * rests at four rows; each still opens its own subcategories from its own arrow.
 *
 * Clicking a row opens its view. The arrow beside it only shows or hides what is nested
 * underneath, so navigating and browsing the menu stay separate actions.
 *
 * Account scope and category selection are deliberately separate concerns: `allInboxes`
 * describes which mailboxes are in scope, while `view` describes which messages within
 * that scope are listed. Choosing a category therefore never changes the scope.
 */
export function CategoryNav({emails,view,allInboxes,onSelect,onSelectAllInboxes}:{emails:Email[];view:string;allInboxes:boolean;onSelect:(view:string)=>void;onSelectAllInboxes:()=>void}){
  // Each section tracks its own disclosure state, so expanding one never collapses
  // or expands another.
  const [expanded,setExpanded]=useState<Section[]>(()=>{
    const {section,tag}=parseView(view);
    return section&&tag?[section]:[];
  });
  const [sectionsOpen,setSectionsOpen]=useState(()=>!!parseView(view).section);
  const [lastView,setLastView]=useState(view);
  // A view can be chosen from outside this menu: a selection restored on load, or the
  // "Review & unsubscribe" link on the page. Reveal where it landed, otherwise the newly
  // highlighted row would be hidden inside a collapsed group and nothing would appear
  // selected at all. Adjusting during render keeps this in the same pass as the new view.
  // Choosing a section still never opens that section's own subcategories.
  if(lastView!==view){
    setLastView(view);
    const {section,tag}=parseView(view);
    if(section){
      setSectionsOpen(true);
      if(tag)setExpanded(current=>current.includes(section)?current:[...current,section]);
    }
  }
  const toggle=(section:Section)=>setExpanded(current=>toggleExpanded(current,section));
  const {isMobile,setOpenMobile}=useSidebar();
  // Exactly one row is highlighted: the combined scope claims the active Inbox state so
  // "All inboxes" and a single account's "Inbox" can never both appear selected.
  const combinedInbox=allInboxes&&view==='inbox';
  const active=parseView(view);
  // Keep the active path visible. Its disclosure is disabled while locked open so the
  // control never promises a collapse that cannot happen.
  const sectionsVisible=sectionsOpen||!!active.section;
  const activeSectionName=SECTIONS.find(section=>section.id===active.section)?.name;
  const sectionsLocked=!!active.section;

  return <SidebarMenu className="main-navigation">
    <SidebarMenuItem>
      <div className="nav-row">
        <SidebarMenuButton isActive={view==='overview'} onClick={()=>onSelect('overview')} className="nav-button"><Sparkles size={18}/><span>Overview</span></SidebarMenuButton>
      </div>
    </SidebarMenuItem>
    <SidebarMenuItem>
      <div className="nav-row">
        {/* On a phone the drawer covers the mail it just selected, so this closes it. */}
        <SidebarMenuButton isActive={combinedInbox} onClick={()=>{onSelectAllInboxes();if(isMobile)setOpenMobile(false);}} className="nav-button">
          <Mails size={18}/><span>All inboxes</span>
          {/* The count is shown only while the combined scope is loaded; a single-account
              snapshot cannot report a total across mailboxes it has not read. */}
          {allInboxes&&<span className="nav-count">{emails.length}</span>}
        </SidebarMenuButton>
      </div>
    </SidebarMenuItem>
    <SidebarMenuItem>
      <div className="nav-row">
        <SidebarMenuButton isActive={view==='inbox'&&!allInboxes} onClick={()=>onSelect('inbox')} className="nav-button"><Inbox size={18}/><span>Inbox</span><span className="nav-count">{emails.length}</span></SidebarMenuButton>
        <button
          type="button"
          className="nav-arrow"
          disabled={sectionsLocked}
          aria-expanded={sectionsVisible}
          aria-controls="nav-submenu-sections"
          aria-label={sectionsLocked?`Inbox sections stay open while ${activeSectionName} is selected`:`${sectionsVisible?'Collapse':'Expand'} inbox sections`}
          title={sectionsLocked?`Inbox sections stay open while ${activeSectionName} is selected`:undefined}
          onClick={()=>setSectionsOpen(open=>!open)}
        >{sectionsVisible?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>
      </div>
      <ul id="nav-submenu-sections" className="nav-submenu nav-sections" hidden={!sectionsVisible}>
        {SECTIONS.map(section=>{
          // Counts are derived from the current inbox on every render, so parent and child
          // totals update immediately after a classification changes.
          const Icon=SECTION_ICONS[section.id];
          const open=expanded.includes(section.id)||(active.section===section.id&&!!active.tag);
          const locked=active.section===section.id&&!!active.tag;
          const activeTagName=locked?section.tags.find(tag=>tag.id===active.tag)?.name:undefined;
          const submenuId=`nav-submenu-${section.id}`;
          const hasSubmenu=section.tags.length>0;
          return <li key={section.id}>
            <div className="nav-row">
              <SidebarMenuButton isActive={view===section.id} onClick={()=>onSelect(section.id)} className="nav-button">
                <Icon size={18}/><span>{section.name}</span><span className="nav-count">{sectionCount(emails,section.id)}</span>
              </SidebarMenuButton>
              {hasSubmenu&&<button
                type="button"
                className="nav-arrow"
                disabled={locked}
                aria-expanded={open}
                aria-controls={submenuId}
                aria-label={locked?`${section.name} subcategories stay open while ${activeTagName} is selected`:`${open?'Collapse':'Expand'} ${section.name} subcategories`}
                title={locked?`${section.name} subcategories stay open while ${activeTagName} is selected`:undefined}
                onClick={()=>toggle(section.id)}
              >{open?<ChevronDown size={14}/>:<ChevronRight size={14}/>}</button>}
            </div>
            {hasSubmenu&&<ul id={submenuId} className="nav-submenu" hidden={!open}>
              {section.tags.map(tag=>{
                const id=`${section.id}:${tag.id}`;
                return <li key={tag.id}>
                  <button type="button" className="nav-subitem" data-active={view===id||undefined} aria-current={view===id?'page':undefined} onClick={()=>onSelect(id)}>
                    <span>{tag.name}</span><span className="nav-count">{tagCount(emails,section.id,tag.id)}</span>
                  </button>
                </li>;
              })}
            </ul>}
          </li>;
        })}
      </ul>
    </SidebarMenuItem>
  </SidebarMenu>;
}
