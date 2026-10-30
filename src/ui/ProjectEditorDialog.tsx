import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from './api';
import { DirectoryPicker } from './DirectoryPicker';
import type { Project } from '../types';

type IntegrationState={enabled:boolean;projectId:string;root:string;existing:{id:string;sourceRoot:string}|null;proposedId:string;conflict:boolean};
type Props={project:Project|'new'|null;initialRoot:string;close:()=>void;saved:(project:Project,duplicate:boolean)=>void};

function normalizedRoot(value:string){
  const input=value.trim();
  if(/^(?:[a-z]:[\\/]|\\\\)/i.test(input))return input.replaceAll('/','\\').replace(/[\\]+$/,'').toLocaleLowerCase('en-US');
  return input.replace(/\/+$/,'');
}

export function ProjectEditorDialog({project,initialRoot,close,saved}:Props){
  const [name,setName]=useState(''),[root,setRoot]=useState(''),[pinned,setPinned]=useState(false),[saving,setSaving]=useState(false),[busy,setBusy]=useState(false),[pickerOpen,setPickerOpen]=useState(false),[pickerBusy,setPickerBusy]=useState(false),[error,setError]=useState(''),[integration,setIntegration]=useState<IntegrationState|null>(null),[integrationError,setIntegrationError]=useState('');
  const dialog=useRef<HTMLFormElement>(null),nameInput=useRef<HTMLInputElement>(null),browseButton=useRef<HTMLButtonElement>(null),restoreFocus=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{restoreFocus.current=document.activeElement as HTMLElement|null;nameInput.current?.focus();return()=>{restoreFocus.current?.focus();restoreFocus.current=null;};},[]);
  const isNew=project==='new';
  const current=isNew||!project?null:project;
  const projectId=current?.id;
  const loadIntegration=async(id:string)=>{setBusy(true);setIntegrationError('');try{setIntegration(await api<IntegrationState>(`/api/projects/${id}/agentmem`));}catch(cause){setIntegrationError(cause instanceof Error?cause.message:'AgentMem status is unavailable.');setIntegration(null);}finally{setBusy(false);}};
  useEffect(()=>{if(!project)return;setName(isNew?'':project.name);setRoot(isNew?initialRoot:project.projectRoot);setPinned(!isNew&&project.pinned);setError('');setIntegration(null);setIntegrationError('');if(!isNew&&!project.needsLocation&&project.agentmemEnabled)void loadIntegration(project.id);},[projectId,isNew,project==='new'?'':project?.projectRoot,initialRoot]);
  const saveProject=async(event:React.FormEvent)=>{event.preventDefault();if(!project||saving)return;setSaving(true);setError('');try{const result=await api<{project:Project;duplicate:boolean}>('/api/projects',{id:isNew?crypto.randomUUID():project.id,name,projectRoot:root,pinned});saved(result.project,result.duplicate);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setSaving(false);}};
  const agentMemAction=async(action:'connect'|'create'|'disable',id?:string)=>{
    if(!current||busy)return;setBusy(true);setIntegrationError('');
    try{
      const result=await api<{project:Project}>(`/api/projects/${current.id}/agentmem/${action}`,action==='disable'?{}:{projectId:id});
      if(action==='disable')setIntegration({enabled:false,projectId:'',root:current.projectRoot,existing:null,proposedId:integration?.proposedId||'',conflict:false});
      else setIntegration({enabled:true,projectId:result.project.agentmemProjectId,root:result.project.projectRoot,existing:{id:result.project.agentmemProjectId,sourceRoot:result.project.projectRoot},proposedId:integration?.proposedId||result.project.agentmemProjectId,conflict:false});
      await saved(result.project,false);
    }catch(cause){setIntegrationError(cause instanceof Error?cause.message:'AgentMem could not be configured.');}
    finally{setBusy(false);}
  };
  if(!project)return null;
  const rootChanged=!!current&&normalizedRoot(root)!==normalizedRoot(current.projectRoot);
  const directoryNeedsAgentMemDisable=rootChanged&&!!current?.agentmemEnabled&&integration?.enabled!==false;
  const trapDialogTab=(event:ReactKeyboardEvent<HTMLFormElement>)=>{if(event.key==='Escape'&&!saving&&!busy&&!pickerBusy&&!pickerOpen){event.preventDefault();close();return;}if(event.key!=='Tab'||pickerOpen)return;const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')||[]).filter(item=>!item.closest('[hidden],[inert],[aria-hidden="true"]'));const first=items[0],last=items[items.length-1];if(!first){event.preventDefault();nameInput.current?.focus();return;}if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}};
  return <div className="dialog-backdrop" data-open="true" role="presentation" onMouseDown={event=>event.target===event.currentTarget&&!saving&&!busy&&!pickerBusy&&close()}><form ref={dialog} className="project-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="project-editor-title" onSubmit={saveProject} onKeyDown={trapDialogTab}>
    <header><div><h2 id="project-editor-title">{isNew?'Create project':`Configure ${project.name}`}</h2><p>A project owns its working directory, sessions, and optional integrations.</p></div><button type="button" className="icon-btn" aria-label="Close project settings" onClick={close} disabled={saving||busy}>×</button></header>
    <label>Project name<input ref={nameInput} value={name} maxLength={80} onChange={event=>setName(event.target.value)} required/></label>
    <label>Working directory<div className="project-root-control"><input value={root} maxLength={1024} placeholder="Choose an existing folder" readOnly aria-readonly="true" aria-label="Working directory" spellCheck={false} required/><button ref={browseButton} type="button" className="project-root-browse" aria-label="Browse working directory folders" aria-haspopup="dialog" aria-controls="project-root-folder-dialog" aria-expanded={pickerOpen} onClick={()=>setPickerOpen(true)} disabled={saving||busy||pickerBusy}><span>Browse</span></button></div><small>Choose an existing folder. Opnex resolves and validates the selected path when saving.</small></label>
    {pickerOpen&&<DirectoryPicker initialPath={root||initialRoot} onBusyChange={setPickerBusy} onCancel={()=>{setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}} onSelect={selected=>{setRoot(selected);setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}}/>}
    <label className="project-editor-toggle"><input type="checkbox" checked={pinned} onChange={event=>setPinned(event.target.checked)}/><span>Pin project above the rest</span></label>
    {current&&<section className="project-integration"><header><div><h3>Optional AgentMem project knowledge</h3><p>Sessions work normally when AgentMem is off or unavailable.</p></div></header>
      {current.needsLocation&&<p role="status">Choose a current working directory before connecting AgentMem.</p>}
      {rootChanged&&<p role="status">Existing sessions keep their recorded directory. Save this path before checking AgentMem. Disable the current connection before changing this project’s directory.</p>}
      {rootChanged&&current.agentmemEnabled&&integration?.enabled!==false&&<button type="button" className="secondary-btn" disabled={busy} onClick={()=>void agentMemAction('disable')}>Disable AgentMem before changing the directory</button>}
      {!rootChanged&&!current.needsLocation&&<>
        <div className="project-integration-status" role="status">{integration?.enabled?`Connected to ${integration.projectId} for ${current.projectRoot}`:integration?.existing?`Found ${integration.existing.id} for this exact directory`:integration?'No knowledge base is registered for this exact directory.':integrationError||(current.agentmemEnabled?'Checking the current AgentMem connection…':'AgentMem is off for this project.')}</div>
        {!integration&&!integrationError&&!current.agentmemEnabled&&<button type="button" className="secondary-btn" disabled={busy} onClick={()=>void loadIntegration(current.id)}>{busy?'Checking…':'Check for an AgentMem knowledge base'}</button>}
        {integration?.conflict&&<p className="project-editor-error" role="alert">AgentMem reports more than one registration for this directory. Resolve that service state before connecting.</p>}
        {!integration?.enabled&&integration?.existing&&!integration.conflict&&<button type="button" className="secondary-btn" disabled={busy} onClick={()=>void agentMemAction('connect',integration.existing?.id)}>Connect existing {integration.existing.id}</button>}
        {!integration?.enabled&&integration&&!integration.existing&&!integration.conflict&&<div className="project-agentmem-create"><p>Create a knowledge base with this exact identity:</p><code>{integration.proposedId}</code><small>{current.projectRoot}</small><button type="button" className="secondary-btn" disabled={busy} onClick={()=>void agentMemAction('create',integration.proposedId)}>Create knowledge base</button></div>}
        {integration?.enabled&&<button type="button" className="secondary-btn" disabled={busy} onClick={()=>void agentMemAction('disable')}>Disable AgentMem for this project</button>}
        {integrationError&&<button type="button" className="text-button" disabled={busy} onClick={()=>void loadIntegration(current.id)}>Retry AgentMem check</button>}
      </>}
      {integrationError&&<p className="project-editor-error" role="alert">{integrationError}</p>}
    </section>}
    {error&&<p className="project-editor-error" role="alert">{error}</p>}
    <footer><button type="button" className="secondary-btn" onClick={close} disabled={saving||busy||pickerBusy}>Cancel</button><button className="primary-btn" disabled={saving||busy||pickerBusy||pickerOpen||!name.trim()||!root.trim()||directoryNeedsAgentMemDisable}>{saving?'Saving…':'Save project'}</button></footer>
  </form></div>;
}
