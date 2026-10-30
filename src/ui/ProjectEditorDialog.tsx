import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from './api';
import { DirectoryPicker } from './DirectoryPicker';
import type { Project } from '../types';

type Props={project:Project|'new'|null;initialRoot:string;close:()=>void;saved:(project:Project,duplicate:boolean)=>void};

export function ProjectEditorDialog({project,initialRoot,close,saved}:Props){
  const [name,setName]=useState(''),[root,setRoot]=useState(''),[pinned,setPinned]=useState(false),[saving,setSaving]=useState(false),[pickerOpen,setPickerOpen]=useState(false),[pickerBusy,setPickerBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLFormElement>(null),nameInput=useRef<HTMLInputElement>(null),browseButton=useRef<HTMLButtonElement>(null),restoreFocus=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{restoreFocus.current=document.activeElement as HTMLElement|null;nameInput.current?.focus();return()=>{restoreFocus.current?.focus();restoreFocus.current=null;};},[]);
  const isNew=project==='new';
  useEffect(()=>{if(!project)return;setName(isNew?'':project.name);setRoot(isNew?initialRoot:project.projectRoot);setPinned(!isNew&&project.pinned);setError('');},[isNew,project==='new'?'':project?.id,project==='new'?'':project?.projectRoot,initialRoot]);
  const saveProject=async(event:React.FormEvent)=>{event.preventDefault();if(!project||saving)return;setSaving(true);setError('');try{const result=await api<{project:Project;duplicate:boolean}>('/api/projects',{id:isNew?crypto.randomUUID():project.id,name,projectRoot:root,pinned});saved(result.project,result.duplicate);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}};
  if(!project)return null;
  const trapDialogTab=(event:ReactKeyboardEvent<HTMLFormElement>)=>{if(event.key==='Escape'&&!saving&&!pickerBusy&&!pickerOpen){event.preventDefault();close();return;}if(event.key!=='Tab'||pickerOpen)return;const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')||[]).filter(item=>!item.closest('[hidden],[inert],[aria-hidden="true"]'));const first=items[0],last=items[items.length-1];if(!first){event.preventDefault();nameInput.current?.focus();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
  return <div className="dialog-backdrop" data-open="true" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&!saving&&!pickerBusy&&close()}><form ref={dialog} className="project-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="project-editor-title" onSubmit={saveProject} onKeyDown={trapDialogTab}>
    <header><div><h2 id="project-editor-title">{isNew?'Create project':`Configure ${project.name}`}</h2><p>A project owns its working directory and sessions.</p></div><button type="button" className="icon-btn" aria-label="Close project settings" onClick={close} disabled={saving}>×</button></header>
    <label>Project name<input ref={nameInput} value={name} maxLength={80} onChange={event=>setName(event.target.value)} required/></label>
    <label>Working directory<div className="project-root-control"><input value={root} maxLength={1024} placeholder="Choose an existing folder" readOnly aria-readonly="true" aria-label="Working directory" title={root||undefined} spellCheck={false} required/><button ref={browseButton} type="button" className="project-root-browse" aria-label="Browse working directory folders" aria-haspopup="dialog" aria-controls="project-root-folder-dialog" aria-expanded={pickerOpen} onClick={()=>setPickerOpen(true)} disabled={saving||pickerBusy}><span>Browse</span></button></div><small>Choose an existing folder. Opnex resolves and validates the selected path when saving.</small></label>
    {pickerOpen&&<DirectoryPicker initialPath={root||initialRoot} onBusyChange={setPickerBusy} onCancel={()=>{setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}} onSelect={selected=>{setRoot(selected);setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}}/>}
    <label className="project-editor-toggle"><input type="checkbox" checked={pinned} onChange={event=>setPinned(event.target.checked)}/><span>Pin project above the rest</span></label>
    {error&&<p className="project-editor-error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary-btn" onClick={close} disabled={saving||pickerBusy}>Cancel</button><button className="primary-btn" disabled={saving||pickerBusy||pickerOpen||!name.trim()||!root.trim()}>{saving?'Saving…':'Save project'}</button></footer>
  </form></div>;
}
