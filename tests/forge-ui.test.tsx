// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyForgeCommand, createForgeTicket } from '../server/forge-state.js';
import type { ForgeIntegrationCandidate, ForgePlanTaskInput, ForgeTicket } from '../server/forge-contracts.js';
import { createToolCallLog } from '../server/tool-call-log.js';
import type { AppState, ForgeTicketCreateRequest, Project, Runtime, Task } from '../src/types.js';
import { ForgeBoard } from '../src/ui/ForgeBoard.js';
import App from '../src/ui/App.js';

const project:Project={id:'11111111-1111-4111-8111-111111111111',name:'Demo workspace',projectRoot:'D:/workspace/demo',needsLocation:false,pinned:false,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
const at='2026-10-31T00:00:00.000Z';
const runtime:Runtime={codex:{state:'connected',error:'',models:[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',efforts:['low','high']},{id:'gpt-6.1-terra',displayName:'GPT-6.1 Terra',efforts:['low','high']},{id:'gpt-6-luna',displayName:'GPT-6 Luna',efforts:['high','max']}],workerAvailable:true}};
const settings=()=>({orchestratorModel:'gpt-6.1-terra',orchestratorEffort:'low' as const,approvalPolicy:'on-request' as const,executionProfile:{provider:'codex' as const,model:'gpt-6-luna',effort:'max' as const}});
const baseState=():AppState=>({version:7,revision:1,settings:settings(),tasks:[],activeTaskId:null,projects:[project],selectedProjectId:project.id,expandedProjectIds:[project.id,'unclassified']});
const assignment=(write_scope:string[]=['src'])=>({
  outcome:'Implement the assigned change.',deliverable:'Changed source files.',read_scope:['src'],write_scope,exclusions:[],constraints:[],context_refs:[],
  acceptance:['The behavior works.'],verification:['Focused tests pass.'],ordinary_authority:['Make ordinary implementation decisions.'],
  escalation_conditions:['The accepted scope must change.'],receipt_requirements:['Return a complete receipt.'],
});
const planTask=(id:string,dependencyIds:string[]=[]):ForgePlanTaskInput=>({
  id,title:id,description:`Implement ${id}.`,dependencyIds,assignment:assignment(),knowledgeScope:['knowledge/opnex'],
  executionProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},skillSnapshots:[],
});
const workerReceipt=(status:'complete'|'failed'='complete')=>({
  status,result:'The assigned work was reviewed.',changes:['src/change.ts'],acceptance:{met:['The behavior works.'],unmet:[]},
  verification:[{check:'Focused tests',result:'passed' as const,evidence:'2 passed'}],risks:[],knowledge:{consulted:['forge-sessions-design'],updated:[]},decision_required:null,
});
const createDraft=(id='ticket-a'):ForgeTicket=>createForgeTicket({
  id,projectId:project.id,workspaceRoot:project.projectRoot,title:'Forge lifecycle',description:'Implement the requested lifecycle.',
  acceptanceCriteria:['Persist valid state.'],scope:{read:['src'],write:['src'],knowledge:['knowledge/opnex']},
  orchestrator:{model:'gpt-6.1-terra',effort:'low'},workerProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},orchestratorSkills:[],
  approvalPolicy:'on-request',targetBranch:'main',limits:{maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},
  knowledgeBudget:{totalOperations:64,defaultAllocationOperations:2,maxAllocationOperations:8},
  capabilities:{filesystemWriteScope:'instruction-only',knowledgeScope:'instruction-only',toolAuthorization:'instruction-only',cancellation:'monitored',commitScopeValidation:'enforced',finalMergeGate:'enforced'},createdAt:at,
});
const claim=(ticket:ForgeTicket,taskId:string,ownerId:string,attemptId:string)=>{
  const claimed=applyForgeCommand(ticket,{type:'claim_task',actor:{role:'host',id:'scheduler'},taskId,ownerId,claimId:`claim-${attemptId}`,attemptId,claimToken:`token-${attemptId}`,runtimeId:`runtime-${attemptId}`,branch:`forge/${taskId}/${attemptId}`,worktreeRoot:`D:/workspace/demo/.forge/${attemptId}`,sourceBaselineSha:'a'.repeat(40)},at);
  const prepared=applyForgeCommand(claimed,{type:'record_attempt_dispatch_baseline',actor:{role:'host',id:'scheduler'},taskId,ownerId,attemptId,claimToken:`token-${attemptId}`,dispatchBaselineSha:'b'.repeat(40)},at);
  return applyForgeCommand(prepared,{type:'record_attempt_runtime',actor:{role:'host',id:'scheduler'},taskId,ownerId,attemptId,claimToken:`token-${attemptId}`,threadId:`thread-${attemptId}`,turnId:`turn-${attemptId}`},at);
};
const outcome=(ticket:ForgeTicket,taskId:string,ownerId:string,attemptId:string,status:'complete'|'failed'='complete')=>{
  const commitSha=attemptId==='attempt-finished'?'d'.repeat(40):'e'.repeat(40);
  return applyForgeCommand(ticket,{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId,ownerId,attemptId,claimToken:`token-${attemptId}`,outcomeId:`outcome-${attemptId}`,receiptId:`receipt-${attemptId}`,receipt:workerReceipt(status),
    provenance:{producerRole:'worker',workerId:ownerId,threadId:`thread-${attemptId}`,turnId:`turn-${attemptId}`,recordedAt:at,artifactRefs:['src/change.ts']},
    ...(status==='complete'?{hostAttestation:{status:'verified' as const,commitObserved:true,scopeValidation:'passed' as const,commitSha,observedAt:at,evidenceRefs:['git show --stat']}}:{}),
    retryable:true,...(status==='failed'?{failureReason:'The attempt did not complete.'}:{})},at);
};
const withFourWorkitemStates=()=>{
  let ticket=createDraft();
  ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('claimed-task'),planTask('dependency-task',['claimed-task']),planTask('finished-task'),planTask('failure-task'),planTask('open-task')]},at);
  ticket=applyForgeCommand(ticket,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
  ticket=applyForgeCommand(ticket,{type:'start',actor:{role:'user',id:'user-1'}},at);
  ticket=claim(ticket,'claimed-task','worker-claimed','attempt-claimed');
  ticket=claim(ticket,'finished-task','worker-finished','attempt-finished');
  ticket=outcome(ticket,'finished-task','worker-finished','attempt-finished');
  ticket=claim(ticket,'failure-task','worker-failure','attempt-failure-1');
  ticket=outcome(ticket,'failure-task','worker-failure','attempt-failure-1','failed');
  ticket=claim(ticket,'failure-task','worker-failure','attempt-failure-2');
  ticket=outcome(ticket,'failure-task','worker-failure','attempt-failure-2','failed');
  return ticket;
};
const readyForIntegration=()=>{
  let ticket=createDraft();
  ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
  ticket=applyForgeCommand(ticket,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
  ticket=applyForgeCommand(ticket,{type:'start',actor:{role:'user',id:'user-1'}},at);
  ticket=claim(ticket,'task-a','worker-a','attempt-a');
  const attempt=ticket.attempts[0]!;
  ticket=applyForgeCommand(ticket,{type:'accept_worker_outcome',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-a',attemptId:'attempt-a',claimToken:'token-attempt-a',outcomeId:'outcome-a',receiptId:'receipt-a',receipt:workerReceipt(),
    provenance:{producerRole:'worker',workerId:'worker-a',threadId:'thread-attempt-a',turnId:'turn-attempt-a',recordedAt:at,artifactRefs:['src/change.ts']},
    hostAttestation:{status:'verified',commitObserved:true,scopeValidation:'passed',commitSha:'f'.repeat(40),observedAt:at,evidenceRefs:['scope checked']},retryable:true},at);
  const run={id:'integration-run-a',ownerId:'integrator-runtime',projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,requestedProfile:ticket.workerProfile,branch:'forge/ticket-a/integration',targetBranch:ticket.targetBranch,
    worktreeRoot:'D:/workspace/demo/.forge/integration',sourceBaselineSha:'a'.repeat(40),scopes:structuredClone(ticket.scope),skillSnapshots:[]};
  ticket=applyForgeCommand(ticket,{type:'begin_integration',actor:{role:'host',id:'integrator-runtime'},run},at);
  ticket=applyForgeCommand(ticket,{type:'record_integration_runtime',actor:{role:'host',id:'integrator-runtime'},runId:run.id,threadId:'integration-thread',turnId:'integration-turn'},at);
  const candidate:ForgeIntegrationCandidate={id:'candidate-a',integratorRunId:run.id,candidateSha:'b'.repeat(40),targetMainSha:'c'.repeat(40),targetBranch:ticket.targetBranch,
    workerCommits:[{taskId:'task-a',attemptId:attempt.id,receiptId:attempt.receiptId||'receipt-a',commitSha:'f'.repeat(40)}],
    scopeValidation:{status:'passed',evidence:['All changed files passed the accepted scope check.']},verification:[{check:'Focused tests',result:'passed',evidence:'2 passed'}],
    combinedReceipt:{...workerReceipt(),status:'complete'},provenance:{producerRole:'integrator',threadId:'integration-thread',turnId:'integration-turn',recordedAt:at,artifactRefs:['integration receipt']},findings:[],createdAt:at};
  return applyForgeCommand(ticket,{type:'record_integration_candidate',actor:{role:'host',id:'git-adapter'},candidate},at);
};
const mergedTicket=()=>{
  let ticket=readyForIntegration();
  const candidate=ticket.integration.candidates[0]!;
  ticket=applyForgeCommand(ticket,{type:'begin_orchestrator_run',actor:{role:'host',id:'review-runtime'},run:{id:'review-run-a',ownerId:'review-runtime',purpose:'final_review',projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,
    requestedProfile:{provider:'codex',model:ticket.orchestrator.model,effort:ticket.orchestrator.effort},scopes:{read:[...ticket.scope.read],write:[],knowledge:[...ticket.scope.knowledge]},skillSnapshots:[],expectedPlanRevision:ticket.acceptedPlan!.revision,
    candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,targetBranch:candidate.targetBranch}},at);
  ticket=applyForgeCommand(ticket,{type:'record_orchestrator_runtime',actor:{role:'host',id:'review-runtime'},runId:'review-run-a',threadId:'review-thread',turnId:'review-turn'},at);
  ticket=applyForgeCommand(ticket,{type:'complete_candidate_review',actor:{role:'host',id:'review-runtime'},runId:'review-run-a',expectedPlanRevision:ticket.acceptedPlan!.revision,threadId:'review-thread',turnId:'review-turn',candidateId:candidate.id,candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,targetBranch:candidate.targetBranch,disposition:'accept',note:'The candidate and final diff passed review.'},at);
  ticket=applyForgeCommand(ticket,{type:'begin_merge',actor:{role:'host',id:'git-adapter'},candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,targetBranch:candidate.targetBranch,observedMainSha:candidate.targetMainSha},at);
  return applyForgeCommand(ticket,{type:'record_merge_readback',actor:{role:'host',id:'git-adapter'},result:'merged',candidateSha:candidate.candidateSha,targetMainSha:candidate.targetMainSha,targetBranch:candidate.targetBranch,preMergeMainSha:candidate.targetMainSha,observedMainSha:'d'.repeat(40),mergeCommitSha:'d'.repeat(40),commitReadbackSha:'d'.repeat(40)},at);
};
const forgeTask=(ticket:ForgeTicket):Task=>({id:ticket.id,sessionType:'forge',forge:ticket,toolCalls:createToolCallLog(),projectId:ticket.projectId,title:ticket.title,phase:'accepted',createdAt:ticket.createdAt,updatedAt:ticket.updatedAt,userRoot:ticket.workspaceRoot,messages:[{id:'forge-user',role:'user',text:ticket.description,createdAt:ticket.createdAt}],correctionCount:0});

const mockApi=vi.hoisted(()=>({api:vi.fn(),bootstrap:vi.fn(),apiPut:vi.fn()}));
vi.mock('../src/ui/api.js',()=>({
  KERNEL_PROTOCOL_VERSION:1,api:mockApi.api,bootstrap:mockApi.bootstrap,apiPut:mockApi.apiPut,
  createForgeTicket:(body:ForgeTicketCreateRequest)=>mockApi.api('/api/forge/tickets',body),
  getForgeTicket:(id:string)=>mockApi.api(`/api/forge/tickets/${encodeURIComponent(id)}`,undefined),
  forgeTicketAction:(id:string,action:'start'|'pause'|'resume'|'cancel',body:Record<string,unknown>={})=>mockApi.api(`/api/forge/tickets/${encodeURIComponent(id)}/${action}`,body),
  respondForgeApproval:(id:string,requestId:string|number,body:unknown)=>mockApi.api(`/api/forge/tickets/${encodeURIComponent(id)}/approvals/${encodeURIComponent(String(requestId))}`,body),
}));

let serverState:AppState;
let eventSource:any;
const snapshot=()=>({state:serverState,runtime});
function mockWorkspaceApi(){
  mockApi.api.mockImplementation(async(path:string,body?:unknown)=>{
    if(path==='/api/v1/snapshot'||path==='/api/state')return snapshot();
    if(path==='/api/projects/select')return {};
    if(path==='/api/skills?limit=100')return {skills:[{id:'22222222-2222-4222-8222-222222222222',name:'Testing checklist',description:'A reusable test plan.',source:'Opnex library',revision:'a'.repeat(64),createdAt:at,updatedAt:at,archived:false,fileCount:0}]};
    if(path.includes('/api/skills?source=codex'))return {skills:[{id:'codex:agentmem-project:0123456789ab',name:'agentmem-project',description:'External project knowledge instructions.',source:'Project skill',revision:'b'.repeat(64),createdAt:'',updatedAt:'',archived:false,fileCount:0}]};
    if(path==='/api/forge/tickets'){
      const input=body as ForgeTicketCreateRequest;
      const ticket=createForgeTicket({id:'forge-ticket-1',projectId:input.projectId,workspaceRoot:project.projectRoot,title:input.title,description:input.description,acceptanceCriteria:input.acceptanceCriteria,scope:input.scope,
        orchestrator:input.orchestrator,workerProfile:input.workerProfile,orchestratorSkills:[],approvalPolicy:serverState.settings.approvalPolicy==='full-access'?'on-request':serverState.settings.approvalPolicy,targetBranch:input.targetBranch,limits:input.limits,knowledgeBudget:input.knowledgeBudget,capabilities:{filesystemWriteScope:'instruction-only',knowledgeScope:'instruction-only',toolAuthorization:'instruction-only',cancellation:'monitored',commitScopeValidation:'enforced',finalMergeGate:'enforced'},createdAt:at});
      serverState={...serverState,tasks:[forgeTask(ticket),...serverState.tasks],activeTaskId:ticket.id,revision:(serverState.revision||0)+1};
      return ticket;
    }
    if(path.startsWith('/api/forge/tickets/'))return createDraft(path.split('/')[4]||'ticket-a');
    if(path==='/api/tasks')return {id:'conversation-1',title:String((body as any)?.message||'New conversation'),phase:'routing',createdAt:at,updatedAt:at,projectId:project.id,userRoot:project.projectRoot,messages:[],passes:[],correctionCount:0} as Task;
    return {};
  });
}
beforeEach(()=>{
  vi.clearAllMocks();serverState=baseState();eventSource=undefined;
  const range=Range.prototype as any;range.getClientRects??=()=>[];range.getBoundingClientRect??=()=>new DOMRect(0,0,0,0);
  (globalThis as any).EventSource=class{onmessage:any;onerror:any;constructor(){eventSource=this;}close(){}};
  mockApi.bootstrap.mockImplementation(async()=>({...snapshot(),csrf:'test'}));mockWorkspaceApi();
});
afterEach(()=>{cleanup();delete (window as any).opnexDesktop;delete (window as any).pseudoharnessDesktop;});

describe('Forge session creation',()=>{
  it('keeps Conversation as the default and creates a separate workspace-owned Forge draft',async()=>{
    const user=userEvent.setup();render(<App/>);
    await screen.findByRole('textbox',{name:'Task message'});
    expect(screen.getByRole('button',{name:'Conversation'}).getAttribute('aria-pressed')).toBe('true');
    expect(mockApi.api.mock.calls.some(([path])=>path==='/api/tasks')).toBe(false);

    screen.getByRole('button',{name:'Forge'}).focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('textbox',{name:'Ticket title'});
    expect(screen.getByText(project.projectRoot)).toBeTruthy();
    expect(screen.getByText(/Required AgentMem skill found/)).toBeTruthy();
    expect(screen.queryByRole('button',{name:'Worker model'})).toBeNull();
    expect(screen.getByText(/GPT-6 Luna · max/)).toBeTruthy();

    await user.type(screen.getByRole('textbox',{name:'Ticket title'}),'Improve cache');
    await user.type(screen.getByRole('textbox',{name:'Task description'}),'Make the cache resilient.');
    await user.type(screen.getByRole('textbox',{name:'Acceptance criteria'}),'Empty inputs are rejected.\nExisting cache hits remain stable.');
    await user.clear(screen.getByRole('textbox',{name:'Allowed read scope'}));
    await user.type(screen.getByRole('textbox',{name:'Allowed read scope'}),'src\ntests');
    await user.type(screen.getByRole('textbox',{name:'Allowed write scope'}),'src');
    await user.type(screen.getByRole('textbox',{name:'Knowledge scope'}),'knowledge/opnex');
    await user.click(screen.getByRole('button',{name:'Orchestrator model'}));
    await user.click(screen.getByRole('option',{name:/GPT-6\.1 Sol/}));
    await user.click(screen.getByText('Advanced ticket limits'));
    await user.clear(screen.getByRole('spinbutton',{name:'Total knowledge operations'}));
    await user.type(screen.getByRole('spinbutton',{name:'Total knowledge operations'}),'48');
    await user.click(screen.getByRole('checkbox',{name:/Testing checklist/}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'Create draft'}) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button',{name:'Create draft'}));

    await screen.findByRole('heading',{name:'Improve cache'});
    expect(mockApi.api).toHaveBeenCalledWith('/api/forge/tickets',expect.objectContaining({
      projectId:project.id,title:'Improve cache',description:'Make the cache resilient.',acceptanceCriteria:['Empty inputs are rejected.','Existing cache hits remain stable.'],
      scope:{read:['src','tests'],write:['src'],knowledge:['knowledge/opnex']},
      orchestrator:{model:'gpt-6.1-sol',effort:'low'},workerProfile:{provider:'codex',model:'gpt-6-luna',effort:'max'},
      targetBranch:'main',skillIds:['22222222-2222-4222-8222-222222222222'],
      limits:{maxActiveWorkers:3,maxExecutionAttempts:2,maxCorrectionRounds:3},
      knowledgeBudget:{totalOperations:48,defaultAllocationOperations:2,maxAllocationOperations:8},
    }));
    expect(mockApi.api.mock.calls.some(([path])=>String(path).endsWith('/start'))).toBe(false);
    expect(serverState.tasks[0]?.sessionType).toBe('forge');
    expect(serverState.tasks[0]?.forge?.workspaceRoot).toBe(project.projectRoot);
    expect(screen.getByRole('button',{name:'Start planning'})).toBeTruthy();
  });

  it('keeps the draft open with a clear workspace or required-skill action when creation is unavailable',async()=>{
    serverState={...serverState,projects:[{...project,needsLocation:true}]};
    render(<App/>);await screen.findByRole('textbox',{name:'Task message'});fireEvent.click(screen.getByRole('button',{name:'Forge'}));
    expect(screen.getByText(/working directory.*workspace/i)).toBeTruthy();
    expect((screen.getByRole('button',{name:'Create draft'}) as HTMLButtonElement).disabled).toBe(true);

    serverState=baseState();
    mockApi.api.mockImplementation(async(path:string)=>path==='/api/v1/snapshot'||path==='/api/state'?snapshot():path.includes('/api/skills?source=codex')?{skills:[]}:path==='/api/skills?limit=100'?{skills:[]}:{});
    cleanup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});fireEvent.click(screen.getByRole('button',{name:'Forge'}));
    await waitFor(()=>expect(document.querySelector('.forge-skill-readiness')?.textContent).toMatch(/Install or import[\s\S]*agentmem-project/i));
    expect((screen.getByRole('button',{name:'Create draft'}) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Forge board',()=>{
  it('renders actual dependency, claim, receipt and execution-failure states with truthful capabilities',()=>{
    const ticket=withFourWorkitemStates();
    const updateTicket=vi.fn();
    render(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={updateTicket}/>);
    expect(screen.getByText('1 open')).toBeTruthy();expect(screen.getByText('1 claimed')).toBeTruthy();expect(screen.getByText('1 finished')).toBeTruthy();expect(screen.getByText('2 blocked')).toBeTruthy();
    const board=document.querySelector('.forge-board')!;
    expect(board.textContent).toMatch(/Blocked by dependency.*claimed-task/);
    expect(board.textContent).toMatch(/Retry limit.*The attempt did not complete/);
    expect(board.textContent).toContain('worker-claimed');
    expect(board.textContent).toContain('attempt-claimed');
    expect(board.textContent).toContain('Instruction-only');
    expect(board.textContent).toMatch(/Worker completion is provisional/);
    expect(board.textContent).toContain('receipt-attempt-finished');
  });

  it('shows integration evidence through final review and completes only after merge readback',()=>{
    let ticket=readyForIntegration();
    const {rerender}=render(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={vi.fn()}/>);
    let board=document.querySelector('.forge-board')!;
    expect(board.textContent).toMatch(/Integrator state: ready for review/);
    ticket=applyForgeCommand(ticket,{type:'begin_orchestrator_run',actor:{role:'host',id:'review-runtime'},run:{id:'review-run-a',ownerId:'review-runtime',purpose:'final_review',projectId:ticket.projectId,workspaceRoot:ticket.workspaceRoot,
      requestedProfile:{provider:'codex',model:ticket.orchestrator.model,effort:ticket.orchestrator.effort},scopes:{read:[...ticket.scope.read],write:[],knowledge:[...ticket.scope.knowledge]},skillSnapshots:[],expectedPlanRevision:ticket.acceptedPlan!.revision,
      candidateId:ticket.integration.candidates[0]!.id,candidateSha:ticket.integration.candidates[0]!.candidateSha,targetMainSha:ticket.integration.candidates[0]!.targetMainSha,targetBranch:ticket.targetBranch}},at);
    rerender(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={vi.fn()}/>);
    board=document.querySelector('.forge-board')!;
    expect(board.textContent).toMatch(/Candidate branch forge\/ticket-a\/integration/);
    expect(board.textContent).toContain(`Candidate ${'b'.repeat(40)}`);
    expect(board.textContent).toMatch(/Focused tests.*passed/);
    expect(board.textContent).toMatch(/Final review.*prepared/);

    ticket=mergedTicket();
    rerender(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={vi.fn()}/>);
    board=document.querySelector('.forge-board')!;
    expect(board.textContent).toMatch(/Ticket complete after local merge read-back/);
    expect(board.textContent).toContain('d'.repeat(40));
    expect(screen.queryByRole('button',{name:/Merge into main/})).toBeNull();
  });

  it('dispatches pause, resume, cancel and review approval actions through Forge endpoints',async()=>{
    const user=userEvent.setup();let ticket=withFourWorkitemStates();
    mockApi.api.mockImplementation(async(path:string)=>{
      if(path.endsWith('/pause'))ticket=applyForgeCommand(ticket,{type:'pause',actor:{role:'user',id:'user-1'}},at);
      else if(path.endsWith('/resume'))ticket=applyForgeCommand(ticket,{type:'resume',actor:{role:'user',id:'user-1'}},at);
      else if(path.endsWith('/cancel'))ticket=applyForgeCommand(ticket,{type:'cancel',actor:{role:'user',id:'user-1'}},at);
      return ticket;
    });
    const updateTicket=vi.fn((next:ForgeTicket)=>{ticket=next;});
    const {rerender}=render(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={updateTicket}/>);
    await user.click(screen.getByRole('button',{name:'Pause Forge ticket'}));
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/pause`,{});
    rerender(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={updateTicket}/>);
    await user.click(screen.getByRole('button',{name:'Resume Forge ticket'}));
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/resume`,{});
    rerender(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={updateTicket}/>);
    await user.click(screen.getByRole('button',{name:'Cancel Forge ticket'}));
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/cancel`,{});
  });

  it('sends the exact plan revision when the user accepts a proposal',async()=>{
    const user=userEvent.setup();
    let ticket=createDraft('planned-ticket');
    ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
    mockApi.api.mockResolvedValue(ticket);
    render(<ForgeBoard ticket={ticket} task={forgeTask(ticket)} onTicketChange={next=>{ticket=next;}}/>);
    await user.click(screen.getByRole('button',{name:'Accept plan and start workers'}));
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/start`,{planRevision:ticket.proposedPlan!.revision});
  });

  it('routes Forge-owned approval responses with their persisted request id',async()=>{
    const user=userEvent.setup();let ticket=createDraft('approval-ticket');
    ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
    ticket=applyForgeCommand(ticket,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
    ticket=applyForgeCommand(ticket,{type:'start',actor:{role:'user',id:'user-1'}},at);
    ticket=claim(ticket,'task-a','worker-7','attempt-7');
    const request={requestId:'request-7',method:'item/commandExecution/requestApproval' as const,itemId:'item-7',threadId:'thread-attempt-7',turnId:'turn-attempt-7',reason:'Run the accepted test command.',command:'npm test',cwd:project.projectRoot,forgeContext:{ticketId:ticket.id,targetType:'worker_attempt' as const,targetId:'attempt-7',ownerId:'worker-7',claimToken:'token-attempt-7'}};
    serverState={...baseState(),revision:2,tasks:[{...forgeTask(ticket),approvalRequests:[request]}],activeTaskId:ticket.id};
    mockWorkspaceApi();
    render(<App/>);
    await user.click(await screen.findByRole('button',{name:'Approve once'}));
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/approvals/request-7`,{decision:'accept'});
    expect(screen.getByText(/Forge · worker attempt/)).toBeTruthy();
  });

  it('keeps unresolved approvals non-actionable while a ticket is paused',async()=>{
    let ticket=createDraft('paused-approval-ticket');
    ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
    ticket=applyForgeCommand(ticket,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
    ticket=applyForgeCommand(ticket,{type:'start',actor:{role:'user',id:'user-1'}},at);
    ticket=claim(ticket,'task-a','worker-7','attempt-7');
    ticket=applyForgeCommand(ticket,{type:'pause',actor:{role:'user',id:'user-1'}},at);
    const request={requestId:'request-paused',method:'item/commandExecution/requestApproval' as const,itemId:'item-paused',threadId:'thread-attempt-7',turnId:'turn-attempt-7',reason:'Run the accepted test command.',command:'npm test',cwd:project.projectRoot,forgeContext:{ticketId:ticket.id,targetType:'worker_attempt' as const,targetId:'attempt-7',ownerId:'worker-7',claimToken:'token-attempt-7'}};
    serverState={...baseState(),revision:2,tasks:[{...forgeTask(ticket),approvalRequests:[request]}],activeTaskId:ticket.id};mockWorkspaceApi();
    render(<App/>);
    expect(await screen.findByText(/Forge is paused.*request remains pending/i)).toBeTruthy();
    expect((screen.getByRole('button',{name:'Approve once'}) as HTMLButtonElement).disabled).toBe(true);
    expect(mockApi.api.mock.calls.some(([path])=>String(path).includes('/approvals/'))).toBe(false);
  });

  it('keeps cancelled, uncertain and stale-run approvals non-actionable',async()=>{
    const activeTicket=()=>{
      let ticket=createDraft('inactive-approval-ticket');
      ticket=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'plan-a',tasks:[planTask('task-a')]},at);
      ticket=applyForgeCommand(ticket,{type:'accept_plan',actor:{role:'orchestrator',id:'orch-1'},revision:1},at);
      ticket=applyForgeCommand(ticket,{type:'start',actor:{role:'user',id:'user-1'}},at);
      return claim(ticket,'task-a','worker-7','attempt-7');
    };
    const makeRequest=(ticket:ForgeTicket,turnId='turn-attempt-7')=>({requestId:'request-inactive',method:'item/commandExecution/requestApproval' as const,itemId:'item-inactive',threadId:'thread-attempt-7',turnId,reason:'Run the accepted test command.',command:'npm test',cwd:project.projectRoot,forgeContext:{ticketId:ticket.id,targetType:'worker_attempt' as const,targetId:'attempt-7',ownerId:'worker-7',claimToken:'token-attempt-7'}});
    const cancelled=applyForgeCommand(activeTicket(),{type:'cancel',actor:{role:'user',id:'user-1'}},at);
    const uncertain=applyForgeCommand(activeTicket(),{type:'mark_attempt_effect_uncertain',actor:{role:'host',id:'scheduler'},taskId:'task-a',ownerId:'worker-7',attemptId:'attempt-7',claimToken:'token-attempt-7',evidence:'The provider request timed out before its outcome was observed.'},at);
    const stale=activeTicket();
    const cases=[
      {ticket:cancelled,request:makeRequest(cancelled),reason:/cancelled or complete/},
      {ticket:uncertain,request:makeRequest(uncertain),reason:/needs reconciliation before this request can be answered/i},
      {ticket:stale,request:makeRequest(stale,'a-different-turn'),reason:/no longer matches an active worker attempt/i},
    ];
    for(const {ticket,request,reason} of cases){
      serverState={...baseState(),revision:2,tasks:[{...forgeTask(ticket),approvalRequests:[request]}],activeTaskId:ticket.id};
      mockWorkspaceApi();
      const {unmount}=render(<App/>);
      expect(await screen.findByText(reason)).toBeTruthy();
      for(const name of ['Approve once','Decline','Cancel turn'])expect((screen.getByRole('button',{name}) as HTMLButtonElement).disabled).toBe(true);
      expect(mockApi.api.mock.calls.some(([path])=>String(path).includes('/approvals/'))).toBe(false);
      unmount();
    }
  });

  it('updates an open Forge board from the existing state snapshot stream',async()=>{
    const ticket=createDraft('live-board-ticket');
    const task=forgeTask(ticket);serverState={...baseState(),revision:1,tasks:[task],activeTaskId:ticket.id};
    render(<App/>);await screen.findByRole('heading',{name:'Forge lifecycle'});await waitFor(()=>expect(eventSource).toBeTruthy());
    const planning=applyForgeCommand(ticket,{type:'submit_manual_plan',actor:{role:'user',id:'user-1'},planId:'live-plan',tasks:[planTask('task-live')]},at);
    const updatedTask={...task,forge:planning};
    act(()=>eventSource.onmessage({data:JSON.stringify({type:'snapshot',cursor:2,state:{...serverState,revision:2,tasks:[updatedTask]},runtime})}));
    await waitFor(()=>expect(document.querySelector('.forge-board')?.getAttribute('data-ticket-phase')).toBe('planning'));
    expect(screen.getByRole('heading',{name:'Review the proposed plan'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'Pause Forge ticket'})).toBeTruthy();
  });

  it('shows Forge tool-call coverage and keeps a missing workspace checkout as a recoverable error',async()=>{
    const ticket=createDraft();const task={...forgeTask(ticket),toolCalls:{schemaVersion:1 as const,total:1,statusCounts:{started:0,completed:1,failed:0,interrupted:0},seen:{'provider:agent:thread:turn:call':'completed' as const},calls:[{key:'provider:agent:thread:turn:call',identity:{provider:'codex',agentId:'agent',threadId:'thread',turnId:'turn',callId:'call'},name:'read_file',type:'function_call',status:'completed' as const,sources:['model' as const],firstSeenAt:at,lastSeenAt:at,finishedAt:at}],omittedCount:0}};
    render(<ForgeBoard ticket={ticket} task={task} onTicketChange={vi.fn()}/>);
    expect(screen.getByText('Tool calls · 1')).toBeTruthy();
    fireEvent.click(screen.getByText('Tool calls · 1'));expect(screen.getByText('read_file')).toBeTruthy();
    mockApi.api.mockRejectedValueOnce(new Error('The selected workspace is not a usable Git repository.'));
    fireEvent.click(screen.getByRole('button',{name:'Start planning'}));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not a usable Git repository/);
    expect(mockApi.api).toHaveBeenCalledWith(`/api/forge/tickets/${ticket.id}/start`,{});
  });
});
