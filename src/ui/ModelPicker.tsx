import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export type ModelChoice={providerKey:string;provider:string;id:string;name:string;efforts:string[];available:boolean;availabilityNote?:string};

const effortLabels:Record<string,string>={low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
export function effortLabel(effort:string){return effortLabels[effort]||effort;}

export function codexModelChoices(models:{id:string;displayName?:string;efforts:string[]}[]):ModelChoice[]{
  const supportedEfforts=new Set(['low','medium','high','xhigh','max','ultra']);
  return models.map(model=>{const efforts=model.efforts.filter(effort=>supportedEfforts.has(effort));return {providerKey:'codex',provider:'Codex · OpenAI',id:model.id,name:modelChoiceName(model.id,model.displayName),efforts,available:efforts.length>0,availabilityNote:efforts.length?undefined:'No supported reasoning effort is advertised by the runtime.'};});
}
type Props={label:string;providerKey:string;model:string;effort:string;choices:ModelChoice[];disabled:boolean;onChange:(choice:ModelChoice,effort:string)=>void};

export function modelChoiceName(id:string,displayName?:string){return id==='gpt-6-luna'?'GPT-6 Luna':(displayName||id).replace(/-(?=[A-Z])/g,' ');}

function preferredEffort(current:string,efforts:string[]){
  if(efforts.includes(current))return current;
  return ['max','high','medium','low'].find(effort=>efforts.includes(effort))||efforts[0]||current;
}

/**
 * Compact model trigger plus the provider-grouped chooser. Highlighting a model opens a
 * side panel with its reasoning levels so the model and effort are picked in one gesture.
 */
export default function ModelPicker({label,providerKey,model,effort,choices,disabled,onChange}:Props){
  const [open,setOpen]=useState(false),[mounted,setMounted]=useState(false),[query,setQuery]=useState(''),[openBelow,setOpenBelow]=useState(false),[highlighted,setHighlighted]=useState<string|null>(null);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const selected=choices.find(choice=>choice.providerKey===providerKey&&choice.id===model);
  const rows=choices.filter(choice=>`${choice.provider} ${choice.name} ${choice.id} ${choice.efforts.join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const groups=[...rows.reduce((result,choice)=>{const key=`${choice.providerKey}:${choice.provider}`;const group=result.get(key)||{key,provider:choice.provider,choices:[] as ModelChoice[]};group.choices.push(choice);result.set(key,group);return result;},new Map<string,{key:string;provider:string;choices:ModelChoice[]}>()).values()];
  const keyOf=(choice:ModelChoice)=>`${choice.providerKey}:${choice.id}`;
  const selectedKey=`${providerKey}:${model}`;
  const panelChoice=rows.find(choice=>keyOf(choice)===highlighted)||rows.find(choice=>keyOf(choice)===selectedKey)||rows[0];
  const panelIsSelected=!!panelChoice&&panelChoice.providerKey===providerKey&&panelChoice.id===model;
  const close=()=>{setOpen(false);setQuery('');setHighlighted(null);};
  useEffect(()=>{if(open)setMounted(true);else if(mounted){const timer=window.setTimeout(()=>setMounted(false),105);return()=>window.clearTimeout(timer);}},[open,mounted]);
  useLayoutEffect(()=>{
    const container=root.current;
    if(!container||!trigger.current)return;
    if(!open){if(!mounted){container.style.removeProperty('--model-menu-max-height');setOpenBelow(false);}return;}
    const menu=container.querySelector<HTMLElement>('.execution-model-menu');if(!menu)return;
    const position=()=>{
      const triggerBox=trigger.current?.getBoundingClientRect();if(!triggerBox)return;
      const menuHeight=menu.getBoundingClientRect().height,spaceAbove=triggerBox.top,spaceBelow=window.innerHeight-triggerBox.bottom;
      const below=spaceAbove<menuHeight+12&&spaceBelow>spaceAbove,availableSpace=(below?spaceBelow:spaceAbove)-12;
      container.style.setProperty('--model-menu-max-height',`${Math.max(120,Math.min(380,window.innerHeight*.6,availableSpace))}px`);
      setOpenBelow(below);
    };
    position();window.addEventListener('resize',position);return()=>window.removeEventListener('resize',position);
  },[open,rows.length,mounted]);
  useEffect(()=>{if(!open)return;const onPointer=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))close();};const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();trigger.current?.focus();}};document.addEventListener('pointerdown',onPointer);document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('pointerdown',onPointer);document.removeEventListener('keydown',onKey);};},[open]);
  const pick=(choice:ModelChoice)=>{if(!choice.available)return;onChange(choice,preferredEffort(effort,choice.efforts));close();trigger.current?.focus();};
  const pickEffort=(choice:ModelChoice,nextEffort:string)=>{if(!choice.available)return;onChange(choice,nextEffort);close();trigger.current?.focus();};
  const move=(event:React.KeyboardEvent<HTMLElement>)=>{
    if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
    const options=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.execution-model-option:not(:disabled)')||[]);
    if(!options.length)return;event.preventDefault();
    const index=options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length].focus();
  };
  return <div className="execution-model-popover" ref={root} data-open-below={openBelow}>
    <button ref={trigger} type="button" className="choice-trigger execution-model-trigger" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={()=>{setMounted(true);setOpen(value=>!value);}}>
      <span className="execution-model-trigger-name">{selected?.name||`${model} · unavailable`}</span>
      {selected&&<span className="execution-model-trigger-effort">{effortLabel(effort)}</span>}
      <ChevronDown size={12} aria-hidden="true"/>
    </button>
    {mounted&&<div className="execution-model-menu" data-open={open} role="dialog" aria-label={label} inert={!open} onKeyDown={move}>
      <div className="execution-model-search-row"><label className="execution-model-search"><Search size={13} aria-hidden="true"/><input autoFocus={open} value={query} onChange={event=>setQuery(event.currentTarget.value)} placeholder="Search models" aria-label={`Search ${label.toLocaleLowerCase()}`}/></label></div>
      <div className="execution-model-body">
        <div className="execution-model-list" role="listbox" aria-label={`Available ${label.toLocaleLowerCase()} choices`}>
          {groups.map(group=><div className="execution-model-group" role="group" aria-label={group.provider} key={group.key}>
            <span className="execution-model-provider">{group.provider}</span>
            {group.choices.map(choice=>{const active=providerKey===choice.providerKey&&model===choice.id;return <button type="button" role="option" aria-selected={active} disabled={!choice.available} key={`${choice.providerKey}:${choice.id}`} className={`execution-model-option ${active?'selected':''}`} data-panel={panelChoice&&keyOf(panelChoice)===keyOf(choice)} onMouseEnter={()=>setHighlighted(keyOf(choice))} onFocus={()=>setHighlighted(keyOf(choice))} onClick={()=>pick(choice)}>
              <span className="execution-model-name">{choice.name}{!choice.available&&<span className="execution-model-badge">Unavailable</span>}</span>
              <span className="execution-model-effort">{active?effortLabel(effort):''}</span>
              <span className="execution-model-check">{active&&<Check size={13} aria-hidden="true"/>}</span>
            </button>;})}
          </div>)}
          {!rows.length&&<div className="execution-model-empty">No matching models.</div>}
        </div>
        {panelChoice&&<div className="execution-model-efforts" role="radiogroup" aria-label={`Reasoning effort for ${panelChoice.name}`}>
          <span className="execution-model-efforts-title">Reasoning<span className="execution-model-efforts-model">{panelChoice.name}</span></span>
          {panelChoice.efforts.map(level=><button type="button" role="radio" aria-checked={panelIsSelected&&level===effort} key={level} className="execution-model-effort-option" onClick={()=>pickEffort(panelChoice,level)}>
            <span>{effortLabel(level)}</span>
            {panelIsSelected&&level===effort&&<Check size={13} aria-hidden="true"/>}
          </button>)}
          {!panelChoice.efforts.length&&<p className="execution-model-efforts-empty">{panelChoice.availabilityNote||'No reasoning levels are reported for this model.'}</p>}
          {panelChoice.efforts.length>0&&<p className="execution-model-efforts-note">{panelChoice.availabilityNote||`${panelChoice.provider} · ${panelChoice.efforts.length} reasoning ${panelChoice.efforts.length===1?'level':'levels'}`}</p>}
        </div>}
      </div>
    </div>}
  </div>;
}
