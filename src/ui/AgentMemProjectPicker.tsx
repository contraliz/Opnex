import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Database, Search } from 'lucide-react';

export type AgentMemProjectOption = { id:string; name:string; sourceRoot:string; description?:string };
type Props={value:string;projects:AgentMemProjectOption[];loading:boolean;error:string;projectRoot:string;disabled?:boolean;onChange:(id:string)=>void;onRetry:()=>void};

function normalizedPath(value:string){const normalized=value.replaceAll('\\','/').replace(/\/+$/,'');return /^[a-z]:\//i.test(normalized)||normalized.startsWith('//')?normalized.toLocaleLowerCase():normalized;}

export function AgentMemProjectPicker({value,projects,loading,error,projectRoot,disabled=false,onChange,onRetry}:Props){
  const [open,setOpen]=useState(false);const [query,setQuery]=useState('');const [activeIndex,setActiveIndex]=useState(0);
  const root=useRef<HTMLDivElement>(null);const trigger=useRef<HTMLButtonElement>(null);const search=useRef<HTMLInputElement>(null);const optionRefs=useRef<(HTMLButtonElement|null)[]>([]);
  const selected=projects.find(project=>project.id===value);
  const filtered=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase();
    return projects.filter(project=>!needle||`${project.name} ${project.id} ${project.sourceRoot}`.toLocaleLowerCase().includes(needle)).slice(0,100);
  },[projects,query]);
  const options=[{id:'',name:'Disabled',sourceRoot:'',description:'No AgentMem retrieval or work records for new tasks.'},...filtered];
  const selectedLabel=value?(selected?.name||`${value} · unavailable`):'Disabled';
  const matchesRoot=(project:AgentMemProjectOption)=>!!project.sourceRoot&&!!projectRoot&&normalizedPath(project.sourceRoot)===normalizedPath(projectRoot);
  const close=(restore=true)=>{setOpen(false);setQuery('');if(restore)requestAnimationFrame(()=>trigger.current?.focus());};
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))close(false);};const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);requestAnimationFrame(()=>search.current?.focus());return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open]);
  useEffect(()=>{setActiveIndex(Math.max(0,options.findIndex(option=>option.id===value)));},[value,filtered.length]);
  const choose=(id:string)=>{onChange(id);close();};
  const onKeyDown=(event:ReactKeyboardEvent<HTMLElement>)=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const next=(activeIndex+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;setActiveIndex(next);optionRefs.current[next]?.focus();
    }else if(event.key==='Home'||event.key==='End'){
      event.preventDefault();const next=event.key==='Home'?0:options.length-1;setActiveIndex(next);optionRefs.current[next]?.focus();
    }else if(event.key==='Enter'){
      const option=options[activeIndex];if(option&&!option.id)choose('');else if(option&&matchesRoot(option as AgentMemProjectOption))choose(option.id);
    }
  };
  return <div className="agentmem-project-picker" ref={root}>
    <span className="agentmem-picker-caption">Knowledge base</span>
    <button ref={trigger} type="button" className="agentmem-picker-trigger" aria-label="AgentMem knowledge base" aria-haspopup="listbox" aria-expanded={open} aria-controls="agentmem-project-options" disabled={disabled} onClick={()=>setOpen(value=>!value)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);}}}>
      <Database size={15}/><span>{selectedLabel}</span><ChevronDown size={14}/>
    </button>
    {open&&<div className="agentmem-picker-menu" onKeyDown={onKeyDown}>
      <label className="agentmem-search"><Search size={14}/><input ref={search} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search knowledge bases" aria-label="Search knowledge bases"/><kbd>Esc</kbd></label>
      <div className="agentmem-project-options" role="listbox" id="agentmem-project-options" aria-label="Available AgentMem knowledge bases" aria-busy={loading}>
        <button ref={element=>{optionRefs.current[0]=element;}} type="button" role="option" aria-selected={!value} className="agentmem-project-option" onClick={()=>choose('')}>
          <span className="agentmem-option-main"><strong>Disabled</strong><small>No AgentMem for new tasks</small></span>{!value&&<Check size={15}/>}
        </button>
        {filtered.map((project,index)=>{const matches=matchesRoot(project);return <button ref={element=>{optionRefs.current[index+1]=element;}} key={project.id} type="button" role="option" aria-selected={project.id===value} aria-disabled={!matches} disabled={!matches} className="agentmem-project-option" onClick={()=>choose(project.id)} title={!matches?`Select the matching project root first: ${project.sourceRoot||'source root unavailable'}`:project.description}>
          <span className="agentmem-option-main"><strong>{project.name}</strong><small>{project.id} · {project.sourceRoot||'source root unavailable'}</small></span>{project.id===value&&<Check size={15}/>} {!matches&&<span className="agentmem-root-mismatch">Different root</span>}
        </button>;})}
        {!loading&&!error&&filtered.length===0&&<div className="agentmem-picker-empty">{query?'No matching knowledge bases.':'No registered knowledge bases found.'}</div>}
        {filtered.length===100&&<div className="agentmem-picker-empty">Showing the first 100 results. Refine your search.</div>}
      </div>
      <div className="agentmem-picker-footer" aria-live="polite">{loading?'Loading registered knowledge bases…':error?<><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></>:`${projects.length} registered ${projects.length===1?'knowledge base':'knowledge bases'}`}</div>
    </div>}
  </div>;
}
