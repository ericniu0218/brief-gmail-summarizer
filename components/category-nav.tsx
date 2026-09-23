'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, Sparkles, BriefcaseBusiness, UserRound, Layers3 } from 'lucide-react';
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from '@/components/ui/sidebar';
import { SECTIONS, sectionCount, tagCount, toggleExpanded, type Section } from '@/lib/categories';
import type { Email } from '@/lib/mail';

const SECTION_ICONS:Record<Section,typeof Inbox>={work:BriefcaseBusiness,personal:UserRound,noise:Layers3};

export function CategoryNav({emails,view,onSelect}:{emails:Email[];view:string;onSelect:(view:string)=>void}){
  // Each section tracks its own disclosure state, so expanding one never collapses
  // or expands another, and navigation never changes it.
  const [expanded,setExpanded]=useState<Section[]>([]);
  const toggle=(section:Section)=>setExpanded(current=>toggleExpanded(current,section));

  return <SidebarMenu className="main-navigation">
    <SidebarMenuItem>
      <div className="nav-row">
        <SidebarMenuButton isActive={view==='overview'} onClick={()=>onSelect('overview')} className="nav-button"><Sparkles size={18}/><span>Overview</span></SidebarMenuButton>
      </div>
    </SidebarMenuItem>
    <SidebarMenuItem>
      <div className="nav-row">
        <SidebarMenuButton isActive={view==='inbox'} onClick={()=>onSelect('inbox')} className="nav-button"><Inbox size={18}/><span>Inbox</span><span className="nav-count">{emails.length}</span></SidebarMenuButton>
      </div>
    </SidebarMenuItem>
    {SECTIONS.map(section=>{
      const Icon=SECTION_ICONS[section.id];
      const open=expanded.includes(section.id);
      const submenuId=`nav-submenu-${section.id}`;
      const hasSubmenu=section.tags.length>0;
      return <SidebarMenuItem key={section.id}>
        <div className="nav-row">
          <SidebarMenuButton isActive={view===section.id} onClick={()=>onSelect(section.id)} className="nav-button">
            <Icon size={18}/><span>{section.name}</span><span className="nav-count">{sectionCount(emails,section.id)}</span>
          </SidebarMenuButton>
          {hasSubmenu&&<button
            type="button"
            className="nav-arrow"
            aria-expanded={open}
            aria-controls={submenuId}
            aria-label={`${open?'Collapse':'Expand'} ${section.name} subcategories`}
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
      </SidebarMenuItem>;
    })}
  </SidebarMenu>;
}
