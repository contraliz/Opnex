import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentMem, agentMemRecordFailure, agentMemRecordState, toAgentMemReceipt } from '../server/agentmem.js';
import type { Receipt } from '../server/contracts.js';

const receipt:Receipt={status:'complete',result:'The adapter completion task is implemented and verified.',changes:['server/agentmem.ts'],acceptance:{met:['Adapter submits completion schema','AgentMem releases completed task'],unmet:[]},verification:[{check:'Adapter contract',result:'passed',evidence:'The real service accepted the receipt and returned done with no owner or lease.'}],risks:[],knowledge:{consulted:['AgentMem store contract'],updated:[]},decision_required:null};
const context={task:{acceptance:['Adapter submits completion schema','AgentMem releases completed task']},requirements:{requirements_revision:7,requirements_complete:true,applicable_requirements:[{id:'REQ-0001',revision:7}]}};

describe('AgentMem receipt boundary',()=>{
  it('lists only registered projects with a projects-directory memory root and verifies the paired workspace',async()=>{
    const adapter=new AgentMem();(adapter as any).client={};
    const projects=path.join(os.tmpdir(),'projects');const call=vi.fn(async()=>({projects:[{id:'other',name:'Other',root:'D:/other',memory_root:path.join(os.tmpdir(),'private','other')},{id:'demo',root:'D:/workspace/demo',memory_root:path.join(projects,'demo')},{id:'missing-root',memory_root:path.join(projects,'missing-root')},{id:'outside',root:'D:/outside',memory_root:path.join(os.tmpdir(),'projects-backup','outside')}]}));(adapter as any).call=call;
    await expect(adapter.listProjects()).resolves.toEqual([{id:'demo',name:'demo',sourceRoot:'D:/workspace/demo',memoryDirectory:'demo'}]);
    await expect(adapter.connect('demo','d:/workspace/demo')).resolves.toMatchObject({id:'demo'});
    await expect(adapter.connect('other','D:/workspace/demo')).rejects.toThrow(/not registered/);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('rejects malformed project listings instead of presenting invented choices',async()=>{
    const adapter=new AgentMem();(adapter as any).client={};(adapter as any).call=vi.fn(async()=>({registered:[{id:'missing-schema'}]}));
    await expect(adapter.listProjects()).rejects.toThrow(/did not contain a projects array/);
  });

  it('builds the actual completion contract without changing project fulfillment',()=>{
    const stored=toAgentMemReceipt({...receipt,review_outcome:'accept'},context);
    expect(stored.status).toBe('done');
    expect(stored.acceptance_checks).toHaveLength(2);
    expect(stored.acceptance_checks.every(x=>x.met&&x.evidence)).toBe(true);
    expect(stored.requirements_revision).toBe(7);
    expect(stored.requirement_checks).toEqual([expect.objectContaining({requirement_id:'REQ-0001',revision:7,met:true})]);
    expect(stored.note).toMatch(/Project requirement fulfillment remains independent/);
  });

  it('uses explicit accepted review as the criterion mapping when worker wording differs',()=>{
    const differentlyWorded={...receipt,acceptance:{met:['Result is exactly “Luna”.','No filesystem access or other actions occurred.'],unmet:[]},result:'Luna'};
    const currentTask={task:{acceptance:['The final receipt has status complete and result exactly “Luna”.','No filesystem access or other actions occur.']},requirements:{requirements_revision:13,requirements_complete:true,applicable_requirements:[]}};
    const stored=toAgentMemReceipt({...differentlyWorded,review_outcome:'accept'},currentTask);
    expect(stored.status).toBe('done');
    expect(stored.acceptance_checks).toHaveLength(2);
    expect(stored.acceptance_checks.every(x=>x.met&&x.evidence.includes('orchestrator accepted this assignment criterion'))).toBe(true);
  });

  it('falls back to the validated assignment criteria if the service context omits task acceptance',()=>{
    const assignment={acceptance:['The worker receipt contains the result "Luna".','No filesystem access, writes, or unrelated actions occur.']};
    const appReceipt={...receipt,result:'Luna',assignment,review_outcome:'accept'};
    const currentTask={requirements:{requirements_revision:13,requirements_complete:true,applicable_requirements:[]}};
    const stored=toAgentMemReceipt(appReceipt as any,currentTask);
    expect(stored.status).toBe('done');
    expect(stored.acceptance_checks.map(x=>x.criterion)).toEqual(assignment.acceptance);
  });

  it('refuses task completion when app assignment criteria differ from AgentMem task criteria',()=>{
    const assigned={...receipt,assignment:{acceptance:['Different criterion']},review_outcome:'accept'};
    expect(toAgentMemReceipt(assigned as any,context).status).toBe('in_progress');
  });

  it('does not request completion when acceptance evidence is missing',()=>{
    const incomplete={...receipt,acceptance:{met:['Adapter submits completion schema'],unmet:['AgentMem releases completed task']}};
    expect(toAgentMemReceipt({...incomplete,review_outcome:'accept'},context).status).toBe('in_progress');
  });

  it('records an accepted completion and does not release a service-completed lease',async()=>{
    const adapter=new AgentMem();
    const serviceTask={status:'in_progress',owner:'pseudoharness-local',lease_until:12345};
    const call=vi.fn(async(name:string,args:any)=>{
      if(name==='task_context')return context;
      if(name==='record_work'&&args.action==='receipt'){
        expect(args.receipt.status).toBe('done');
        expect(args.receipt.acceptance_checks.every((x:any)=>x.met&&x.evidence)).toBe(true);
        expect(args.receipt.requirements_revision).toBe(7);
        expect(args.receipt.requirement_checks.every((x:any)=>x.met&&x.evidence)).toBe(true);
        serviceTask.status='done';serviceTask.owner='';serviceTask.lease_until=0;
        return {status:'done',receipt_id:'receipt-1',completion_accepted:true};
      }
      throw new Error(`Unexpected AgentMem action ${name}:${args.action}`);
    });
    (adapter as any).call=call;
    const saved=await adapter.recordReceipt('pseudoharness','task-1','lease-1',{...receipt,review_outcome:'accept'});
    expect(saved.status).toBe('done');
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1].receipt).toMatchObject({status:'done',acceptance_checks:expect.arrayContaining([expect.objectContaining({criterion:'Adapter submits completion schema',met:true,evidence:expect.any(String)})])});
    expect(call.mock.calls[1][1].receipt.requirement_checks[0]).toMatchObject({requirement_id:'REQ-0001',revision:7,met:true});
    expect(serviceTask).toEqual({status:'done',owner:'',lease_until:0});
  });

  it('paginates mandatory task requirements before completing an accepted work record',async()=>{
    const adapter=new AgentMem();
    const requirement=(id:string)=>({id,title:id,revision:1,fulfilled:true,criteria:[],scope:{project_wide:true}});
    const firstPage={...context,requirements:{requirements_revision:19,applicable_requirements:[requirement('REQ-0001')],applicable_count:2,requirements_complete:false,next_requirement_offset:1}};
    const lastPage={...context,requirements:{requirements_revision:19,applicable_requirements:[requirement('REQ-0002')],applicable_count:2,requirements_complete:true,next_requirement_offset:null}};
    const serviceTask={status:'in_progress',owner:'pseudoharness-local',lease_until:12345};
    const call=vi.fn(async(name:string,args:any)=>{
      if(name==='task_context'&&args.requirement_offset===0)return firstPage;
      if(name==='task_context'&&args.requirement_offset===1)return lastPage;
      if(name==='record_work'&&args.action==='receipt'){
        expect(args.receipt.status).toBe('done');
        expect(args.receipt.requirement_checks.map((x:any)=>x.requirement_id)).toEqual(['REQ-0001','REQ-0002']);
        expect(args.receipt.requirement_checks.every((x:any)=>x.met&&x.evidence)).toBe(true);
        serviceTask.status='done';serviceTask.owner='';serviceTask.lease_until=0;
        return {status:'done',receipt_id:'receipt-paged',completion_accepted:true};
      }
      throw new Error(`Unexpected AgentMem action ${name}:${args.action}`);
    });
    (adapter as any).call=call;
    const saved=await adapter.recordReceipt('pseudoharness','task-paged','lease-paged',{...receipt,review_outcome:'accept'});
    expect(saved.status).toBe('done');
    expect(call.mock.calls.filter(([name])=>name==='task_context').map(([,args])=>args.requirement_offset)).toEqual([0,1]);
    expect(call).toHaveBeenCalledTimes(3);
    expect(serviceTask).toEqual({status:'done',owner:'',lease_until:0});
  });

  it('reclaims an app-owned open work record and completes it with the supported schema',async()=>{
    const adapter=new AgentMem();
    const serviceTask={status:'in_progress',owner:'pseudoharness-local',lease_until:12345};
    const call=vi.fn(async(name:string,args:any)=>{
      if(name==='tasks')return {...serviceTask,id:'task-retry'};
      if(name==='claim_task')return {lease_token:'new-lease'};
      if(name==='task_context')return context;
      if(name==='record_work'&&args.action==='receipt'){
        expect(args.lease_token).toBe('new-lease');
        expect(args.idempotency_key).toBe('pseudoharness-task-retry-receipt-v2');
        expect(args.receipt.status).toBe('done');
        serviceTask.status='done';serviceTask.owner='';serviceTask.lease_until=0;
        return {status:'done',receipt_id:'receipt-retry',completion_accepted:true};
      }
      throw new Error(`Unexpected AgentMem action ${name}:${args.action}`);
    });
    (adapter as any).call=call;
    const saved=await adapter.retryReceipt('pseudoharness','task-retry',{...receipt,review_outcome:'accept'});
    expect(saved.status).toBe('done');
    expect(call.mock.calls.map(([name,args])=>name==='task_context'?args.requirement_offset:name)).toEqual(['tasks','claim_task',0,'record_work']);
    expect(serviceTask).toEqual({status:'done',owner:'',lease_until:0});
  });

  it('keeps the completion pending and releases ownership when requirement pagination is incomplete',async()=>{
    const adapter=new AgentMem();
    const call=vi.fn()
      .mockResolvedValueOnce({...context,requirements:{requirements_revision:19,applicable_requirements:[],requirements_complete:false,next_requirement_offset:null}})
      .mockResolvedValueOnce({status:'in_progress',owner:''});
    (adapter as any).call=call;
    await expect(adapter.recordReceipt('pseudoharness','task-page-error','lease-page-error',{...receipt,review_outcome:'accept'}))
      .rejects.toThrow(/safe continuation/);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1][1]).toMatchObject({action:'release',task_id:'task-page-error',lease_token:'lease-page-error'});
  });

  it('releases an unaccepted completion and returns an actionable failure state',async()=>{
    const adapter=new AgentMem();
    const call=vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce({status:'in_progress',receipt_id:'receipt-2',note:'Done also requires current requirements_revision and evidence-backed checks.'}).mockResolvedValueOnce({status:'open'});
    (adapter as any).call=call;
    const saved=await adapter.recordReceipt('pseudoharness','task-2','lease-2',{...receipt,review_outcome:'accept'});
    expect(saved.completion_accepted).toBe(false);
    expect(saved.ownership_released).toBe(true);
    expect(saved.actionable_error).toMatch(/requirements_revision/);
    expect(call.mock.calls[2][1]).toMatchObject({action:'release',task_id:'task-2',lease_token:'lease-2'});
  });

  it('marks a blocked AgentMem work item before releasing its lease',async()=>{
    const adapter=new AgentMem();
    const blocked={...receipt,status:'blocked' as const,result:'Waiting on required human decision.'};
    const call=vi.fn().mockResolvedValueOnce(context).mockResolvedValueOnce({status:'in_progress',receipt_id:'receipt-blocked'}).mockResolvedValueOnce({status:'in_progress'}).mockResolvedValueOnce({status:'in_progress',owner:''});
    (adapter as any).call=call;
    await adapter.recordReceipt('pseudoharness','task-blocked','lease-blocked',{...blocked,review:'Blocked'});
    expect(call.mock.calls[2][1]).toMatchObject({action:'block',blocked_reason:'Waiting on required human decision.'});
    expect(call.mock.calls[3][1]).toMatchObject({action:'release',task_id:'task-blocked'});
  });

  it('releases cancelled work through the supported ownership API',async()=>{
    const adapter=new AgentMem();const call=vi.fn().mockResolvedValue({status:'in_progress',owner:''});(adapter as any).call=call;
    await adapter.releaseWork('pseudoharness','task-cancelled','lease-cancelled');
    expect(call).toHaveBeenCalledWith('record_work',{action:'release',project_id:'pseudoharness',task_id:'task-cancelled',lease_token:'lease-cancelled',owner:'pseudoharness-local'});
  });

  it('surfaces API failures rather than claiming a successful save',async()=>{
    const adapter=new AgentMem();
    (adapter as any).call=vi.fn().mockResolvedValueOnce(context).mockRejectedValueOnce(new Error('MCP receipt call failed')).mockResolvedValueOnce({status:'in_progress',owner:''});
    await expect(adapter.recordReceipt('pseudoharness','task-3','lease-3',{...receipt,review_outcome:'accept'})).rejects.toThrow('MCP receipt call failed');
  });

  it('keeps rejected saves and completions visibly distinct from success in app state',()=>{
    expect(agentMemRecordState({status:'in_progress',receipt_id:'r',ownership_released:true,actionable_error:'Requirement checks were rejected.'},'complete')).toEqual({status:'in_progress',receiptId:'r',ownershipReleased:true,error:'Requirement checks were rejected.'});
    expect(agentMemRecordFailure(new Error('AgentMem unavailable'))).toEqual({status:'failed',error:'AgentMem receipt save/completion failed: AgentMem unavailable'});
  });
});
