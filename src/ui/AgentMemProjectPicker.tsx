import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Database, Search } from 'lucide-react';

export type AgentMemProjectOption={id:string;name:string;sourceRoot:string;memoryDirectory:string;description?:string};
type Props={value:string;projects:AgentMemProjectOption[];loading:boolean;error:string;disabled?:boolean;onChange:(project:AgentMemProjectOption|null)=>void;onRetry:()=>void};

export function AgentMemProjectPicker({value,projects,loading,error,disabled=false,onChange,onRetry}:Props){
  const [open,setOpen]=useState(false);const [query,setQuery]=useState('');const [activeIndex,setActiveIndex]=useState(0);
  const root=useRef<HTMLDivElement>(null);const trigger=useRef<HTMLButtonElement>(null);const search=useRef<HTMLInputElement>(null);const optionRefs=useRef<(HTMLButtonElement|null)[]>([]);
  const selected=projects.find(project=>project.id===value);
  const filtered=useMemo(()=>{const needle=query.trim().toLocaleLowerCase();return projects.filter(project=>!needle||`${project.name} ${project.id} ${project.memoryDirectory}`.toLocaleLowerCase().includes(needle)).slice(0,100);},[projects,query]);
  const options:[AgentMemProjectOption|null,...AgentMemProjectOption[]]=[null,...filtered];
  const selectedLabel=value?(selected?.name||`${value} · unavailable`):'Disabled';
  const close=(restore=true)=>{setOpen(false);setQuery('');if(restore)requestAnimationFrame(()=>trigger.current?.focus());};
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(root.current&&!root.current.contains(event.target as Node))close(false);};const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close();}};document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);requestAnimationFrame(()=>search.current?.focus());return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};},[open]);
  useEffect(()=>{setActiveIndex(Math.max(0,options.findIndex(option=>option?.id===value)));},[value,filtered.length]);
  const choose=(project:AgentMemProjectOption|null)=>{onChange(project);close();};
  const onKeyDown=(event:ReactKeyboardEvent<HTMLElement>)=>{
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();const next=(activeIndex+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;setActiveIndex(next);optionRefs.current[next]?.focus();
    }else if(event.key==='Home'||event.key==='End'){
      event.preventDefault();const next=event.key==='Home'?0:options.length-1;setActiveIndex(next);optionRefs.current[next]?.focus();
    }else if(event.key==='Enter'){
      const option=options[activeIndex];choose(option);
    }
  };
  return <div className="agentmem-project-picker" ref={root}>
    <span className="agentmem-picker-caption">Knowledge base</span>
    <button ref={trigger} type="button" className="agentmem-picker-trigger" aria-label="AgentMem knowledge base" aria-haspopup="listbox" aria-expanded={open} aria-controls="agentmem-project-options" disabled={disabled} onClick={()=>setOpen(current=>!current)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setOpen(true);}}}>
      <Database size={15}/><span>{selectedLabel}</span><ChevronDown size={14}/>
    </button>
    {open&&<div className="agentmem-picker-menu" onKeyDown={onKeyDown}>
      <div className="agentmem-search"><Search size={14} aria-hidden="true"/><input ref={search} type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search projects" aria-label="Search AgentMem projects"/><kbd>Esc</kbd></div>
      <div className="agentmem-project-options" role="listbox" id="agentmem-project-options" aria-label="AgentMem projects directory" aria-busy={loading}>
        <button ref={element=>{optionRefs.current[0]=element;}} type="button" role="option" aria-selected={!value} className="agentmem-project-option is-disabled-choice" onClick={()=>choose(null)}>
          <span className="agentmem-option-main"><strong>Disabled</strong><small>No project memory for new tasks</small></span>{!value&&<Check size={15}/>}
        </button>
        {filtered.map((project,index)=><button ref={element=>{optionRefs.current[index+1]=element;}} key={project.id} type="button" role="option" aria-selected={project.id===value} className="agentmem-project-option" onClick={()=>choose(project)} title={project.description}>
          <span className="agentmem-option-main"><strong>{project.name}</strong><small>Projects · {project.memoryDirectory}</small></span>{project.id===value&&<Check size={15}/>}
        </button>)}
        {!loading&&!error&&filtered.length===0&&<div className="agentmem-picker-empty">{query?'No matching projects.':'No registered knowledge bases in the projects directory.'}</div>}
        {filtered.length===100&&<div className="agentmem-picker-empty">Showing the first 100 results. Refine your search.</div>}
      </div>
      <div className="agentmem-picker-footer" aria-live="polite">{loading?'Loading registered projects…':error?<><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></>:`${projects.length} ${projects.length===1?'project':'projects'}`}</div>
    </div>}
  </div>;
}
