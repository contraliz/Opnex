import { useCallback,useEffect,useId,useState } from 'react';
import { ChevronDown,FileDiff,RefreshCw } from 'lucide-react';
import { api } from './api';
import type { PassGitDiff,PassGitDiffTurn } from '../types';

export function PassGitDiff({taskId,passId}:{taskId:string;passId:string}){
  const [open,setOpen]=useState(false);const [loading,setLoading]=useState(false);const [snapshot,setSnapshot]=useState<PassGitDiff|null>(null);const [error,setError]=useState('');const panelId=useId();
  const refresh=useCallback(async()=>{setLoading(true);setError('');try{const result=await api<PassGitDiff>(`/api/tasks/${encodeURIComponent(taskId)}/passes/${encodeURIComponent(passId)}/git`);setSnapshot(result);}catch(cause){setError(cause instanceof Error?cause.message:'Could not read this pass’s Codex diff.');}finally{setLoading(false);}},[taskId,passId]);
  useEffect(()=>{if(open&&!snapshot&&!loading&&!error)void refresh();},[open,snapshot,loading,error,refresh]);
  return <section className="receipt-git" aria-label="Git changes recorded for this pass">
    <header className="receipt-git-head">
      <button type="button" className="receipt-git-toggle" aria-controls={panelId} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
        <FileDiff size={15} aria-hidden="true"/><span className="receipt-git-heading"><strong>Git changes recorded for this pass</strong><small>Codex turn diffs · agent-owned changes only</small></span><ChevronDown size={14} className="receipt-git-chevron" aria-hidden="true"/>
      </button>
      <button type="button" className="receipt-git-refresh" aria-label="Refresh pass Git changes" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={13} className={loading?'is-spinning':''}/>{loading?'Reading…':'Refresh'}</button>
    </header>
    <div id={panelId} className={`receipt-git-panel ${open?'is-open':''}`} aria-hidden={!open} inert={!open}><div className="receipt-git-panel-inner">
      {loading&&!snapshot&&!error&&<p className="receipt-git-message" role="status">Reading recorded pass changes…</p>}
      {error&&<div className="receipt-git-state is-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void refresh()} disabled={loading}>Retry</button></div>}
      {snapshot&&!error&&<>
        {snapshot.message&&snapshot.status!=='unavailable'&&<p className="receipt-git-message">{snapshot.message}</p>}
        {snapshot.status==='unavailable'&&<p className="receipt-git-message">{snapshot.message||'Codex did not report a tracked turn diff for this pass. Workspace changes are not used as a substitute.'}</p>}
        {snapshot.turns?.map(turn=><PassTurn key={`${turn.threadId}:${turn.turnId}`} turn={turn}/>)}
        {snapshot.status==='recorded'&&snapshot.turns?.length===0&&<p className="receipt-git-message">Codex reported no tracked patch changes in this pass.</p>}
        {snapshot.status==='partial'&&<p className="receipt-git-message">The stored Codex turn diffs reached a capture limit. Some agent changes may be missing.</p>}
        {snapshot.status!=='unavailable'&&snapshot.updatedAt&&<small className="receipt-git-stamp">Updated {new Date(snapshot.updatedAt).toLocaleTimeString()} · per-turn diffs, not a combined pass-wide net diff</small>}
      </>}
    </div></div>
  </section>;
}

function PassTurn({turn}:{turn:PassGitDiffTurn}){
  const counts=countLines(turn.diff);const roleLabel=turn.role==='worker'?'Worker':turn.role==='orchestrator'?'Orchestrator':'Simple implementation';const files=splitDiff(turn.diff);
  return <article className="receipt-git-file">
    <div className="receipt-git-file-row"><span className="receipt-git-file-icon edited" aria-hidden="true"><FileDiff size={17}/></span><div className="receipt-git-file-name"><strong>{roleLabel} turn</strong><small>Turn {turn.turnId}</small><span className="receipt-git-counts"><span>+{counts.additions}</span><span>−{counts.deletions}</span>{counts.binary&&<em>Binary change</em>}{turn.truncated&&<em>Diff truncated</em>}</span></div></div>
    {!files.length&&<p className="receipt-git-message">No tracked patch changes in this turn.</p>}
    {files.map(file=><PassFile key={file.path} file={file}/>)}
  </article>;
}

function PassFile({file}:{file:{path:string;patch:string}}){
  const [expanded,setExpanded]=useState(false);const counts=countLines(file.patch);const binary=counts.binary;
  return <div className={`receipt-git-file ${expanded?'is-expanded':''}`}><div className="receipt-git-file-row"><span className="receipt-git-file-icon edited" aria-hidden="true"><FileDiff size={17}/></span><div className="receipt-git-file-name" title={file.path}><strong>{file.path}</strong><span className="receipt-git-counts">{binary?<em>Binary change</em>:<><span>+{counts.additions}</span><span>−{counts.deletions}</span></>}</span></div><button type="button" className="receipt-git-view" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'Hide changes':'View changes'}</button></div>{expanded&&<div className="receipt-git-file-detail"><pre aria-label={`Changes for ${file.path}`} tabIndex={0}>{file.patch}</pre></div>}</div>;
}

function splitDiff(diff:string){
  const starts=[...diff.matchAll(/^diff --git /gm)].map(match=>match.index!);if(!starts.length)return [];
  return starts.map((start,index)=>{const patch=diff.slice(start,starts[index+1]??diff.length);const header=patch.slice(0,patch.indexOf('\n')<0?patch.length:patch.indexOf('\n'));const paths=header.match(/^diff --git (?:"a\/(.*?)"\s+"b\/(.*?)"|a\/(.+?)\s+b\/(.+))$/);return {path:paths?.[2]||paths?.[4]||`Turn diff ${index+1}`,patch};});
}

function countLines(diff:string){let additions=0,deletions=0,binary=false;for(const line of diff.split('\n')){if(line.startsWith('Binary files ')||line==='GIT binary patch')binary=true;else if(line.startsWith('+++')||line.startsWith('---')||line.startsWith('@@')||line.startsWith('diff --git')||line.startsWith('index ')||line.startsWith('new file mode')||line.startsWith('deleted file mode')||line.startsWith('rename '))continue;else if(line.startsWith('+'))additions++;else if(line.startsWith('-'))deletions++;}return {additions,deletions,binary};}
