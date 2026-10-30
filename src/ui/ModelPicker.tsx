import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export type ModelChoice={providerKey:string;provider:string;id:string;name:string;efforts:string[];available:boolean;availabilityNote?:string};
type Props={label:string;providerKey:string;model:string;effort:string;choices:ModelChoice[];disabled:boolean;onChange:(choice:ModelChoice,effort:string)=>void};

function preferredEffort(current:string,efforts:string[]){
  if(efforts.includes(current))return current;
  return ['max','high','medium','low'].find(effort=>efforts.includes(effort))||efforts[0]||current;
}

export default function ModelPicker({label,providerKey,model,effort,choices,disabled,onChange}:Props){
  const [open,setOpen]=useState(false),[mounted,setMounted]=useState(false),[query,setQuery]=useState('');
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const selected=choices.find(choice=>choice.providerKey===providerKey&&choice.id===model);
  const rows=choices.filter(choice=>`${choice.provider} ${choice.name} ${choice.id} ${choice.efforts.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups=[...rows.reduce((result,choice)=>{const key=`${choice.providerKey}:${choice.provider}`;const group=result.get(key)||{key,provider:choice.provider,choices:[] as ModelChoice[]};group.choices.push(choice);result.set(key,group);return result;},new Map<string,{key:string;provider:string;choices:ModelChoice[]}>()).values()];
  const close=()=>{setOpen(false);setQuery('');};
  useEffect(()=>{if(open)setMounted(true);else if(mounted){const timer=window.setTimeout(()=>setMounted(false),105);return()=>window.clearTimeout(timer);}},[open,mounted]);
  useEffect(()=>{if(!open)return;const onPointer=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))close();};const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();trigger.current?.focus();}};document.addEventListener('pointerdown',onPointer);document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('pointerdown',onPointer);document.removeEventListener('keydown',onKey);};},[open]);
  const pick=(choice:ModelChoice)=>{if(!choice.available)return;onChange(choice,preferredEffort(effort,choice.efforts));close();trigger.current?.focus();};
  return <div className="execution-model-popover" ref={root}>
    <button ref={trigger} type="button" className="choice-trigger execution-model-trigger" aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={()=>{setMounted(true);setOpen(value=>!value);}}>{selected?.name||`${model} · unavailable`}<ChevronDown size={13}/></button>
    {mounted&&<div className="execution-model-menu" data-open={open} role="dialog" aria-label={label} inert={!open}>
      <label className="execution-model-search"><Search size={13}/><input autoFocus={open} value={query} onChange={event=>setQuery(event.currentTarget.value)} placeholder="Search models" aria-label={`Search ${label.toLocaleLowerCase()}`}/></label>
      <div role="listbox" aria-label={`Available ${label.toLocaleLowerCase()} choices`}>
        {groups.map(group=><div className="execution-model-group" role="group" aria-label={group.provider} key={group.key}>
          <span className="execution-model-provider">{group.provider}</span>
          {group.choices.map(choice=><button type="button" role="option" aria-selected={providerKey===choice.providerKey&&model===choice.id} disabled={!choice.available} key={`${choice.providerKey}:${choice.id}`} onClick={()=>pick(choice)}>
            <span className="execution-model-check">{providerKey===choice.providerKey&&model===choice.id&&<Check size={14}/>}</span>
            <span className="execution-model-copy"><strong>{choice.name}{!choice.available?' · unavailable':''}</strong><small>{choice.availabilityNote||`Reasoning effort: ${choice.efforts.join(', ')||'not reported'}`}</small></span>
            <span className="execution-model-effort">{providerKey===choice.providerKey&&model===choice.id?effort:''}</span>
          </button>)}
        </div>)}
        {!rows.length&&<div className="execution-model-empty">No matching models.</div>}
      </div>
    </div>}
  </div>;
}
