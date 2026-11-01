import { useState } from 'react';
import { AlertCircle, Check, GitBranch, RefreshCw, Square, Terminal } from 'lucide-react';
import type { ForgeTicket, ForgeTicketPhase, Task } from '../types.js';
import { forgeTicketAction, getForgeTicket } from './api.js';
import { ToolCallLogView, toolCallLogTitle } from './ToolCallLogView.js';

type Props={ticket:ForgeTicket;task:Task;onTicketChange:(ticket:ForgeTicket)=>void};
const phaseLabel=(phase:ForgeTicketPhase)=>phase.replaceAll('_',' ');
const effortLabel=(profile:{provider:string;model:string;effort:string})=>`${profile.provider==='codex'?'Codex':profile.provider==='deepseek'?'DeepSeek Harness':profile.provider} · ${profile.model} · ${profile.effort}`;
const receiptStatus=(status:string)=>status.replaceAll('_',' ');
const accessLabel=(ticket:ForgeTicket)=>{
  if(!ticket.accessMode)return ticket.approvalPolicy.replaceAll('-',' ');
  return ({'read-only':'Read-only','workspace-write':'Workspace write · auto-block','workspace-write-approval':'Workspace write · approval','full-access':'Full access'} as Record<string,string>)[ticket.accessMode]||ticket.accessMode;
};
const blockedLabel=(code:string)=>({attempt_failed:'Attempt failed',retry_limit:'Retry limit reached',unknown_after_restart:'Needs reconciliation after restart',unknown_effect:'Provider start status is uncertain',preflight_failed:'Execution preflight failed',unverified_commit:'Commit validation failed',manual:'Needs attention',correction_limit:'Correction limit reached'} as Record<string,string>)[code]||code.replaceAll('_',' ');
const capabilityLabel=(value:string)=>value==='instruction-only'?'Instruction-only':value==='unavailable'?'Unavailable':value==='monitored'?'Monitored':'Enforced';
const capabilityExplanation=(key:string,value:string)=>{
  if(value==='unavailable')return 'This capability is unavailable for the selected runtime.';
  if(value==='instruction-only')return key==='filesystemWriteScope'?'The worktree organizes changes, but it does not confine filesystem access.':key==='knowledgeScope'?'The selected knowledge scope is guidance unless the external skill interface enforces it.':key==='operationBudget'?'The ticket budget is guidance unless the external skill interface enforces it.':'This limit is supplied as an instruction; Opnex has not reported hard enforcement.';
  if(value==='monitored')return 'The runtime can observe and report this behavior, but may not prevent every in-flight effect.';
  return 'The runtime reports this capability as enforced.';
};
const capabilityRows=[
  ['filesystemWriteScope','Filesystem write scope'],['knowledgeScope','Knowledge scope'],['operationBudget','Knowledge operation budget'],
  ['toolAuthorization','Opnex tool authorization'],['cancellation','Cancellation'],['commitScopeValidation','Commit scope validation'],['finalMergeGate','Final merge gate'],
] as const;

export function ForgeBoard({ticket,task,onTicketChange}:Props){
  const [pending,setPending]=useState('');
  const [error,setError]=useState('');
  const [toolsOpen,setToolsOpen]=useState(false);
  const activePlan=ticket.acceptedPlan||ticket.proposedPlan;
  const plannedTasks=activePlan?.tasks||[];
  const plannedById=new Map(plannedTasks.map(row=>[row.id,row]));
  const counts=ticket.workitems.reduce((result,item)=>{result[item.state]++;return result;},{open:0,claimed:0,finished:0,blocked:0});
  const latestReview=ticket.integration.reviewDecisions.at(-1);
  const openPhase=['planning','running','integrating','review','merge_ready','merging'].includes(ticket.phase);
  const terminal=ticket.phase==='complete'||ticket.phase==='cancelled';

  const updateAction=async(action:'start'|'pause'|'resume'|'cancel',body:Record<string,unknown>={})=>{
    if(pending)return;setPending(action);setError('');
    try{onTicketChange(await forgeTicketAction(ticket.id,action,body));}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setPending('');}
  };
  const refresh=async()=>{
    if(pending)return;setPending('refresh');setError('');
    try{onTicketChange(await getForgeTicket(ticket.id));}
    catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setPending('');}
  };

  return <section className="forge-board" aria-labelledby="forge-board-title" data-ticket-phase={ticket.phase}>
    <header className="forge-board-header"><div><span className="forge-kicker"><GitBranch size={13} aria-hidden="true"/> Forge · {ticket.targetBranch}</span><h1 id="forge-board-title">{ticket.title}</h1><p>{ticket.description}</p></div><div className="forge-board-header-actions"><span className={`forge-phase-badge phase-${ticket.phase}`}>{phaseLabel(ticket.phase)}</span><button type="button" className="forge-icon-action" aria-label="Refresh Forge ticket" title="Refresh ticket" disabled={!!pending} onClick={()=>void refresh()}><RefreshCw size={14}/></button></div></header>
    {error&&<div className="forge-inline-alert" role="alert"><AlertCircle size={15}/><span>{error}</span></div>}
    {ticket.attentionReason&&<div className="forge-attention" role="status"><AlertCircle size={15}/><div><strong>Ticket needs attention</strong><span>{ticket.attentionReason}</span>{ticket.phase==='blocked'&&<small>Forge will not start a duplicate attempt while the saved run or provider effect needs reconciliation.</small>}</div></div>}

    <section className="forge-ticket-summary" aria-label="Ticket summary">
      <div><span>Workspace</span><strong>{ticket.workspaceRoot}</strong></div>
      <div><span>Orchestrator</span><strong>{ticket.orchestrator.model} · {ticket.orchestrator.effort}</strong></div>
      <div><span>Worker profile</span><strong>{effortLabel(ticket.workerProfile)}</strong></div>
      <div><span>Ticket access</span><strong>{accessLabel(ticket)}</strong></div>
      <div><span>Task limit</span><strong>{ticket.workitems.length || 'Plan up to 16'} / 16 work items</strong></div>
      <div><span>Knowledge budget</span><strong>{ticket.knowledgeBudget.totalOperations} shared · {ticket.knowledgeBudget.defaultAllocationOperations} default / {ticket.knowledgeBudget.maxAllocationOperations} max per run</strong></div>
    </section>

    <div className="forge-board-toolbar" role="group" aria-label="Forge ticket controls">
      {ticket.phase==='draft'&&<button type="button" className="forge-primary-action" disabled={!!pending} onClick={()=>void updateAction('start')}>{pending==='start'?'Starting Forge…':'Start Forge'}</button>}
      {ticket.phase==='paused'&&<button type="button" className="forge-primary-action" disabled={!!pending} onClick={()=>void updateAction('resume')}>{pending==='resume'?'Resuming…':'Resume Forge ticket'}</button>}
      {openPhase&&<button type="button" className="forge-secondary-action" aria-label="Pause Forge ticket" disabled={!!pending} onClick={()=>void updateAction('pause')}><Square size={13}/>Pause</button>}
      {!terminal&&<button type="button" className="forge-danger-action" aria-label="Cancel Forge ticket" disabled={!!pending} onClick={()=>void updateAction('cancel')}>{pending==='cancel'?'Cancelling…':'Cancel ticket'}</button>}
      {pending==='refresh'&&<span role="status">Refreshing ticket…</span>}
    </div>

    {ticket.proposedPlan&&ticket.phase==='planning'&&<section className="forge-proposed-plan" aria-labelledby="forge-plan-title"><header><div><h2 id="forge-plan-title">Validating the proposed plan</h2><p>Revision {ticket.proposedPlan.revision} · {ticket.proposedPlan.tasks.length} work items · a valid plan continues into worker dispatch automatically.</p></div></header><ol>{ticket.proposedPlan.tasks.map(item=><li key={item.id}><div><strong>{item.title}</strong><p>{item.assignment.assignment.outcome}</p><small>{item.dependencyIds.length?`Depends on ${item.dependencyIds.join(', ')}`:'No prerequisites'} · writes: {item.assignment.assignment.write_scope.join(', ')||'none'}</small></div></li>)}</ol></section>}

    <section className="forge-capabilities" aria-labelledby="forge-capabilities-title"><header><h2 id="forge-capabilities-title">Runtime capabilities</h2><p>These labels come from the saved ticket and actual runtime support.</p></header><div className="forge-capability-grid">{capabilityRows.map(([key,label])=>{const value=ticket.capabilities[key];return <div className={`forge-capability capability-${value}`} key={key}><span>{label}</span><strong>{capabilityLabel(value)}</strong><small>{capabilityExplanation(key,value)}</small></div>;})}</div>
      {ticket.workerProfile.provider==='deepseek'&&ticket.capabilities.filesystemWriteScope!=='enforced'&&<p className="forge-capability-note">Strict unattended writes are unavailable for this profile without a supported filesystem confinement layer. Forge does not treat a worktree or Full Access as confinement.</p>}
    </section>

    <section className="forge-workitems" aria-labelledby="forge-workitems-title"><header><div><h2 id="forge-workitems-title">Work items</h2><p>Worker completion is provisional. Finished means a worker receipt and commit were accepted; the ticket completes only after the verified candidate merges into its pinned local target branch.</p></div></header>
      <div className="forge-state-counts" aria-label="Work item state counts">{(['open','claimed','finished','blocked'] as const).map(state=><span className={`forge-state-count state-${state}`} key={state}>{counts[state]} {state}</span>)}</div>
      {ticket.workitems.length?<ol className="forge-workitem-list">{ticket.workitems.map(item=>{
        const plan=plannedById.get(item.id),attempts=item.attemptIds.map(id=>ticket.attempts.find(attempt=>attempt.id===id)).filter((attempt):attempt is NonNullable<typeof attempt>=>!!attempt);
        const current=(item.activeAttemptId?ticket.attempts.find(attempt=>attempt.id===item.activeAttemptId):undefined)||attempts.at(-1);
        const receipt=current?.receiptId?ticket.receipts.find(row=>row.id===current.receiptId):undefined;
        const dependencies=item.dependencyIds.map(id=>({id,title:plannedById.get(id)?.title||id}));
        return <li className={`forge-workitem state-${item.state}`} key={item.id}><header><div><span className={`forge-state-pill state-${item.state}`}>{item.state}</span><h3>{plan?.title||item.id}</h3></div><small>Assignment revision {item.assignmentRevision}</small></header>
          {plan&&<p className="forge-workitem-description">{plan.assignment.assignment.outcome}</p>}
          {!!dependencies.length&&<div className="forge-dependencies"><strong>Dependencies</strong><ul>{dependencies.map(dep=><li key={dep.id}>{dep.title} <code>{dep.id}</code></li>)}</ul></div>}
          {item.blockedReason?.kind==='dependencies'&&<p className="forge-block-reason"><strong>Blocked by dependency</strong> · {item.blockedReason.taskIds.map(id=>plannedById.get(id)?.title||id).join(', ')}</p>}
          {item.blockedReason?.kind==='execution_issue'&&<p className="forge-block-reason execution"><strong>{blockedLabel(item.blockedReason.code)}</strong> · {item.blockedReason.detail}</p>}
          {current&&<div className="forge-attempt-current"><strong>{current.status==='unknown_after_restart'||current.status==='unknown_effect'?'Needs reconciliation':current.status==='claimed'?'Current attempt':'Last attempt'} · {current.id}</strong><div className="forge-attempt-meta"><span>Owner: {current.claim.ownerId}</span><span>Attempt {current.ordinal}</span><span>{effortLabel(current.executionProfile)}</span></div><div className="forge-attempt-meta"><span>Branch: <code>{current.branch}</code></span><span>Worktree: <code>{current.worktreeRoot}</code></span></div>{current.threadId&&<small>Provider thread {current.threadId} · turn {current.turnId||'unavailable'}</small>}{current.preflightFailure&&<p className="forge-block-reason execution">Preflight failed at {current.preflightFailure.stage}: {current.preflightFailure.reason}</p>}{current.knowledgeAllocation&&<small>Knowledge allocation: {current.knowledgeAllocation.operations} · {current.knowledgeAllocation.status}{current.knowledgeAllocation.usage?` · ${current.knowledgeAllocation.usage.operations} reported`:''}</small>}{current.skillSnapshots.length>0&&<small>Skills: {current.skillSnapshots.map(skill=>`${skill.name} · ${skill.revision.slice(0,12)}`).join(', ')}</small>}</div>}
          {receipt&&<ReceiptDetails title={`Worker receipt · ${receipt.id}`} receipt={receipt.receipt} provenance={receipt.provenance} hostCommit={receipt.hostAttestation?.commitSha}/>}
          {attempts.length>0&&<details className="forge-attempt-history"><summary>Attempt history · {attempts.length}</summary><ol>{attempts.map(attempt=><li key={attempt.id}><strong>{attempt.id}</strong><span>{attempt.status} · {attempt.claim.ownerId} · {attempt.executionProfile.model} · {attempt.branch}</span>{attempt.failureReason&&<small>{attempt.failureReason}</small>}{attempt.reconciliation&&<small>Reconciliation: {attempt.reconciliation.status} · {attempt.reconciliation.evidence}</small>}</li>)}</ol></details>}
        </li>;
      })}</ol>:<div className="forge-empty-state">{ticket.phase==='draft'?'The draft is saved and inert. Start Forge to ask the selected orchestrator for a plan.':ticket.phase==='planning'&&ticket.proposedPlan?'Forge is validating the plan and will dispatch eligible workers automatically.':ticket.phase==='planning'?'Planning is in progress or awaiting reconciliation. The board will update from the existing live state stream.':'No work items have been proposed yet.'}</div>}
    </section>

    {!!ticket.orchestratorRuns.length&&<section className="forge-orchestrator-runs" aria-labelledby="forge-orchestrator-runs-title"><header><h2 id="forge-orchestrator-runs-title">Planning and final review runs</h2><p>Saved run metadata and observed provider identity.</p></header><ol>{ticket.orchestratorRuns.map(run=><li key={run.id} className={`forge-run forge-run-${run.status}`}><div><strong>{run.purpose==='planning'?'Planning':'Final review'} · {run.status.replaceAll('_',' ')}</strong><span>{run.requestedProfile.model} · requested {run.requestedProfile.effort}{run.effectiveProfile?` · observed ${run.effectiveProfile.model} · ${run.effectiveProfile.effort}`:''}</span></div><small>Run {run.id} · revision {run.expectedPlanRevision}{run.threadId?` · thread ${run.threadId} · turn ${run.turnId}`:''}</small>{run.purpose==='final_review'&&<small>Candidate {run.candidateSha} · {run.targetBranch} at {run.targetMainSha}</small>}{run.knowledgeAllocation&&<small>Knowledge allocation {run.knowledgeAllocation.operations} · {run.knowledgeAllocation.status}{run.knowledgeAllocation.usage?` · ${run.knowledgeAllocation.usage.operations} reported (${run.knowledgeAllocation.usage.source})`:''}</small>}{run.failureReason&&<p className="forge-block-reason execution">{run.failureReason}</p>}{run.status==='unknown_after_restart'&&<p className="forge-block-reason execution">The saved run may still be live. Reconciliation is required; no duplicate planning or review run will be launched.</p>}</li>)}</ol></section>}

    <section className="forge-integration" aria-labelledby="forge-integration-title"><header><div><h2 id="forge-integration-title">Integration and final review</h2><p>Integrator state: {ticket.integration.status.replaceAll('_',' ')} · target branch: <code>{ticket.targetBranch}</code></p></div></header>
      {ticket.integration.runs.length>0?<ol className="forge-integration-runs">{ticket.integration.runs.map(run=>{
        const candidate=ticket.integration.candidates.find(row=>row.id===run.candidateId);
        return <li key={run.id} className="forge-run"><div><strong>Integrator run · {run.status.replaceAll('_',' ')}</strong><span>{effortLabel(run.effectiveProfile||run.requestedProfile)}</span></div><small>Branch: <code>{run.branch}</code> · target <code>{run.targetBranch}</code></small><small>Worktree: <code>{run.worktreeRoot}</code> · base {run.sourceBaselineSha}</small>{run.threadId&&<small>Observed provider run: {run.threadId} · {run.turnId}</small>}{run.knowledgeAllocation&&<small>Knowledge allocation {run.knowledgeAllocation.operations} · {run.knowledgeAllocation.status}{run.knowledgeAllocation.usage?` · ${run.knowledgeAllocation.usage.operations} reported`:''}</small>}{run.failureReason&&<p className="forge-block-reason execution">{run.failureReason}</p>}{run.status==='unknown_after_restart'&&<p className="forge-block-reason execution">Integrator status needs reconciliation. No duplicate integration run will start automatically.</p>}{candidate&&<CandidateDetails candidate={candidate} run={run}/>}</li>;
      })}</ol>:<div className="forge-empty-state">Integration starts after every work item is finished. No integration run is recorded yet.</div>}
      {!!ticket.integration.correctionRounds.length&&<details className="forge-corrections"><summary>Correction history · {ticket.integration.correctionRounds.length} rounds</summary><ol>{ticket.integration.correctionRounds.map(round=><li key={round.id}><strong>{round.source.replaceAll('_',' ')} · round {round.index}</strong><small>Candidate {round.candidateId} · requested by {round.requestedBy}</small><ul>{round.findings.map(finding=><li key={finding.id}>{finding.title} · {finding.taskId}</li>)}</ul></li>)}</ol></details>}
      {!!ticket.integration.reviewDecisions.length&&<div className="forge-review-decisions"><h3>Orchestrator review decisions</h3><ol>{ticket.integration.reviewDecisions.map(decision=><li key={decision.id}><strong>{decision.disposition.replaceAll('_',' ')}</strong><span>{decision.note}</span><small>Candidate {decision.candidateSha} · {decision.targetBranch} at {decision.targetMainSha} · {decision.reviewedAt}</small></li>)}</ol></div>}
      {ticket.integration.mergeIntent&&<div className="forge-merge-state"><strong>Local merge in progress</strong><span>{ticket.integration.mergeIntent.candidateSha} → {ticket.integration.mergeIntent.targetBranch} at {ticket.integration.mergeIntent.targetMainSha}</span><small>Requested by {ticket.integration.mergeIntent.startedBy} · {ticket.integration.mergeIntent.startedAt}</small></div>}
      {!!ticket.integration.mergeReadbacks.length&&<div className="forge-merge-state"><strong>{ticket.phase==='complete'?'Ticket complete after local merge read-back':'Local merge read-back'}</strong><ol>{ticket.integration.mergeReadbacks.map(readback=><li key={readback.id}><span>{readback.result} · {readback.targetBranch} · candidate {readback.candidateSha}</span><small>Observed {readback.observedMainSha}{readback.mergeCommitSha?` · merge commit ${readback.mergeCommitSha}`:''}{readback.commitReadbackSha?` · read-back ${readback.commitReadbackSha}`:''}{readback.detail?` · ${readback.detail}`:''}</small></li>)}</ol></div>}
      {latestReview?.disposition==='accept'&&ticket.phase!=='complete'&&<p className="forge-review-note">The orchestrator accepted this candidate. The ticket remains open until the host verifies the guarded local merge and reads back the merge commit.</p>}
    </section>

    <details className="forge-tool-calls" open={toolsOpen} onToggle={event=>setToolsOpen(event.currentTarget.open)}><summary><Terminal size={14} aria-hidden="true"/>{toolCallLogTitle(task.toolCalls)}</summary><ToolCallLogView log={task.toolCalls}/></details>
    <footer className="forge-board-footer"><span>Acceptance criteria</span><ul>{ticket.acceptanceCriteria.map((criterion,index)=><li key={`${criterion}:${index}`}>{criterion}</li>)}</ul><span>Allowed scope</span><ScopeList scope={ticket.scope}/></footer>
  </section>;
}

function CandidateDetails({candidate,run}:{candidate:ForgeTicket['integration']['candidates'][number];run:ForgeTicket['integration']['runs'][number]}){
  return <section className="forge-candidate"><h3>Integration candidate</h3><p className="forge-candidate-branch">Candidate branch <code>{run.branch}</code> · pinned target <code>{candidate.targetBranch}</code></p><dl><dt>Candidate</dt><dd><code>{candidate.candidateSha}</code></dd><dt>Target SHA</dt><dd><code>{candidate.targetMainSha}</code></dd><dt>Scope validation</dt><dd>{candidate.scopeValidation.status} · {candidate.scopeValidation.evidence.join('; ')}</dd></dl>
    <div className="forge-verification"><strong>Checks and QA</strong><ul>{candidate.verification.map((check,index)=><li key={`${check.check}:${index}`} className={`result-${check.result}`}><span>{check.result==='passed'?<Check size={13}/>:check.result==='failed'?<AlertCircle size={13}/>:<Square size={12}/>}</span><strong>{check.check}</strong><small>{check.result}{check.evidence?` · ${check.evidence}`:''}</small></li>)}</ul></div>
    <div className="forge-worker-commits"><strong>Included worker commits</strong><ul>{candidate.workerCommits.map(commit=><li key={`${commit.taskId}:${commit.attemptId}`}><span>{commit.taskId} · {commit.attemptId}</span><code>{commit.commitSha}</code><small>Receipt {commit.receiptId}</small></li>)}</ul></div>
    {!!candidate.findings.length&&<div className="forge-findings"><strong>Integrator findings</strong><ul>{candidate.findings.map(finding=><li key={finding.id}><span>{finding.title}{finding.taskId?` · ${finding.taskId}`:''}</span><small>{finding.issue} · Required: {finding.requiredFix}</small><small>Evidence: {finding.evidence.join('; ')}</small></li>)}</ul></div>}
    <ReceiptDetails title="Combined integrator receipt" receipt={candidate.combinedReceipt} provenance={candidate.provenance}/>
  </section>;
}

function ReceiptDetails({title,receipt,provenance,hostCommit}:{title:string;receipt:ForgeTicket['receipts'][number]['receipt'];provenance:ForgeTicket['receipts'][number]['provenance'];hostCommit?:string}){
  return <details className="forge-receipt"><summary>{title} · {receiptStatus(receipt.status)}</summary><div className="forge-receipt-body"><p>{receipt.result}</p><dl><dt>Producer</dt><dd>{provenance.producerRole} · {provenance.threadId} · {provenance.turnId}</dd><dt>Artifacts</dt><dd>{provenance.artifactRefs.join(', ')||'None recorded'}</dd>{hostCommit&&<><dt>Host-verified commit</dt><dd><code>{hostCommit}</code></dd></>}</dl>{!!receipt.changes.length&&<div><strong>Changes</strong><ul>{receipt.changes.map((change,index)=><li key={`${change}:${index}`}>{change}</li>)}</ul></div>}<div><strong>Acceptance</strong><ul>{receipt.acceptance.met.map((item,index)=><li key={`met:${index}`}><Check size={12}/> {item}</li>)}{receipt.acceptance.unmet.map((item,index)=><li key={`unmet:${index}`} className="is-error"><AlertCircle size={12}/> {item}</li>)}</ul></div><div><strong>Verification</strong><ul>{receipt.verification.map((item,index)=><li key={`${item.check}:${index}`}>{item.result} · {item.check}{item.evidence?` · ${item.evidence}`:''}</li>)}</ul></div>{!!receipt.risks.length&&<div><strong>Risks</strong><ul>{receipt.risks.map((risk,index)=><li key={`${risk}:${index}`}>{risk}</li>)}</ul></div>}</div></details>;
}

function ScopeList({scope}:{scope:ForgeTicket['scope']}){
  return <dl className="forge-scope-list">{(['read','write','knowledge'] as const).map(key=><div key={key}><dt>{key}</dt><dd>{scope[key].length?scope[key].join(', '):'None'}</dd></div>)}</dl>;
}
