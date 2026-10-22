import { describe, expect, it } from 'vitest';
import { assignmentSchema, workerOutcomeFailureSummary, workerOutcomeSchema } from '../server/contracts.js';
import { assignmentWriteRoots, canRetryAcceptedAgentMemPass, claimCompletion, completionDisposition, consolidatedUserRequest, correctionWorker, shouldWakeOrchestrator, isCancelled } from '../server/policy.js';
import type { Receipt } from '../server/contracts.js';

const assignment={outcome:'Fix scoped issue',deliverable:'Updated files',read_scope:['D:/repo'],write_scope:['D:/repo/src'],exclusions:['No deploy'],constraints:['Use local runtime'],context_refs:['docs/architecture.md'],acceptance:['Build passes'],verification:['Run tests'],ordinary_authority:['Choose implementation details'],escalation_conditions:['Need user decision'],receipt_requirements:['Structured receipt']};
const receipt:Receipt={status:'complete',result:'Done',changes:['src/main.ts'],acceptance:{met:['Build passes'],unmet:[]},verification:[{check:'tests',result:'passed',evidence:null}],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null};

describe('workflow contracts and scheduling policy',()=>{
  it('accepts complete assignments including explicit read-only scope and rejects missing scope',()=>{
    expect(assignmentSchema.safeParse(assignment).success).toBe(true);
    expect(assignmentSchema.safeParse({...assignment,write_scope:[]}).success).toBe(true);
    expect(assignmentSchema.safeParse({...assignment,read_scope:[]}).success).toBe(true);
    expect(assignmentSchema.safeParse({...assignment,read_scope:[],write_scope:[]}).success).toBe(true);
    const {write_scope:_,...incomplete}=assignment;
    expect(assignmentSchema.safeParse(incomplete).success).toBe(false);
  });
  it('rejects malformed worker outcomes instead of scheduling the next stage',()=>{
    expect(workerOutcomeSchema.safeParse({type:'receipt',receipt,decision_needed:null,evidence:[],options:[],recommendation:null,consequences:[]}).success).toBe(true);
    expect(workerOutcomeSchema.safeParse({type:'receipt',receipt:{status:'complete'},decision_needed:null,evidence:[],options:[],recommendation:null,consequences:[]}).success).toBe(false);
    expect(workerOutcomeSchema.safeParse({type:'progress',text:'half done'}).success).toBe(false);
  });
  it('uses the receipt discriminator when nullable wire fields also contain escalation details',()=>{
    const parsed=workerOutcomeSchema.safeParse({type:'receipt',receipt,decision_needed:'Not needed',evidence:['Verification evidence'],options:['Continue'],recommendation:'Accept',consequences:['None']});
    expect(parsed.success).toBe(true);
    if(parsed.success)expect(parsed.data.type).toBe('receipt');
  });
  it('reports the specific invalid outcome field without echoing model output',()=>{
    const result=workerOutcomeSchema.safeParse({type:'escalation',receipt:null,decision_needed:null,evidence:[],options:[],recommendation:null,consequences:[]});
    expect(result.success).toBe(false);
    if(!result.success){
      expect(result.error.issues.map(issue=>issue.path[0])).toEqual(['decision_needed','evidence','options']);
      expect(workerOutcomeFailureSummary(result.error)).toBe('an escalation needs a decision; an escalation needs evidence; an escalation needs options');
    }
    const invalidType=workerOutcomeSchema.safeParse({type:'final_receipt',receipt,decision_needed:null,evidence:[],options:[],recommendation:null,consequences:[]});
    if(!invalidType.success)expect(workerOutcomeFailureSummary(invalidType.error)).toBe('outcome type must be "receipt" or "escalation"');
  });
  it('exposes only the three permitted orchestrator wake causes',()=>{
    expect(['explicit_user_input','explicit_worker_escalation','final_worker_receipt'].every(x=>shouldWakeOrchestrator(x as any))).toBe(true);
    expect(shouldWakeOrchestrator('timer' as any)).toBe(false);
    expect(shouldWakeOrchestrator('progress_event' as any)).toBe(false);
    expect(shouldWakeOrchestrator('stdout_chunk' as any)).toBe(false);
  });
  it('claims each completion once across duplicate delivery and persisted reload',()=>{
    const id='turn-123';expect(claimCompletion('task-a',id,[])).toBe(true);expect(claimCompletion('task-a',id,[])).toBe(false);expect(claimCompletion('task-b',id,[])).toBe(true);expect(claimCompletion('task-z','old',['old'])).toBe(false);
  });
  it('reconciles accepted work with AgentMem even when the persisted lease token is stale',()=>{
    expect(canRetryAcceptedAgentMemPass({phase:'accepted',agentmemTaskId:'task',agentmemLease:'stale-token'})).toBe(true);
    expect(canRetryAcceptedAgentMemPass({phase:'worker_running',agentmemTaskId:'task'})).toBe(false);
    expect(canRetryAcceptedAgentMemPass({phase:'accepted'})).toBe(false);
  });
  it('reuses the same worker for the single correction and ignores cancelled completion',()=>{
    expect(correctionWorker({workerThreadId:'worker-7',correctionCount:0},receipt)).toBe('worker-7');
    expect(()=>correctionWorker({workerThreadId:'worker-7',correctionCount:1},receipt)).toThrow(/limit/i);
    expect(()=>correctionWorker({workerThreadId:undefined,correctionCount:0},receipt)).toThrow(/original worker/i);
    expect(isCancelled({phase:'cancelled'})).toBe(true);expect(isCancelled({phase:'worker_running'})).toBe(false);
  });
  it('serializes a worker interruption for user revision and ignores late cancelled events',()=>{
    expect(completionDisposition({phase:'worker_running',pendingRevision:true},'worker','interrupted')).toBe('revise');
    expect(completionDisposition({phase:'planning',pendingRevision:true},'orchestrator','interrupted')).toBe('revise');
    expect(completionDisposition({phase:'worker_running',pendingRevision:false},'worker','interrupted')).toBe('attention');
    expect(completionDisposition({phase:'planning',pendingRevision:false},'orchestrator','failed')).toBe('attention');
    expect(completionDisposition({phase:'cancelled',pendingRevision:true},'worker','completed')).toBe('ignore');
    expect(completionDisposition({phase:'worker_running',pendingRevision:false},'worker','completed')).toBe('continue');
  });
  it('keeps the initial request when an explicit post-restart continuation has no assignment yet',()=>{
    const context=consolidatedUserRequest(['Build a local viewer','Use a desktop layout']);
    expect(context).toContain('Build a local viewer');expect(context).toContain('Use a desktop layout');
    expect(consolidatedUserRequest(['Build a viewer'],assignment)).toContain('Prior complete assignment');
  });
  it('enforces assignment write roots under the configured project and supports read-only work',()=>{
    expect(assignmentWriteRoots({write_scope:['D:/repo/src']},'D:/repo')).toEqual(['D:\\repo\\src']);
    expect(assignmentWriteRoots({write_scope:[]},'D:/repo')).toEqual([]);
    expect(assignmentWriteRoots({write_scope:['No filesystem writes authorized']},'D:/repo')).toEqual([]);
    expect(()=>assignmentWriteRoots({write_scope:['D:/other']},'D:/repo')).toThrow(/escapes/i);
    expect(()=>assignmentWriteRoots({write_scope:['src']},'D:/repo')).toThrow(/absolute/i);
  });
});
