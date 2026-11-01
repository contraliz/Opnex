import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Folder } from 'lucide-react';
import type { ForgeAccessMode, ForgeTicket, ForgeTicketCreateRequest, Project, Runtime, Settings } from '../types.js';
import { createForgeTicket, api } from './api.js';
import { codexModelChoices } from './ModelPicker.js';
import ModelPicker from './ModelPicker.js';
import type { SkillSummary } from './skills-types.js';

type SkillSearch={skills?:SkillSummary[]};
type Props={project:Project|null;settings:Settings;models:Runtime['codex']['models'];onCreated:(ticket:ForgeTicket)=>void|Promise<void>;onOpenSkills:()=>void;onOpenWorkspace:()=>void};
type Limits={maxActiveWorkers:number;maxExecutionAttempts:number;maxCorrectionRounds:number};
type KnowledgeBudget={totalOperations:number;defaultAllocationOperations:number;maxAllocationOperations:number};

const lines=(value:string)=>value.split(/\r?\n/).map(row=>row.trim()).filter(Boolean);
const initialAccessMode=(policy:Settings['approvalPolicy']):ForgeAccessMode=>policy==='full-access'?'full-access':policy==='never'?'workspace-write':'workspace-write-approval';
const accessHelp:Record<ForgeAccessMode,string>={
  'read-only':'Workers cannot write; the ticket can still plan and review.',
  'workspace-write':'Writes stay inside the accepted scope; boundary attempts stop immediately without prompting.',
  'workspace-write-approval':'Writes stay inside the accepted scope, and a boundary attempt waits for your approval.',
  'full-access':'No sandbox. Anything the worker process can reach is writable.',
};
const deriveTitle=(value:string)=>{
  const first=value.split(/\r?\n/).map(row=>row.trim().replace(/^[#>*\-\s]+/,'').trim()).find(Boolean)||'';
  return (first||'Untitled Forge ticket').slice(0,120);
};

export default function ForgeSessionCreate({project,settings,models,onCreated,onOpenSkills,onOpenWorkspace}:Props){
  const [title,setTitle]=useState('');
  const [description,setDescription]=useState('');
  const [acceptanceText,setAcceptanceText]=useState('');
  const [readText,setReadText]=useState('.');
  const [writeText,setWriteText]=useState('.');
  const [accessMode,setAccessMode]=useState<ForgeAccessMode>(()=>initialAccessMode(settings.approvalPolicy));
  const [targetBranch,setTargetBranch]=useState('main');
  const [orchestratorModel,setOrchestratorModel]=useState(settings.orchestratorModel);
  const [orchestratorEffort,setOrchestratorEffort]=useState(settings.orchestratorEffort);
  const [selectedSkillIds,setSelectedSkillIds]=useState<string[]>([]);
  const [librarySkills,setLibrarySkills]=useState<SkillSummary[]>([]);
  const [libraryStatus,setLibraryStatus]=useState<'loading'|'ready'|'unavailable'>('loading');
  const [agentmemStatus,setAgentmemStatus]=useState<'loading'|'found'|'missing'|'unavailable'>('loading');
  const [agentmemSource,setAgentmemSource]=useState('');
  const [skillError,setSkillError]=useState('');
  const [skillRefresh,setSkillRefresh]=useState(0);
  const [limits,setLimits]=useState<Limits>({maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3});
  const [knowledgeBudget,setKnowledgeBudget]=useState<KnowledgeBudget>({totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8});
  const [working,setWorking]=useState(false);
  const [error,setError]=useState('');

  useEffect(()=>{
    if(!project||project.needsLocation||!project.projectRoot){setAgentmemStatus('unavailable');setLibraryStatus('unavailable');return;}
    const controller=new AbortController();let current=true;
    setAgentmemStatus('loading');setLibraryStatus('loading');setSkillError('');
    const agentmemUrl=`/api/skills?source=codex&q=agentmem-project&limit=50&projectId=${encodeURIComponent(project.id)}`;
    void Promise.allSettled([api<SkillSearch>(agentmemUrl,undefined,controller.signal),api<SkillSearch>('/api/skills?limit=100',undefined,controller.signal)]).then(([configured,saved])=>{
      if(!current)return;
      const savedSkills=saved.status==='fulfilled'?(saved.value.skills||[]).filter(skill=>!skill.archived).slice(0,100):[];
      setLibrarySkills(savedSkills);setLibraryStatus(saved.status==='fulfilled'?'ready':'unavailable');
      const isAgentmem=(skill:SkillSummary)=>skill.name.trim().toLocaleLowerCase()==='agentmem-project';
      const configuredMatch=configured.status==='fulfilled'?(configured.value.skills||[]).find(isAgentmem):undefined;
      const libraryMatch=savedSkills.find(isAgentmem);
      if(configuredMatch){setAgentmemSource(configuredMatch.source||'Configured Codex skill');setAgentmemStatus('found');}
      else if(libraryMatch){setAgentmemSource('Opnex skill library');setAgentmemStatus('found');}
      else if(configured.status==='rejected'&&!controller.signal.aborted){setAgentmemStatus('unavailable');setSkillError(String(configured.reason));}
      else setAgentmemStatus('missing');
    });
    return()=>{current=false;controller.abort();};
  },[project?.id,project?.projectRoot,project?.needsLocation,skillRefresh]);

  const choices=useMemo(()=>codexModelChoices(models),[models]);
  const selectedModel=choices.find(choice=>choice.id===orchestratorModel);
  const effortChoices=selectedModel?.efforts||[];
  const acceptanceCriteria=lines(acceptanceText),readScope=lines(readText),writeScope=lines(writeText);
  const limitsValid=Number.isInteger(limits.maxActiveWorkers)&&limits.maxActiveWorkers>=1&&limits.maxActiveWorkers<=3&&Number.isInteger(limits.maxExecutionAttempts)&&limits.maxExecutionAttempts>=1&&limits.maxExecutionAttempts<=2&&Number.isInteger(limits.maxCorrectionRounds)&&limits.maxCorrectionRounds>=0&&limits.maxCorrectionRounds<=3;
  const budgetValid=Number.isInteger(knowledgeBudget.totalOperations)&&knowledgeBudget.totalOperations>=0&&knowledgeBudget.totalOperations<=100000&&Number.isInteger(knowledgeBudget.defaultAllocationOperations)&&knowledgeBudget.defaultAllocationOperations>=0&&knowledgeBudget.defaultAllocationOperations<=8&&Number.isInteger(knowledgeBudget.maxAllocationOperations)&&knowledgeBudget.maxAllocationOperations>=0&&knowledgeBudget.maxAllocationOperations<=8&&knowledgeBudget.defaultAllocationOperations<=knowledgeBudget.maxAllocationOperations;
  const workspaceUsable=!!project&&!project.needsLocation&&!!project.projectRoot.trim();
  const activeAgentmemStatus=workspaceUsable?agentmemStatus:'unavailable';
  const formReady=workspaceUsable&&activeAgentmemStatus==='found'&&!!description.trim()&&limitsValid&&budgetValid&&libraryStatus!=='loading'&&selectedSkillIds.length<=12&&!!selectedModel?.available&&effortChoices.includes(orchestratorEffort);

  const refreshSkills=()=>{setSkillRefresh(value=>value+1);};
  const changeLimit=(field:keyof Limits,value:string)=>setLimits(current=>({...current,[field]:Number(value)}));
  const changeBudget=(field:keyof KnowledgeBudget,value:string)=>setKnowledgeBudget(current=>({...current,[field]:Number(value)}));
  const toggleSkill=(id:string,checked:boolean)=>setSelectedSkillIds(current=>checked?[...current,id].slice(0,12):current.filter(value=>value!==id));

  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!formReady||!project||working)return;
    const request:ForgeTicketCreateRequest={
      projectId:project.id,title:title.trim()||deriveTitle(description),description:description.trim(),acceptanceCriteria,
      scope:{read:readScope.length?readScope:['.'],write:writeScope.length?writeScope:['.'],knowledge:[]},
      orchestrator:{model:orchestratorModel,effort:orchestratorEffort as ForgeTicket['orchestrator']['effort']},
      accessMode,targetBranch:targetBranch.trim()||'main',skillIds:selectedSkillIds,
      limits,knowledgeBudget,
    };
    setWorking(true);setError('');
    try{await onCreated(await createForgeTicket(request));}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setWorking(false);}
  };

  return <form className="forge-create-card" onSubmit={submit} aria-labelledby="forge-create-title">
    <header className="forge-create-heading"><div><div className="forge-kicker"><Folder size={13} aria-hidden="true"/> Forge ticket</div><h1 id="forge-create-title">Create a Forge draft</h1><p>Describe the work. Only the task description is required; everything else has a sensible default.</p></div></header>

    <div className="forge-create-scroll">
      <div className="forge-workspace-summary" aria-label="Forge workspace">
        <Folder size={15} aria-hidden="true"/><div><strong>{project?.name||'No workspace selected'}</strong><code>{project?.projectRoot||'Choose a workspace before creating a Forge ticket.'}</code></div>
        {(!project||project.needsLocation||!project.projectRoot)&&<button type="button" className="forge-inline-action" onClick={onOpenWorkspace}>Choose workspace</button>}
        {project&&!project.needsLocation&&!!project.projectRoot&&<button type="button" className="forge-inline-action" onClick={onOpenWorkspace}>Change directory</button>}
      </div>
      {!workspaceUsable&&<div className="forge-inline-alert" role="status">Choose a workspace with an existing working directory. Forge tickets cannot use the unclassified workspace.</div>}

      <div className={`forge-skill-readiness ${activeAgentmemStatus}`} role={activeAgentmemStatus==='missing'?'alert':'status'}>
        <BookOpen size={15} aria-hidden="true"/><div>
          {activeAgentmemStatus==='loading'?<><strong>Checking the required AgentMem skill…</strong><span>Only this workspace and the configured Codex skill locations are checked.</span></>:null}
          {activeAgentmemStatus==='found'?<><strong>Required AgentMem skill found</strong><span>{agentmemSource?`Available from ${agentmemSource}`:'Available to the configured Codex runtime.'} · Opnex snapshots it for Forge roles.</span></>:null}
          {activeAgentmemStatus==='missing'?<><strong>Required AgentMem skill is missing</strong><span>Install the existing <code>agentmem-project</code> skill under this workspace’s <code>.agents/skills/</code> folder, a configured Codex skill/plugin, or import it into the Opnex Skills library, then check again.</span></>:null}
          {activeAgentmemStatus==='unavailable'?<><strong>Required AgentMem skill availability is unknown</strong><span>{skillError||'Choose a workspace directory before checking its configured skills.'} Recheck after restoring the workspace or configured skill access.</span></>:null}
        </div>
        {(activeAgentmemStatus==='missing'||activeAgentmemStatus==='unavailable')&&<button type="button" className="forge-inline-action" onClick={refreshSkills}>Check again</button>}
      </div>

      {error&&<div className="forge-inline-alert" role="alert">{error}</div>}

      <div className="forge-create-fields">
        <label className="forge-field forge-field-description">
          <span className="forge-field-label">Task description<span className="forge-field-badge">Required</span></span>
          <textarea aria-label="Task description" maxLength={12000} rows={5} value={description} onChange={event=>setDescription(event.currentTarget.value)} placeholder="What should Forge build, fix, or investigate?" required autoFocus/>
          <small className="forge-field-hint">The orchestrator plans from this description. Everything else can stay at its default.</small>
        </label>

        <label className="forge-field">
          <span className="forge-field-label">Ticket title<span className="forge-field-hint">Optional · defaults to the first line of the description</span></span>
          <input aria-label="Ticket title" maxLength={120} value={title} onChange={event=>setTitle(event.currentTarget.value)} placeholder={deriveTitle(description)} autoComplete="off"/>
        </label>

        <label className="forge-field">
          <span className="forge-field-label">Acceptance criteria<span className="forge-field-hint">Optional · one criterion per line</span></span>
          <textarea aria-label="Acceptance criteria" rows={3} value={acceptanceText} onChange={event=>setAcceptanceText(event.currentTarget.value)} placeholder="Leave empty to let the orchestrator derive them from the description."/>
        </label>

        <label className="forge-field">
          <span className="forge-field-label">Ticket access<span className="forge-field-hint">Applies to every role in this ticket</span></span>
          <select aria-label="Ticket access" value={accessMode} onChange={event=>setAccessMode(event.currentTarget.value as ForgeAccessMode)}>
            <option value="read-only">Read-only · all writes blocked</option>
            <option value="workspace-write">Workspace write · auto-block at the scope edge</option>
            <option value="workspace-write-approval">Workspace write · wait for approval</option>
            <option value="full-access">Full access · unrestricted</option>
          </select>
          <small className="forge-field-hint">{accessHelp[accessMode]}</small>
        </label>

        <details className="forge-advanced">
          <summary>Advanced options</summary>
          <div className="forge-advanced-body">
            <div className="forge-scope-fields">
              <label className="forge-field"><span className="forge-field-label">Allowed read scope</span><textarea aria-label="Allowed read scope" rows={2} value={readText} onChange={event=>setReadText(event.currentTarget.value)} placeholder="."/><small className="forge-field-hint">Workspace-relative. “.” means the whole workspace.</small></label>
              <label className="forge-field"><span className="forge-field-label">Allowed write scope</span><textarea aria-label="Allowed write scope" rows={2} value={writeText} onChange={event=>setWriteText(event.currentTarget.value)} placeholder="."/><small className="forge-field-hint">Workspace-relative. Narrow this before starting the ticket.</small></label>
            </div>

            <div className="forge-profile-grid">
              <fieldset className="forge-profile-field"><legend>Orchestrator</legend><div className="forge-profile-model"><ModelPicker label="Orchestrator model" providerKey="codex" model={orchestratorModel} effort={orchestratorEffort} choices={choices} disabled={working} onChange={(choice,effort)=>{setOrchestratorModel(choice.id);setOrchestratorEffort(effort);}}/><label>Effort<select aria-label="Orchestrator effort" value={orchestratorEffort} disabled={working||!effortChoices.length} onChange={event=>setOrchestratorEffort(event.currentTarget.value)}>{effortChoices.map(value=><option value={value} key={value}>{value}</option>)}</select></label></div><small className="forge-field-hint">Defaults to the planner model in Settings.</small></fieldset>
              <label className="forge-field"><span className="forge-field-label">Local target branch</span><input aria-label="Local target branch" maxLength={240} value={targetBranch} onChange={event=>setTargetBranch(event.currentTarget.value)} placeholder="main"/><small className="forge-field-hint">Pinned at creation. No remote branch is pushed.</small></label>
            </div>

            <section className="forge-ticket-skills" aria-labelledby="forge-ticket-skills-title"><header><div><h2 id="forge-ticket-skills-title">Additional ticket skills</h2><p>The required AgentMem skill is added separately. Select up to 12 saved Opnex skills for the orchestrator’s assignments.</p></div><button type="button" className="forge-inline-action" onClick={onOpenSkills}>Open Skills library</button></header>
              {libraryStatus==='loading'?<span role="status">Loading saved skills…</span>:libraryStatus==='unavailable'?<span role="status">The optional skills library is unavailable; you can still create this ticket without additional skills.</span>:librarySkills.length?<div className="forge-skill-options">{librarySkills.map(skill=><label className="forge-skill-option" key={skill.id}><input type="checkbox" checked={selectedSkillIds.includes(skill.id)} disabled={working||(!selectedSkillIds.includes(skill.id)&&selectedSkillIds.length>=12)} onChange={event=>toggleSkill(skill.id,event.currentTarget.checked)}/><span><strong>{skill.name}</strong><small>{skill.description||'Saved skill'} · revision {skill.revision.slice(0,12)}</small></span></label>)}</div>:<span role="status">No saved Opnex skills are available. The required AgentMem skill remains separate.</span>}
            </section>

            <section className="forge-ticket-limits" aria-labelledby="forge-ticket-limits-title">
              <div className="forge-field-label"><h2 id="forge-ticket-limits-title">Ticket limits</h2><span className="forge-field-hint">Defaults are safe; change them only when the ticket needs it.</span></div>
              <div className="forge-limit-grid">
                <label>Maximum active workers<input aria-label="Maximum active workers" type="number" min={1} max={3} value={limits.maxActiveWorkers} disabled={working} onChange={event=>changeLimit('maxActiveWorkers',event.currentTarget.value)}/><small>1–3 workers</small></label>
                <label>Execution attempts per work item<input aria-label="Execution attempts per work item" type="number" min={1} max={2} value={limits.maxExecutionAttempts} disabled={working} onChange={event=>changeLimit('maxExecutionAttempts',event.currentTarget.value)}/><small>1–2 attempts total</small></label>
                <label>Integrator correction rounds<input aria-label="Integrator correction rounds" type="number" min={0} max={3} value={limits.maxCorrectionRounds} disabled={working} onChange={event=>changeLimit('maxCorrectionRounds',event.currentTarget.value)}/><small>0–3 rounds</small></label>
                <label>Total knowledge operations<input aria-label="Total knowledge operations" type="number" min={0} max={100000} value={knowledgeBudget.totalOperations} disabled={working} onChange={event=>changeBudget('totalOperations',event.currentTarget.value)}/><small>Shared across the ticket</small></label>
                <label>Default allocation per run<input aria-label="Default allocation per run" type="number" min={0} max={8} value={knowledgeBudget.defaultAllocationOperations} disabled={working} onChange={event=>changeBudget('defaultAllocationOperations',event.currentTarget.value)}/><small>Default 2</small></label>
                <label>Maximum allocation per run<input aria-label="Maximum allocation per run" type="number" min={0} max={8} value={knowledgeBudget.maxAllocationOperations} disabled={working} onChange={event=>changeBudget('maxAllocationOperations',event.currentTarget.value)}/><small>At most 8</small></label>
              </div>
              {!budgetValid&&<p className="forge-inline-alert" role="alert">The default knowledge allocation cannot exceed the maximum allocation.</p>}
            </section>
          </div>
        </details>
      </div>
    </div>

    <footer className="forge-create-footer">
      <span className="forge-create-note">Task description is the only required field.</span>
      <button type="submit" className="forge-primary-action" disabled={!formReady||working}>{working?'Creating draft…':'Create draft'}</button>
    </footer>
  </form>;
}
