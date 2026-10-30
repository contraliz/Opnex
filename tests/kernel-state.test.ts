import { describe, expect, it } from 'vitest';
import { pauseActiveTasksForKernelShutdown, type ApprovalRequest, type State, type Task } from '../server/state.js';

describe('kernel-owned state cursor and shutdown recovery',()=>{
  it('pauses active work once, preserves its messages and approval evidence, and never fabricates an integration wake',()=>{
    const at='2026-10-27T12:30:00.000Z';
    const approval:ApprovalRequest={requestId:'approval-1',method:'item/commandExecution/requestApproval',itemId:'item-1',threadId:'thread-1',turnId:'turn-1',command:'npm test',cwd:'D:/workspace'};
    const team={teamId:'team-1',passId:'pass-1',createdAt:at,canonicalProjectRoot:'D:/workspace',agentmemProjectId:'',workspaceParent:'D:/workspace',baseRef:'main',baseCommit:'abc123',status:'running',sealed:true,workers:[{workerId:'worker-1',name:'Worker',status:'running',deepSeekPhaseRuns:[{stage:'execute',sessionId:'dsh-session-1',turnId:'turn-1',provider:'deepseek-official',model:'deepseek-flash',requestedReasoningEffort:'high',permissionMode:'danger-full-access',approvalPolicy:'full-access',workspaceRoot:'D:/workspace/.pseudoharness/worktree',writeScope:['D:/workspace/.pseudoharness/worktree/src'],access:'unrestricted',filesystemScope:'assignment-instruction-only',status:'running',startedAt:at,updatedAt:at}]}],integration:{status:'queued'},toolCallIds:['tool-call-1'],completionWakeSent:false} as any;
    const pass:any={id:'pass-1',index:1,createdAt:at,userInput:'Complete a task',userInputs:['Complete a task'],userMessageIds:['user-1'],phase:'worker_running',correctionCount:0,processedTurns:[],reasoningTurns:[{role:'worker',threadId:'thread-1',turnId:'turn-1',requestedModel:'deepseek-flash',requestedEffort:'high',startedAt:at,status:'streaming'}],liveActivity:[{role:'worker',threadId:'thread-1',turnId:'turn-1',itemId:'command-1',kind:'tool',itemType:'commandExecution',title:'npm test',status:'running',startedAt:at,updatedAt:at}],recruitmentTeam:team};
    const task:Task={id:'task-1',title:'Complete a task',phase:'worker_running',createdAt:at,updatedAt:at,userRoot:'D:/workspace',agentmemProjectId:'',userMessages:['Complete a task'],messages:[{id:'user-1',role:'user',text:'Complete a task',createdAt:at},{id:'partial-1',role:'worker',text:'Partial output stays saved.',createdAt:at}],passes:[pass],currentPassId:'pass-1',activeRole:'worker',activeTurnId:'turn-1',approvalRequests:[approval],reasoningTurns:[...pass.reasoningTurns],liveActivity:[...pass.liveActivity],correctionCount:0,processedTurns:[]};
    const intake:Task={...structuredClone(task),id:'intake-1',phase:'intake',activeRole:undefined,activeTurnId:undefined,approvalRequests:[],currentPassId:undefined,passes:[]};
    const escalated:Task={...structuredClone(task),id:'escalated-1',phase:'escalated',activeRole:undefined,activeTurnId:undefined,approvalRequests:[]};
    const state:State={version:4,revision:8,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:[task,intake,escalated],activeTaskId:task.id,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']};

    expect(pauseActiveTasksForKernelShutdown(state,at)).toBe(2);
    expect(pauseActiveTasksForKernelShutdown(state,at)).toBe(0);
    expect(task.phase).toBe('paused_after_restart');
    expect(task.activeRole).toBeUndefined();expect(task.activeTurnId).toBeUndefined();expect(task.approvalRequests).toEqual([]);
    expect(task.messages.at(-1)?.text).toBe('Partial output stays saved.');
    expect(pass.interruptedApprovals).toEqual([approval]);
    expect(pass.reasoningTurns[0].status).toBe('interrupted');
    expect(pass.liveActivity[0]).toMatchObject({status:'interrupted',updatedAt:at});
    expect(team.status).toBe('paused_after_restart');expect(team.workers[0].status).toBe('paused_after_restart');expect(team.integration.status).toBe('paused_after_restart');
    expect(team.workers[0].deepSeekPhaseRuns[0]).toMatchObject({stage:'execute',sessionId:'dsh-session-1',turnId:'turn-1',permissionMode:'danger-full-access',status:'interrupted',error:'The kernel restarted; the execution phase was not replayed automatically.'});
    expect(team.toolCallIds).toEqual(['tool-call-1']);expect(team.completionWakeSent).toBe(false);
    expect(intake.phase).toBe('paused_after_restart');
    expect(escalated.phase).toBe('escalated');
  });
  it('persists an interrupted read-only QA audit as resumable without inferring findings',()=>{
    const at='2026-10-27T12:30:00.000Z';const round={roundId:'qa-round-1',index:1,status:'auditing',createdAt:at,startedAt:at,threadId:'terra-thread',turnId:'terra-turn',model:'gpt-6.1-terra',requestedEffort:'high',workspaceRoot:'D:/workspace/.pseudoharness/integration',integrationBranch:'recruitment/smoke/integration',integrationHead:'abc123',findings:[]} as const;
    const pass:any={id:'pass-qa',index:1,createdAt:at,userInput:'Run a bounded QA task',userInputs:['Run a bounded QA task'],userMessageIds:['user-qa'],phase:'reviewing',correctionCount:0,processedTurns:[],qualityLoop:{enabled:true,status:'auditing',rounds:[round],maxRounds:5}};
    const task:Task={id:'task-qa',title:'QA smoke',phase:'reviewing',createdAt:at,updatedAt:at,userRoot:'D:/workspace',agentmemProjectId:'',userMessages:['Run a bounded QA task'],messages:[{id:'user-qa',role:'user',text:'Run a bounded QA task',createdAt:at}],passes:[pass],currentPassId:'pass-qa',activeRole:'orchestrator',activeTurnId:'terra-turn',correctionCount:0,processedTurns:[]};
    const state:State={version:4,revision:1,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:[task],activeTaskId:task.id,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']};
    expect(pauseActiveTasksForKernelShutdown(state,at)).toBe(1);expect(pass.qualityLoop).toMatchObject({enabled:true,status:'paused_after_restart',resumeAction:'audit',rounds:[{roundId:'qa-round-1',status:'paused_after_restart',findings:[],error:expect.stringContaining('no saved result was inferred')}]});expect(task.phase).toBe('paused_after_restart');expect(task.activeTurnId).toBeUndefined();
  });
  it('preserves actionable QA findings and exposes correction resume after kernel shutdown',()=>{
    const at='2026-10-27T12:45:00.000Z';const findings=[{findingId:'finding-1',fingerprint:'sha256-finding-1',title:'The correction was not planned',severity:'medium',issue:'Saved actionable evidence needs a correction pass.',requiredFix:'Resume planning from this exact finding.',evidence:['The auditor saved the finding before shutdown.']}];
    const round={roundId:'qa-round-corrections',index:1,status:'awaiting_corrections',createdAt:at,startedAt:at,completedAt:at,threadId:'terra-thread',turnId:'terra-turn',model:'gpt-6.1-terra',requestedEffort:'high',workspaceRoot:'D:/workspace/.pseudoharness/integration',integrationBranch:'recruitment/smoke/integration',integrationHead:'abc123',findings,findingsFingerprint:'sha256-findings',teamId:'team-complete'} as const;
    const pass:any={id:'pass-qa-corrections',index:1,createdAt:at,userInput:'Fix the implementation',userInputs:['Fix the implementation'],userMessageIds:['user-qa'],phase:'reviewing',correctionCount:0,processedTurns:[],recruitmentTeam:{teamId:'team-complete',passId:'pass-qa-corrections',createdAt:at,canonicalProjectRoot:'D:/workspace',agentmemProjectId:'',workspaceParent:'D:/workspace',baseRef:'main',baseCommit:'abc123',status:'complete',sealed:true,workers:[],integration:{status:'complete'},toolCallIds:[],completionWakeSent:true},qualityLoop:{enabled:true,status:'awaiting_corrections',rounds:[round],maxRounds:5}};
    const task:Task={id:'task-qa-corrections',title:'QA correction recovery',phase:'reviewing',createdAt:at,updatedAt:at,userRoot:'D:/workspace',agentmemProjectId:'',userMessages:['Fix the implementation'],messages:[{id:'user-qa',role:'user',text:'Fix the implementation',createdAt:at}],passes:[pass],currentPassId:pass.id,correctionCount:0,processedTurns:[]};
    const state:State={version:4,revision:1,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:[task],activeTaskId:task.id,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']};
    expect(pauseActiveTasksForKernelShutdown(state,at)).toBe(1);
    expect(task.phase).toBe('paused_after_restart');expect(pass.qualityLoop).toMatchObject({enabled:true,status:'paused_after_restart',resumeAction:'corrections',correctionPlannerNotDispatchedRoundId:'qa-round-corrections',rounds:[{roundId:'qa-round-corrections',status:'awaiting_corrections',findings,findingsFingerprint:'sha256-findings'}]});
  });
});
