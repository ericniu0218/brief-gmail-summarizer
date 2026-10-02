'use client';
import { useId, useState } from 'react';
export type Contact={name:string;address:string};
// A text box for comma-separated addresses that suggests people from the inbox for the address being typed.
export function RecipientField({label,value,onChange,contacts,placeholder}:{label:string;value:string;onChange:(value:string)=>void;contacts:Contact[];placeholder?:string}){
  const id=useId();
  const [focused,setFocused]=useState(false);
  const partial=value.match(/[^\s,;]*$/)![0];
  const already=new Set(value.split(/[\s,;]+/).filter(Boolean).map(s=>s.toLowerCase()));
  const needle=partial.toLowerCase();
  const matches=needle?contacts.filter(c=>!already.has(c.address.toLowerCase())&&(c.address.toLowerCase().includes(needle)||c.name.toLowerCase().includes(needle))).slice(0,5):[];
  function pick(contact:Contact){onChange(value.slice(0,value.length-partial.length)+contact.address+', ');}
  return <div className="recipient-field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="text" inputMode="email" autoComplete="off" placeholder={placeholder} value={value} onChange={event=>onChange(event.target.value)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}/>
    {focused&&matches.length>0&&<ul className="recipient-suggestions">{matches.map(contact=><li key={contact.address}><button type="button" onMouseDown={event=>event.preventDefault()} onClick={()=>pick(contact)}><strong>{contact.name}</strong><span>{contact.address}</span></button></li>)}</ul>}
  </div>;
}
