import { describe, expect, it, vi } from 'vitest';
import { dispatchIntakeOutcome } from '../server/intake.js';
import { buildOrchestratorInput, loadOwnedOrchestrationPolicy } from '../server/orchestration-policy.js';
import { assignmentSchema, initialOrchestratorJsonSchema, initialOrchestratorSchema } from '../server/contracts.js';

const assignment={outcome:'Refactor service',deliverable:'Updated service',read_scope:['src'],write_scope:['D:/repo/src'],exclusions:['deployment'],constraints:['local'],context_refs:['README.md'],acceptance:['behavior preserved'],verification:['tests pass'],ordinary_authority:['choose implementation details'],escalation_conditions:['public contract change'],receipt_requirements:['status and evidence']};

describe('orchestrator policy and intake routing',()=>{
  it('loads the portable policy copy and includes it in every assembled orchestrator prompt',async()=>{
    const policy=await loadOwnedOrchestrationPolicy();
    expect(policy).toContain('Classify each new user request before execution.');
    expect(policy).toContain('The hard-task orchestrator must return a complete delegation assignment; it cannot answer directly.');
    expect(policy).toContain('While Luna works, the orchestrator stays dormant.');
    expect(policy).not.toMatch(/[A-Za-z]:\\|\\Users\\|\\home\\/i);
    expect(buildOrchestratorInput(policy,'USER INPUT')).toContain(`<delegation-policy>\n${policy}`);
  });
  it('answers directly without invoking the worker handler when policy permits it',async()=>{
    const direct=vi.fn(async()=>{});const delegate=vi.fn(async()=>{});
    const route=await dispatchIntakeOutcome({type:'direct_answer',answer:'Four.',policy_basis:'A trivial factual transformation needs no worker.',assignment:null},true,{direct,delegate});
    expect(route).toBe('direct');expect(direct).toHaveBeenCalledOnce();expect(delegate).not.toHaveBeenCalled();
  });
  it('starts delegation only from a complete validated plan',async()=>{
    const direct=vi.fn(async()=>{});const delegate=vi.fn(async()=>{});
    const route=await dispatchIntakeOutcome({type:'delegate',answer:null,policy_basis:null,assignment},true,{direct,delegate});
    expect(route).toBe('delegated');expect(delegate).toHaveBeenCalledWith(assignmentSchema.parse(assignment));expect(direct).not.toHaveBeenCalled();
  });
  it('uses an object-root strict-output schema and validates branch exclusivity',()=>{
    expect(initialOrchestratorJsonSchema.type).toBe('object');
    expect(initialOrchestratorSchema.safeParse({type:'direct_answer',answer:'Four',policy_basis:'Trivial',assignment:null}).success).toBe(true);
    expect(initialOrchestratorSchema.safeParse({type:'delegate',answer:null,policy_basis:null,assignment}).success).toBe(true);
    expect(initialOrchestratorSchema.safeParse({type:'delegate',answer:'Four',policy_basis:null,assignment}).success).toBe(false);
    expect(initialOrchestratorSchema.safeParse({type:'direct_answer',answer:'Four',policy_basis:'Trivial',assignment}).success).toBe(false);
  });
  it('does not allow a direct response during a continuation that requires an assignment',async()=>{
    const direct=vi.fn(async()=>{});const delegate=vi.fn(async()=>{});
    await expect(dispatchIntakeOutcome({type:'direct_answer',answer:'Sure',policy_basis:'Simple',assignment:null},false,{direct,delegate})).rejects.toThrow();
    expect(direct).not.toHaveBeenCalled();expect(delegate).not.toHaveBeenCalled();
  });
});
