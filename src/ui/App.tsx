import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, Check, ChevronDown, ChevronRight, Command, ExternalLink, FileText, Folder, MessageSquarePlus, PanelRight, Settings2, ShieldCheck, Square, Terminal, X } from 'lucide-react';
import { api, bootstrap } from './api';
import { Markdown } from './Markdown';
import Composer from './Composer';
import { prepareMarkdownSubmission } from './LiveMarkdownEditor';
import SettingsDialog from './SettingsDialog';
import { SessionDialog, SessionRow } from './SessionControls';
import { WorkspaceGitDiff } from './WorkspaceGitDiff';
import type { AppState, Assignment, Runtime, Task, TaskPass, Message } from '../types';

const phaseText:Record<string,string>={intake:'Ready',planning:'Planning',worker_running:'Worker running · orchestrator idle',escalated:'Decision needed',reviewing:'Reviewing receipt',accepted:'Accepted',needs_attention:'Needs attention',cancelled:'Cancelled',paused_after_restart:'Paused after restart'};
const stamp=(s:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(s));
const rootLabel=(root?:string)=>root?.split(/[\\/]/).filter(Boolean).at(-1)||'Choose project root';
export default function App(){
  const [state,setState]=useState<AppState|null>(null);const [runtime,setRuntime]=useState<Runtime|null>(null);const [draft,setDraft]=useState('');const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [settingsOpen,setSettingsOpen]=useState(false);const [settingsMounted,setSettingsMounted]=useState(false);const [sessionDialog,setSessionDialog]=useState<{kind:'rename'|'delete';taskId:string}|null>(null);const [sessionDialogOpen,setSessionDialogOpen]=useState(false);const [sessionDialogMounted,setSessionDialogMounted]=useState(false);const [inspector,setInspector]=useState(true);const [sidebarCollapsed,setSidebarCollapsed]=useState(false);const [sending,setSending]=useState(false);const [retryingPassId,setRetryingPassId]=useState('');const [expanded,setExpanded]=useState<Record<string,boolean>>({});const inputRef=useRef<HTMLElement|null>(null);const scrollRef=useRef<HTMLDivElement>(null);const sendingRef=useRef(false);
  const active=state?.activeTaskId?state.tasks.find(t=>t.id===state.activeTaskId)||null:null;const currentPass=active?.passes?.find(pass=>pass.id===active.currentPassId);const busy=!!active&&['planning','worker_running','reviewing'].includes(active.phase);const workerOk=!!runtime?.codex.workerAvailable;const canSend=!!draft.trim()&&!sending&&!!runtime;const visibleMessageCount=active?.messages.filter(message=>message.role!=='worker'&&(message.role!=='system'||!message.text.startsWith('Worker activity:'))).length||0;const orchestratorReasoningGrowth=(active?.reasoningSummaries?.filter(x=>x.role==='orchestrator').reduce((n,x)=>n+x.text.length,0)||0)+(active?.reasoningRawContent?.filter(x=>x.role==='orchestrator').reduce((n,x)=>n+x.text.length,0)||0);
  const models=useMemo(()=>runtime?.codex.models||[],[runtime]);
  const refresh=async()=>{try{const x=await api<{state:AppState;runtime:Runtime}>('/api/state');setState(x.state);setRuntime(x.runtime);}catch(e){setError(String(e));}};
  useEffect(()=>{let alive=true;bootstrap().then(x=>{if(!alive)return;setState(x.state);setRuntime(x.runtime);if(!x.state.settings.projectRoot){setSettingsMounted(true);setSettingsOpen(true);}setLoading(false);}).catch(e=>{if(alive){setError(String(e));setLoading(false);}});const source=new EventSource('/events');source.onmessage=e=>{try{const v=JSON.parse(e.data);if(v.state&&alive){setState(v.state);setRuntime(v.runtime);}}catch{}};source.onerror=()=>{if(alive)void refresh();};const timer=setInterval(()=>void refresh(),10000);return()=>{alive=false;source.close();clearInterval(timer);};},[]);
  useEffect(()=>{if(settingsOpen||!settingsMounted)return;const timer=window.setTimeout(()=>setSettingsMounted(false),110);return()=>window.clearTimeout(timer);},[settingsOpen,settingsMounted]);
  useEffect(()=>{if(sessionDialogOpen||!sessionDialogMounted)return;const timer=window.setTimeout(()=>{setSessionDialogMounted(false);setSessionDialog(null);},110);return()=>window.clearTimeout(timer);},[sessionDialogOpen,sessionDialogMounted]);
  useEffect(()=>{const el=scrollRef.current;if(el)el.scrollTop=el.scrollHeight;},[visibleMessageCount]);
  useEffect(()=>{const el=scrollRef.current;if(!el)return;const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<180;if(nearBottom)el.scrollTop=el.scrollHeight;},[orchestratorReasoningGrowth]);
  useEffect(()=>{if(!active?.id)return; void api('/api/tasks/'+active.id+'/select',{}).catch(()=>{});},[active?.id]);
  useEffect(()=>{const onShortcut=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='n'){event.preventDefault();setState(s=>s?{...s,activeTaskId:null}:s);void api('/api/tasks/new',{}).catch(e=>setError(String(e)));setError('');setDraft('');inputRef.current?.focus();}};window.addEventListener('keydown',onShortcut);return()=>window.removeEventListener('keydown',onShortcut);},[]);
  const submit=async()=>{const message=prepareMarkdownSubmission(draft);if(message===null||sendingRef.current||sending)return;sendingRef.current=true;setSending(true);setError('');setDraft('');try{
    if(active?.phase==='escalated')await api('/api/tasks/'+active.id+'/escalation',{message});
    else if(active)await api('/api/tasks/'+active.id+'/messages',{message});
    else await api('/api/tasks',{message});
    await refresh();
  }catch(e){setError(String(e));setDraft(message);}finally{sendingRef.current=false;setSending(false);inputRef.current?.focus();}};
  const openSettings=()=>{setSettingsMounted(true);setSettingsOpen(true);};
  const closeSettings=()=>setSettingsOpen(false);
  const openSessionDialog=useCallback((kind:'rename'|'delete',taskId:string)=>{setSessionDialog({kind,taskId});setSessionDialogMounted(true);setSessionDialogOpen(true);},[]);
  const closeSessionDialog=()=>setSessionDialogOpen(false);
  const newTask=()=>{setState(s=>s?{...s,activeTaskId:null}:s);void api('/api/tasks/new',{}).catch(e=>setError(String(e)));setError('');setDraft('');inputRef.current?.focus();};
  const stop=async()=>{if(!active)return;try{await api('/api/tasks/'+active.id+'/cancel',{});await refresh();}catch(e){setError(String(e));}};
  const retryAgentMem=async(passId:string)=>{if(!active)return;setRetryingPassId(passId);setError('');try{await api('/api/tasks/'+active.id+'/passes/'+passId+'/agentmem/retry',{});await refresh();}catch(e){setError(String(e));}finally{setRetryingPassId('');}};
  const settingsQueue=useRef<Promise<void>>(Promise.resolve());const settingsDraft=useRef<NonNullable<AppState>['settings']|null>(null);
  const updateSettings=(patch:Partial<NonNullable<AppState>['settings']>)=>{if(!state)return Promise.resolve();const next={...(settingsDraft.current||state.settings),...patch};settingsDraft.current=next;settingsQueue.current=settingsQueue.current.then(async()=>{try{await api('/api/settings',next);await refresh();}catch(e){setError(String(e));}finally{if(settingsDraft.current===next)settingsDraft.current=null;}});return settingsQueue.current;};
  const setModel=async(id:string)=>{const found=models.find(m=>m.id===id);if(!found)return;const effort=found.efforts.includes(state?.settings.orchestratorEffort||'')?state!.settings.orchestratorEffort:found.efforts.includes('high')?'high':found.efforts[0];await updateSettings({orchestratorModel:id,orchestratorEffort:effort});};
  const approve=async(requestId:string|number,decision:'accept'|'decline'|'cancel')=>{if(!active)return;try{await api('/api/tasks/'+active.id+'/approval',{requestId,decision});await refresh();}catch(e){setError(String(e));}};
  const selectTask=useCallback(async(id:string)=>{try{await api('/api/tasks/'+id+'/select',{});await refresh();}catch(e){setError(String(e));}},[]);
  const renameSession=async(taskId:string,title:string)=>{try{await api('/api/tasks/'+taskId+'/rename',{title});await refresh();closeSessionDialog();}catch(e){setError(String(e));}};
  const deleteSession=async(taskId:string)=>{try{await api('/api/tasks/'+taskId+'/delete',{});await refresh();closeSessionDialog();}catch(e){setError(String(e));}};
  if(loading)return <div className="boot"><div className="brand-mark">P</div><span>Starting Pseudoharness</span></div>;
  const composerHint=active?.phase==='escalated'?'A decision will be sent to the orchestrator…':'Ask a simple question or describe work for the orchestrator to route.';
  return <div className={`app-shell ${sidebarCollapsed?'sidebar-collapsed':''}`}>
    <aside id="primary-sidebar" className="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
      <div className="brand-row"><div className="brand-mark">P</div><span className="brand-name">Pseudoharness</span></div>
      <button className="new-task" aria-label="New task" onClick={newTask}><MessageSquarePlus size={17}/><span>New task</span></button>
      <div className="side-label">Recent tasks</div>
      <nav className="task-list" aria-label="Recent tasks">{state?.tasks.map(t=><SessionRow key={t.id} task={t} selected={t.id===active?.id} onSelect={selectTask} onSessionAction={openSessionDialog}/>)}</nav>
      <div className="sidebar-spacer" />
      <button className="project-mini" aria-label={`${rootLabel(state?.settings.projectRoot)} project settings`} onClick={openSettings}><Folder size={17}/><span className="project-mini-text">{rootLabel(state?.settings.projectRoot)}</span><ChevronRight size={15}/></button>
      <div className="service-rows"><div><span className={`tiny-dot ${runtime?.codex.state==='connected'?'online':'offline'}`}/><span>Codex</span><span className="service-value">{runtime?.codex.state==='connected'?'Connected':runtime?.codex.state||'starting'}</span></div><div><span className={`tiny-dot ${state?.settings.agentmemProjectId&&runtime?.agentmem.projectVerified?'online':'offline'}`}/><span>AgentMem</span><span className="service-value">{state?.settings.agentmemProjectId?(runtime?.agentmem.projectVerified?'Connected':'Unavailable'):'Disabled'}</span></div></div>
      <button className="sidebar-settings" aria-label="Settings" onClick={openSettings}><Settings2 size={17}/><span className="sidebar-settings-label">Settings</span><ChevronRight className="settings-arrow" size={16}/></button>
    </aside>
    <div className={`workspace-area ${active&&inspector?'inspector-open':'inspector-closed'}`}>
    <main className="main-column">
      <header className="topbar"><button className="icon-btn sidebar-toggle" aria-label={sidebarCollapsed?'Expand sidebar':'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="primary-sidebar" onClick={()=>setSidebarCollapsed(value=>!value)}><PanelRight size={16}/></button><div className="breadcrumb"><span className="crumb-project">{rootLabel(state?.settings.projectRoot)}</span><ChevronRight size={16}/><span>{active?.title||'New task'}</span></div><div className="top-actions"><span className={`connection-pill ${runtime?.codex.state==='connected'?'connected':''}`}><span className="tiny-dot"/>{runtime?.codex.state==='connected'?'Connected':'Offline'}</span>{busy&&<button className="stop-btn" onClick={stop}><Square size={12} fill="currentColor"/>Stop</button>}{active&&<button className="details-toggle" aria-expanded={inspector} aria-controls="task-inspector" onClick={()=>setInspector(x=>!x)}><PanelRight size={17}/><span>Details</span></button>}</div></header>
      {!active?<section className="empty-workspace"><div className="empty-icon"><Command size={25}/></div><h1>What are we working on?</h1><p>Ask a simple question for a direct answer, or describe work for the orchestrator to route under the delegation policy.</p><div className="empty-trust"><ShieldCheck size={15}/>Local workflow · project-scoped sandbox · explicit receipt review</div></section>:<>
        <div className="conversation" ref={scrollRef}>
          {active.messages.filter(m=>!m.passId).map(m=><ConversationMessage key={m.id} message={m}/>)}
          {active.passes?.map(pass=><PassPanel key={pass.id} pass={pass} messages={active.messages.filter(m=>m.passId===pass.id)} active={pass.id===active.currentPassId} task={active} assignmentExpanded={expanded[`assignment:${pass.id}`]??false} receiptExpanded={expanded[`receipt:${pass.id}`]??false} workerActivityExpanded={expanded[`workerActivity:${pass.id}`]??false} retrying={retryingPassId===pass.id} onRetryAgentMem={()=>retryAgentMem(pass.id)} toggleAssignment={()=>setExpanded(x=>({...x,[`assignment:${pass.id}`]:!x[`assignment:${pass.id}`]}))} toggleReceipt={()=>setExpanded(x=>({...x,[`receipt:${pass.id}`]:!x[`receipt:${pass.id}`]}))} toggleWorkerActivity={()=>setExpanded(x=>({...x,[`workerActivity:${pass.id}`]:!x[`workerActivity:${pass.id}`]}))}/>)}
          {active.approvalRequests?.map(request=><ApprovalCard key={String(request.requestId)} request={request} onDecision={decision=>approve(request.requestId,decision)}/>)}
        </div>
      </>}
      <div className="composer-dock"><Composer value={draft} setValue={setDraft} submit={submit} disabled={!canSend} hint={composerHint} inputRef={inputRef} model={state?.settings.orchestratorModel||'gpt-6-sol'} effort={state?.settings.orchestratorEffort||'high'} approvalPolicy={state?.settings.approvalPolicy||'on-request'} models={models} workerReady={workerOk} configDisabled={busy||sending} onModelChange={setModel} onEffortChange={v=>void updateSettings({orchestratorEffort:v})} onApprovalChange={v=>void updateSettings({approvalPolicy:v})} busy={busy}/></div>
    </main>
    {active&&<aside id="task-inspector" className={`inspector ${inspector?'':'is-closed'}`} aria-hidden={!inspector} inert={!inspector}><div className="inspector-head"><span>Task details</span><button className="icon-btn" aria-label="Close details" onClick={()=>setInspector(false)}><X size={16}/></button></div><div className="inspector-scroll"><div className="inspect-section"><div className="inspect-label">Status</div><div className="inspect-phase"><span className={`phase-indicator ${active.phase}`}/>{phaseText[active.phase]||active.phase}</div><p className="inspect-help">{active.phase==='worker_running'?'The orchestrator is dormant until your input, an explicit decision escalation, or the worker receipt.':'Only a validated structured outcome can advance this task.'}</p></div><div className="inspect-section"><div className="inspect-label">Models</div><div className="model-row"><span>Orchestrator</span><b>{state?.settings.orchestratorModel}</b></div><div className="model-row"><span>Reasoning effort</span><b>{state?.settings.orchestratorEffort}</b></div><div className="model-row"><span>Worker</span><b>gpt-6-luna · high</b></div><button className="text-button" onClick={openSettings}>Change settings <ChevronRight size={13}/></button></div><div className="inspect-section"><div className="inspect-label">Current project settings</div><div className="project-path">{state?.settings.projectRoot||'Choose a project root'}</div><div className="model-row"><span>AgentMem for new tasks</span><b>{state?.settings.agentmemProjectId||'Disabled'}</b></div><div className="model-row"><span>AgentMem status</span><b>{!state?.settings.agentmemProjectId?'Disabled':runtime?.agentmem.projectVerified&&runtime.agentmem.detail.includes(state.settings.agentmemProjectId)?'Connected':runtime?.agentmem.connected?'Selected · not verified':'Unavailable'}</b></div><button className="text-button" onClick={openSettings}>Project settings <ChevronRight size={13}/></button></div><div className="inspect-section historical-context"><div className="inspect-label">This session used</div><div className="project-path">{active.userRoot||'Project root not recorded'}</div><div className="model-row"><span>AgentMem project</span><b>{active.agentmemProjectId||'Disabled'}</b></div>{active.agentmemTaskId&&<><div className="model-row"><span>AgentMem task receipt</span><b>{active.agentmemRecordStatus==='done'?'AgentMem task done':active.agentmemRecordStatus==='released'?'Ownership released':active.agentmemRecordStatus==='failed'?'Save failed':active.receipt?.status==='blocked'&&active.agentmemRecordStatus?'Saved · task blocked; lease released':active.agentmemRecordStatus==='saving'?'Saving receipt…':active.agentmemRecordStatus==='in_progress'?'Receipt saved · task open':active.agentmemRecordStatus?'Saved · completion pending':'Work record open'}</b></div>{active.agentmemRecordError&&<p className="inspect-help">{active.agentmemRecordError}</p>}</>}</div><Disclosure title="Current pass session IDs" icon={<Command size={14}/>} open={expanded.session||false} onToggle={()=>setExpanded(x=>({...x,session:!x.session}))}><SessionIdRow role="Orchestrator" threadId={currentPass?currentPass.orchestratorThreadId:active.orchestratorThreadId}/><SessionIdRow role="Worker" threadId={currentPass?currentPass.workerThreadId:active.workerThreadId}/></Disclosure><div className="scope-note"><ShieldCheck size={14}/><span>{state?.settings.approvalPolicy==='full-access'?'Full access is enabled for new passes: Codex will not sandbox filesystem or prompt for approvals.':'Codex sandbox policy is applied per role. Assignment text alone does not enforce filesystem permissions.'}</span></div></div></aside>}
    </div>
    {error&&<div className="toast-error" role="alert"><AlertCircle size={15}/>{error}<button className="icon-btn" aria-label="Dismiss" onClick={()=>setError('')}><X size={14}/></button></div>}
    {settingsMounted&&state&&<SettingsDialog open={settingsOpen} settings={state.settings} models={models} runtime={runtime} close={closeSettings} reconnect={refresh} saved={async settings=>{try{await api('/api/settings',settings);await refresh();return true;}catch(e){setError(String(e));return false;}}}/>}
    {sessionDialogMounted&&sessionDialog&&<SessionDialog open={sessionDialogOpen} kind={sessionDialog.kind} task={state?.tasks.find(t=>t.id===sessionDialog.taskId)} close={closeSessionDialog} rename={renameSession} remove={deleteSession}/>}
  </div>;
}

function ConversationMessage({message:m}:{message:Message}){
  if(m.role==='user')return <div className="message user-message" key={m.id}><div className="user-avatar">U</div><div className="message-main"><div className="message-meta"><strong>You</strong><span>{stamp(m.createdAt)}</span></div><div className="message-body markdown-body"><Markdown>{m.text}</Markdown></div></div></div>;
  if(m.role==='system')return <div className={`system-event ${m.text.startsWith('Worker activity:')?'progress-event':''}`} key={m.id}><span className="event-glyph">{m.text.startsWith('Worker activity:')?<Activity size={14}/>:<AlertCircle size={14}/>}</span><span>{m.text.replace(/^Worker activity: /,'')}</span></div>;
  return <div className="message agent-message" key={m.id}><div className={`agent-avatar ${m.role}`}>{m.role==='worker'?<Terminal size={15}/>:<Command size={15}/>}</div><div className="message-main"><div className="message-meta"><strong>{m.role==='worker'?'Luna worker':'Orchestrator'}</strong><span>{stamp(m.createdAt)}</span>{m.role==='worker'&&<span className="model-chip">gpt-6-luna · high</span>}</div><div className="message-body markdown-body"><Markdown>{m.text}</Markdown></div></div></div>;
}

function SessionIdRow({role,threadId}:{role:'Orchestrator'|'Worker';threadId?:string}){
  return <div className="session-id"><span>{role}</span><code>{threadId||'Not started'}</code>{threadId&&<a className="session-open-link" href={`codex://threads/${encodeURIComponent(threadId)}`} aria-label={`Open ${role} session in Codex`}>Open in Codex <ExternalLink size={12}/></a>}</div>;
}

function ReasoningResponse({turn,summaries,rawContent,live,fallbackTime}:{turn:NonNullable<TaskPass['reasoningTurns']>[number];summaries:NonNullable<TaskPass['reasoningSummaries']>;rawContent:NonNullable<TaskPass['reasoningRawContent']>;live:boolean;fallbackTime:string}){
  const turnSummaries=summaries.filter(x=>x.role===turn.role&&x.threadId===turn.threadId&&x.turnId===turn.turnId&&x.text.trim());
  const summaryItemIds=[...new Set(turnSummaries.map(x=>x.itemId))];
  const summaryText=summaryItemIds.map(itemId=>turnSummaries.filter(x=>x.itemId===itemId).sort((a,b)=>a.summaryIndex-b.summaryIndex).map(x=>x.text).join('\n\n')).join('\n\n');
  const rawRows=rawContent.filter(x=>x.role===turn.role&&x.threadId===turn.threadId&&x.turnId===turn.turnId&&x.text.trim());
  const rawItemIds=[...new Set(rawRows.map(x=>x.itemId))];
  const rawText=rawItemIds.map(itemId=>rawRows.filter(x=>x.itemId===itemId).sort((a,b)=>a.contentIndex-b.contentIndex).map(x=>x.text).join('')).join('\n\n');
  const source=rawText?'Raw reasoning':summaryText?'Readable summary':'';
  const text=rawText||summaryText;
  const time=turn.startedAt||fallbackTime;
  const unavailable=turn.status==='interrupted'?'Reasoning stream interrupted.':turn.status==='failed'?'Reasoning stream failed.':'The provider did not emit a readable reasoning summary for this turn.';
  return <div className={`message agent-message reasoning-response ${live?'is-live':''}`} aria-label={`${turn.role} model response`} data-reasoning-source={source||'unavailable'}>
    <div className={`agent-avatar ${turn.role}`}>{turn.role==='worker'?<Terminal size={15}/>:<Command size={15}/>}</div>
    <div className="message-main"><div className="message-meta"><strong>{turn.role==='worker'?'Luna worker':'Orchestrator'}</strong><span>{stamp(time)}</span>{source&&<span className="reasoning-source-chip">{source}</span>}{turn.role==='worker'&&<span className="model-chip">gpt-6-luna · high</span>}</div>
      <div className={`message-body reasoning-response-body ${rawText?'is-raw':''}`}>{text?(rawText?<div className="reasoning-raw-text">{rawText}</div>:<div className="markdown-body"><Markdown>{summaryText}</Markdown></div>):<span className="reasoning-response-empty">{live?'Waiting for model reasoning…':unavailable}</span>}</div>
    </div>
  </div>;
}

function PassPanel({pass:p,messages,active,task,assignmentExpanded,receiptExpanded,workerActivityExpanded,retrying,onRetryAgentMem,toggleAssignment,toggleReceipt,toggleWorkerActivity}:{pass:TaskPass;messages:Message[];active:boolean;task:Task;assignmentExpanded:boolean;receiptExpanded:boolean;workerActivityExpanded:boolean;retrying:boolean;onRetryAgentMem:()=>void;toggleAssignment:()=>void;toggleReceipt:()=>void;toggleWorkerActivity:()=>void}){
  const live=active&&task.phase===p.phase&&['planning','worker_running','reviewing'].includes(p.phase);
  const output=p.publicAnswer||p.receipt?.result||'';
  const visibleMessages=messages.filter(m=>!(m.role==='orchestrator'&&m.text==='Prepared a complete assignment.'&&(p.reasoningTurns||[]).some(turn=>turn.role==='orchestrator'))&&!(output&&m.role!=='user'&&m.text===output));
  const turns=p.reasoningTurns||[];const timeline=[...visibleMessages.map((message,index)=>({kind:'message' as const,at:Date.parse(message.createdAt)||0,index,message})),...turns.map((turn,index)=>{const roleTurns=turns.filter(item=>item.role===turn.role);const roleMessages=visibleMessages.filter(message=>message.role===turn.role);const roleIndex=roleTurns.findIndex(item=>item.threadId===turn.threadId&&item.turnId===turn.turnId);const matchingMessage=roleMessages[roleIndex];const latestUser=visibleMessages.filter(message=>message.role==='user').at(-1);const fallbackAt=matchingMessage?(Date.parse(matchingMessage.createdAt)||0)-1:(Date.parse(latestUser?.createdAt||p.createdAt)||0)+1;return {kind:'reasoning' as const,at:Date.parse(turn.startedAt||'')||fallbackAt,index,turn};})].sort((a,b)=>a.at-b.at||(a.kind!==b.kind?(a.kind==='reasoning'?-1:1):a.index-b.index));
  const workerRows=timeline.filter(row=>row.kind==='reasoning'?row.turn.role==='worker':row.message.role==='worker'||row.message.role==='system'&&row.message.text.startsWith('Worker activity:'));
  const visibleTimeline=timeline.filter(row=>row.kind==='reasoning'?row.turn.role!=='worker':row.message.role!=='worker'&&!(row.message.role==='system'&&row.message.text.startsWith('Worker activity:')));
  const recordStatus=p.agentmemRecordStatus||(p.agentmemTaskId?undefined:task.agentmemRecordStatus);
  const recordError=p.agentmemRecordError||(p.agentmemTaskId?undefined:task.agentmemRecordError);
  return <section className={`pass-panel ${p.legacyUnassociated?'legacy-pass':''}`} aria-label={p.legacyUnassociated?'Legacy pass with unassociated history':`Pass ${p.index}`}>
    <header className="pass-heading"><span>{p.legacyUnassociated?'Legacy history':`Pass ${p.index}`}</span><span className={`pass-status ${p.phase}`}>{phaseText[p.phase]||p.phase}</span><time>{stamp(p.createdAt)}</time></header>
    {p.legacyUnassociated&&<div className="legacy-association-note">This older session predates per-pass records. Its messages and saved artifacts cannot be reliably matched, so they are shown as unassociated history.</div>}
    {visibleTimeline.map(row=>row.kind==='message'?<ConversationMessage key={row.message.id} message={row.message}/>:<ReasoningResponse key={`${row.turn.threadId}:${row.turn.turnId}`} turn={row.turn} summaries={p.reasoningSummaries||[]} rawContent={p.reasoningRawContent||[]} live={live&&p.activeRole===row.turn.role&&p.activeTurnId===row.turn.turnId} fallbackTime={p.createdAt}/>)}
    {workerRows.length>0&&<div className="worker-activity"><Disclosure title={`Luna activity · ${live&&p.activeRole==='worker'?'live · ':''}${workerRows.length} ${workerRows.length===1?'item':'items'}`} icon={<Terminal size={15}/>} open={workerActivityExpanded} onToggle={toggleWorkerActivity}><div className="worker-activity-scroll">{workerRows.map(row=>row.kind==='message'?<ConversationMessage key={row.message.id} message={row.message}/>:<ReasoningResponse key={`${row.turn.threadId}:${row.turn.turnId}`} turn={row.turn} summaries={p.reasoningSummaries||[]} rawContent={p.reasoningRawContent||[]} live={live&&p.activeRole==='worker'&&p.activeTurnId===row.turn.turnId} fallbackTime={p.createdAt}/>)}</div></Disclosure></div>}
    {(p.assignment||p.workerThreadId||p.receipt)&&p.resolution!=='direct'&&<div className="worker-status" role="status">{p.phase==='worker_running'?<div className="activity-spinner"/>:<Activity size={17} className="worker-activity-icon"/>}<strong>{p.phase==='worker_running'?'Worker is working':p.phase==='accepted'?'Worker review':'Worker task'}</strong><span className="worker-model">gpt-6-luna · high</span><span className={`worker-state ${p.phase}`}>{p.phase==='accepted'&&p.receipt?'Complete':p.phase==='worker_running'?'In progress · orchestrator idle':phaseText[p.phase]||p.phase}</span></div>}
    {p.assignment&&<Disclosure title="Assignment" icon={<FileText size={15}/>} open={assignmentExpanded} onToggle={toggleAssignment}><AssignmentView assignment={p.assignment}/></Disclosure>}
    {p.escalation&&<div className="escalation-card"><div className="escalation-head"><AlertCircle size={16}/><strong>Worker needs a decision</strong></div><p>{p.escalation.decision_needed}</p>{p.escalation.evidence?.map((x:string,i:number)=><div className="escalation-detail" key={i}>{x}</div>)}<div className="escalation-options">{p.escalation.options?.map((x:string,i:number)=><span key={i}>{x}</span>)}</div>{p.escalation.recommendation&&<p className="rec-line"><b>Recommendation:</b> {p.escalation.recommendation}</p>}</div>}
    {p.reviewNote&&<div className={`review-outcome ${p.phase}`}><span>{p.phase==='accepted'?<Check size={15}/>:<AlertCircle size={15}/>}</span><div><strong>{p.phase==='accepted'?(p.resolution==='direct'?'Direct answer':'Receipt accepted'):phaseText[p.phase]}</strong><div className="markdown-body"><Markdown>{p.reviewNote}</Markdown></div>{p.resolution==='direct'&&p.routingNote&&<small className="routing-note">Routing basis: {p.routingNote}</small>}</div></div>}
    {p.phase==='accepted'&&task.agentmemProjectId&&recordStatus&&recordStatus!=='done'&&<div className={`agentmem-pass-status ${recordStatus==='failed'?'is-error':''}`} role="status"><span>{recordStatus==='saving'?'Saving AgentMem receipt…':recordStatus==='failed'?'AgentMem save failed':recordStatus==='in_progress'?'Receipt saved · AgentMem task still open':recordStatus==='released'?'AgentMem lease released':'Checking AgentMem receipt status…'}</span>{recordError&&<small>{recordError}</small>}{p.agentmemTaskId&&(recordStatus==='failed'||recordStatus==='in_progress')&&<button className="text-button" disabled={retrying} onClick={onRetryAgentMem}>{retrying?'Retrying…':'Retry AgentMem completion'}</button>}</div>}
    {p.error&&<div className="error-card"><AlertCircle size={16}/><div><strong>{p.phase==='needs_attention'?'Action needed':'Workflow error'}</strong><p>{p.error}</p>{p.phase==='paused_after_restart'&&<small>Send an explicit update to reattach the saved threads and continue.</small>}</div></div>}
    <PassUsagePanel pass={p}/>
    {output&&<section className="final-artifact" aria-label="Final output"><header><FileText size={16}/><strong>Final output</strong><span>{p.resolution==='direct'?'Orchestrator':'Luna · reviewed by orchestrator'}</span></header><div className="final-artifact-body markdown-body"><Markdown>{output}</Markdown></div></section>}
    <Disclosure title="Run receipt · repository and knowledge base changes" icon={<Check size={15}/>} open={receiptExpanded} onToggle={toggleReceipt}><RunReceipt pass={p} taskId={task.id} gitEnabled={receiptExpanded}/></Disclosure>
  </section>;
}

const tokenCount=(value:number)=>new Intl.NumberFormat(undefined).format(value);
function formatMicros(value:string|undefined,unit:'credits'|'USD'){
  if(value===undefined)return null;
  try{
    const amount=BigInt(value);const whole=amount/1_000_000n;const fraction=(amount%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');
    const numeric=`${whole.toLocaleString()}${fraction?`.${fraction}`:''}`;
    return unit==='USD'?`~$${numeric}`:`~${numeric} credits`;
  }catch{return null;}
}
function PassUsagePanel({pass}:{pass:TaskPass}){
  const usage=pass.usage||{};const allRoles:[keyof typeof usage,string][]=[['orchestrator','Orchestrator'],['worker','Luna worker']];
  const expected=allRoles.filter(([role])=>role==='orchestrator'?!!pass.orchestratorThreadId:!!pass.workerThreadId||pass.resolution==='delegated');
  const roles=allRoles.filter(([role])=>expected.some(([candidate])=>candidate===role)||!!usage[role]);
  const complete=['accepted','cancelled','escalated','needs_attention','paused_after_restart'].includes(pass.phase);
  if(!complete)return null;
  const availableTokens=expected.map(([role,label])=>({role,label,value:usage[role]})).filter(x=>x.value?.tokens&&x.value.tokenStatus==='available');
  const availableCredits=expected.map(([role,label])=>({role,label,value:usage[role]})).filter(x=>x.value?.creditStatus==='available'&&x.value.estimatedCreditsMicros!==undefined);
  const allTokensAvailable=expected.length>0&&availableTokens.length===expected.length;
  const allCreditsAvailable=expected.length>0&&availableCredits.length===expected.length;
  const totalTokens=availableTokens.reduce((sum,row)=>sum+(row.value?.tokens?.totalTokens||0),0);
  const credits=availableCredits.reduce((sum,row)=>sum+BigInt(row.value!.estimatedCreditsMicros!),0n).toString();
  const dollars=allCreditsAvailable&&availableCredits.every(row=>row.value?.estimatedUsdMicros!==null&&row.value?.estimatedUsdMicros!==undefined)?availableCredits.reduce((sum,row)=>sum+BigInt(row.value!.estimatedUsdMicros!),0n).toString():undefined;
  const tokenPending=expected.some(([role])=>usage[role]?.tokenStatus==='pending');
  const creditPending=expected.some(([role])=>usage[role]?.creditStatus==='pending');
  const tokenHeadline=availableTokens.length?`${pass.phase==='accepted'&&allTokensAvailable?'':'Recorded '}${tokenCount(totalTokens)} tokens`:tokenPending?'Collecting…':'Unavailable';
  const creditValue=(dollars?formatMicros(dollars,'USD'):formatMicros(credits,'credits'))||'Unavailable';
  const creditHeadline=pass.phase==='accepted'&&allCreditsAvailable?creditValue:availableCredits.length?`Recorded so far · ${creditValue}`:creditPending?'Collecting…':'Unavailable';
  const fiveHourValues=expected.map(([role])=>usage[role]?.allowance?.fiveHourPercent).filter((value):value is number=>value!==null&&value!==undefined);
  const weeklyValues=expected.map(([role])=>usage[role]?.allowance?.weeklyPercent).filter((value):value is number=>value!==null&&value!==undefined);
  const allowanceValue=(values:number[])=>values.length?`~${values.reduce((sum,value)=>sum+value,0).toFixed(2)}%${values.length<expected.length?' partial':''}`:'unavailable';
  const allowanceHeadline=`5-hour ${allowanceValue(fiveHourValues)} · weekly ${allowanceValue(weeklyValues)}`;
  const detail=(role:keyof typeof usage,label:string,metric:'tokens'|'cost'|'allowance')=>{
    const entry=usage[role];const expectedRole=expected.some(([candidate])=>candidate===role);
    if(!expectedRole)return `${label}: not used`;
    if(metric==='tokens')return entry?.tokens&&entry.tokenStatus==='available'?`${label}: ${tokenCount(entry.tokens.totalTokens)} tokens`:`${label}: ${entry?.tokenStatus==='unavailable'?'unavailable':'not reported'}`;
    if(metric==='cost')return entry?.creditStatus==='available'?`${label}: ${formatMicros(entry.estimatedUsdMicros||undefined,'USD')||formatMicros(entry.estimatedCreditsMicros,'credits')} (Codex estimate${entry.groups?.length?`; ${entry.groups.map(group=>[group.model,group.reasoningEffort,group.speed].filter(Boolean).join(' · ')).join(', ')}`:''})`:`${label}: ${entry?.creditStatus==='unavailable'?'unavailable':'not reported'}`;
    const allowance=entry?.allowance;
    return `${label}: 5-hour ${allowance?.fiveHourPercent===null||allowance?.fiveHourPercent===undefined?'unavailable':`~${allowance.fiveHourPercent.toFixed(2)}%`}; weekly ${allowance?.weeklyPercent===null||allowance?.weeklyPercent===undefined?'unavailable':`~${allowance.weeklyPercent.toFixed(2)}%`}`;
  };
  const Datum=({label,value,metric}:{label:string;value:string;metric:'tokens'|'cost'|'allowance'})=>{const tooltipId=`pass-usage-${pass.id}-${metric}`;return <span className="pass-usage-datum" tabIndex={0} aria-label={`${label}: ${value}`} aria-describedby={tooltipId}><strong>{label}</strong><span>{value}</span><span id={tooltipId} className="pass-usage-tooltip" role="tooltip">{roles.map(([role,name])=><span key={`${metric}-${role}`}>{detail(role,name,metric)}</span>)}{metric==='allowance'&&<small>Approximate change in the shared Codex account snapshot during each role’s turns; activity in other Codex clients can affect it.</small>}</span></span>;};
  return <section className="pass-usage" aria-label={`Usage summary for pass ${pass.index}`}>
    <strong className="pass-usage-title">Pass usage</strong><div className="pass-usage-summary">
      <Datum label="Total tokens" value={tokenHeadline} metric="tokens"/>
      <Datum label="Estimated cost" value={creditHeadline} metric="cost"/>
      <Datum label="Codex allowance" value={allowanceHeadline} metric="allowance"/>
      <small>Codex-reported estimates; allowance percentages are approximate shared-account snapshot changes.</small>
    </div>
  </section>;
}
function ApprovalCard({request,onDecision}:{request:any;onDecision:(decision:'accept'|'decline'|'cancel')=>void}){const permission=request.method==='item/permissions/requestApproval';return <section className="approval-card" aria-label="Codex approval needed"><div className="approval-heading"><ShieldCheck size={15}/><strong>Approval needed</strong><span>{permission?'Permission request':request.method.includes('fileChange')?'File change':'Command execution'}</span></div>{request.reason&&<p>{request.reason}</p>}{request.command&&<pre>{request.command}</pre>}{request.networkHost&&<div className="approval-meta">Network destination: {request.networkHost} ({request.networkProtocol})</div>}{request.cwd&&<div className="approval-meta">Working directory: {request.cwd}</div>}{request.grantRoot&&<div className="approval-meta">Requested write root: {request.grantRoot}</div>}{permission&&<pre className="permission-preview">{JSON.stringify(request.permissionRequest,null,2)}</pre>}<div className="approval-actions"><button onClick={()=>onDecision('decline')}>Decline</button><button onClick={()=>onDecision('cancel')}>Cancel turn</button><button className="approval-accept" onClick={()=>onDecision('accept')}>{permission?'Grant requested permissions':'Approve once'}</button></div></section>}
function Disclosure({title,icon,open,onToggle,children}:{title:string;icon:React.ReactNode;open:boolean;onToggle:()=>void;children:React.ReactNode}){return <div className={`disclosure ${open?'open':''}`}><button className="disclosure-head" onClick={onToggle} aria-expanded={open}><span className="disclosure-icon">{icon}</span><strong>{title}</strong><ChevronDown size={14} className="disclosure-chevron"/><span className="disclosure-spacer"/></button><div className="disclosure-panel" aria-hidden={!open} inert={!open}><div className="disclosure-panel-inner"><div className="disclosure-content">{children}</div></div></div></div>}
function AssignmentView({assignment:a}:{assignment:Assignment}){const data:[string,string[]][]=[['Outcome',[a.outcome,a.deliverable]],['Authorized read scope',a.read_scope],['Authorized write scope',a.write_scope],['Constraints',a.constraints],['Acceptance',a.acceptance],['Verification',a.verification],['Escalate when',a.escalation_conditions],['Exclusions',a.exclusions]];return <div className="assignment-grid">{data.map(([label,items])=><div key={label} className="assignment-block"><span>{label}</span><ul>{items.map((x,i)=><li key={i}>{x}</li>)}</ul></div>)}</div>;}
function RunReceipt({pass:p,taskId,gitEnabled}:{pass:TaskPass;taskId:string;gitEnabled:boolean}){
  const receipt=p.receipt;
  return <div className="run-receipt-content">
    <div className={`receipt-status ${receipt?.status||'unavailable'}`}>{receipt?.status||'No worker receipt'}</div>
    {!receipt?<p className="receipt-unavailable">This pass has no Pseudoharness worker receipt to summarize.</p>:<>
      <WorkspaceGitDiff key={`${taskId}:${p.id}`} taskId={taskId} enabled={gitEnabled}/>
      <div className="receipt-change-grid"><div><b>Worker-reported repository changes</b>{list(receipt.changes)}</div><div><b>Knowledge base changes</b>{list(receipt.knowledge?.updated)}</div></div>
      <div className="receipt-acceptance-grid"><div><b>Acceptance met</b>{list(receipt.acceptance?.met)}</div><div><b>Unmet</b>{list(receipt.acceptance?.unmet)}</div></div>
      <div className="receipt-verification"><b>Verification</b>{receipt.verification?.length?<ul>{receipt.verification.map((item,index)=><li key={index}><span className={`check-state ${item.result}`}>{item.result==='passed'?'✓':item.result==='failed'?'!':'·'}</span><span>{item.check}{item.evidence&&<small>{item.evidence}</small>}</span></li>)}</ul>:<div className="none">Not reported</div>}</div>
      {receipt.risks?.length>0&&<div className="receipt-risks"><b>Risks and limits</b>{list(receipt.risks)}</div>}
      {receipt.decision_required&&<div className="decision-line">Decision required: {receipt.decision_required}</div>}
    </>}
  </div>;
}
function list(items:string[]=[]){return items.length?<ul>{items.map((v,i)=><li key={i}>{v}</li>)}</ul>:<div className="none">None</div>;}
