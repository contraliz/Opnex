import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, FileDiff, RefreshCw } from 'lucide-react';
import { api } from './api';
import type { WorkspaceGitFile, WorkspaceGitSnapshot } from '../types';

export function WorkspaceGitDiff({taskId,enabled}:{taskId:string;enabled:boolean}){
  const [open,setOpen]=useState(false);const [loading,setLoading]=useState(false);const [snapshot,setSnapshot]=useState<WorkspaceGitSnapshot|null>(null);const [error,setError]=useState('');const [expanded,setExpanded]=useState<Set<string>>(()=>new Set());const request=useRef(0);const panelId=useId();
  const refresh=useCallback(async()=>{const current=++request.current;setLoading(true);setError('');try{const result=await api<WorkspaceGitSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/git`);if(current===request.current)setSnapshot(result);}catch(cause){if(current===request.current)setError(cause instanceof Error?cause.message:'Could not read the current Git changes.');}finally{if(current===request.current)setLoading(false);}},[taskId]);
  useEffect(()=>{if(enabled&&open&&!snapshot&&!loading&&!error)void refresh();},[enabled,open,snapshot,loading,error,refresh]);
  const toggleFile=(file:WorkspaceGitFile)=>setExpanded(current=>{const next=new Set(current);if(next.has(file.path))next.delete(file.path);else next.add(file.path);return next;});
  return <section className="receipt-git" aria-label="Current workspace changes">
    <header className="receipt-git-head">
      <button type="button" className="receipt-git-toggle" aria-controls={panelId} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
        <FileDiff size={15} aria-hidden="true"/>
        <span className="receipt-git-heading"><strong>Current workspace changes</strong><small>Live view of this task’s workspace against HEAD · read only</small></span>
        <ChevronDown size={14} className="receipt-git-chevron" aria-hidden="true"/>
      </button>
      <button type="button" className="receipt-git-refresh" aria-label="Refresh current workspace changes" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={13} className={loading?'is-spinning':''}/>{loading?'Reading…':'Refresh'}</button>
    </header>
    <div id={panelId} className={`receipt-git-panel ${open?'is-open':''}`} aria-hidden={!open} inert={!open}>
      <div className="receipt-git-panel-inner">
        {loading&&!snapshot&&!error&&<p className="receipt-git-message" role="status">Reading Git changes…</p>}
        {error&&<div className="receipt-git-state is-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void refresh()} disabled={loading}>Retry</button></div>}
        {snapshot&&!error&&<>
          {snapshot.message&&<p className="receipt-git-message">{snapshot.message}</p>}
          {snapshot.available&&snapshot.files.length>0&&<div className="receipt-git-files" aria-label="Changed files">{snapshot.files.map(file=><ReceiptGitFile key={file.path} file={file} expanded={expanded.has(file.path)} onToggle={()=>toggleFile(file)}/>)}</div>}
          {snapshot.available&&snapshot.files.length===0&&!snapshot.message&&<p className="receipt-git-message">The working tree is clean.</p>}
          {snapshot.truncated&&<p className="receipt-git-message">The snapshot is bounded; some changes or file content were omitted. Refresh or inspect Git directly for the full diff.</p>}
          <small className="receipt-git-stamp">{snapshot.branch?`Branch · ${snapshot.branch} · `:''}Snapshot at {new Date(snapshot.capturedAt).toLocaleTimeString()}</small>
        </>}
      </div>
    </div>
  </section>;
}

function ReceiptGitFile({file,expanded,onToggle}:{file:WorkspaceGitFile;expanded:boolean;onToggle:()=>void}){
  const status=gitStatusLabel(file.status,file.kind);const basename=file.path.split(/[\\/]/).at(-1)||file.path;const parent=file.path.slice(0,Math.max(file.path.lastIndexOf('/'),file.path.lastIndexOf('\\')));const hasContent=!!file.patch||file.binary||!!file.omittedReason;
  return <div className={`receipt-git-file ${expanded?'is-expanded':''}`}>
    <div className="receipt-git-file-row"><span className={`receipt-git-file-icon ${status.tone}`} aria-hidden="true"><FileDiff size={17}/></span><div className="receipt-git-file-name" title={file.path}><strong>{status.label} {basename}</strong>{parent&&<small>{parent}</small>}<span className="receipt-git-counts">{file.binary?<em>Binary file</em>:file.omittedReason?<em>Diff unavailable</em>:<><span>+{file.additions===null?'—':file.additions}</span><span>−{file.deletions===null?'—':file.deletions}</span></>}</span></div>{hasContent&&<button type="button" className="receipt-git-view" aria-expanded={expanded} onClick={onToggle}>{expanded?'Hide changes':'View changes'}</button>}</div>
    {expanded&&<div className="receipt-git-file-detail">{file.patch?<pre aria-label={`Changes for ${file.path}`} tabIndex={0}>{file.patch}</pre>:<p>{file.binary?'Binary file content is not rendered.':file.omittedReason||'No readable text diff is available.'}</p>}</div>}
  </div>;
}

function gitStatusLabel(status:string,kind:WorkspaceGitFile['kind']){
  if(kind==='untracked'||status.includes('A'))return {label:'Added',tone:'added'};
  if(status.includes('D'))return {label:'Deleted',tone:'deleted'};
  if(status.includes('R'))return {label:'Renamed',tone:'edited'};
  if(status.includes('T'))return {label:'Type changed',tone:'edited'};
  if(status.includes('U'))return {label:'Conflict',tone:'deleted'};
  return {label:'Edited',tone:'edited'};
}
