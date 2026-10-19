// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/ui/App.js';

const fixture={state:{version:1,settings:{projectRoot:'D:/workspace/demo',agentmemProjectId:'demo-project',orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'},tasks:[],activeTaskId:null},runtime:{codex:{state:'connected',error:'',models:[{id:'gpt-6-sol',displayName:'GPT-6 Sol',efforts:['high','xhigh']},{id:'gpt-6-astra',displayName:'GPT-6 Astra',efforts:['medium','high']},{id:'gpt-6-luna',displayName:'GPT-6 Luna',efforts:['high']}],workerAvailable:true},agentmem:{connected:true,projectVerified:true,detail:'Connected · demo-project'}}};
vi.mock('../src/ui/api.js',()=>({bootstrap:vi.fn(async()=>({...fixture,csrf:'test'})),api:vi.fn(async(path:string)=>path==='/api/state'?fixture:{})}));

describe('local task shell',()=>{
  beforeEach(async()=>{vi.clearAllMocks();(globalThis as any).EventSource=class{onmessage:any;onerror:any;close(){}};const apiMod=await import('../src/ui/api.js');vi.mocked(apiMod.bootstrap).mockResolvedValue({...fixture,csrf:'test'} as any);vi.mocked(apiMod.api).mockImplementation(async(path:string)=>path==='/api/state'?fixture as any:{} as any);});
  afterEach(()=>cleanup());
  it('renders honest first-run empty state and opens project settings',async()=>{
    render(<App/>);expect(await screen.findByText('What are we working on?')).toBeTruthy();expect(screen.getByText(/Local workflow/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Settings'}));expect(await screen.findByRole('dialog')).toBeTruthy();expect(screen.getByText('AgentMem project ID')).toBeTruthy();
  });
  it('shows active task progress, assignment and the idle orchestrator message',async()=>{
    const task={id:'task-1',title:'Implement local harness',phase:'worker_running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),userRoot:'D:/programming/pseudoharness',correctionCount:0,messages:[{id:'m1',role:'user',text:'Build the harness',createdAt:new Date().toISOString()}],assignment:{outcome:'Build local harness',deliverable:'Runnable app',read_scope:['project'],write_scope:['project/src'],exclusions:['deployment'],constraints:['local only'],context_refs:['docs'],acceptance:['app works'],verification:['tests'],ordinary_authority:['choose details'],escalation_conditions:['decision'],receipt_requirements:['receipt']}};
    const activeFixture={...fixture,state:{...fixture.state,tasks:[task],activeTaskId:'task-1'}};
    const apiMod=await import('../src/ui/api.js');vi.mocked(apiMod.bootstrap).mockResolvedValue({...activeFixture,csrf:'test'} as any);
    render(<App/>);expect((await screen.findAllByText('Worker running · orchestrator idle')).length).toBe(2);expect(screen.getByText('Progress is visible here and does not wake the orchestrator.')).toBeTruthy();expect(screen.getByText('Authorized write scope')).toBeTruthy();
  });
  it('exposes real composer selectors and persists model, effort, and approval choices',async()=>{
    render(<App/>);await screen.findByText('What are we working on?');
    const model=screen.getByRole('combobox',{name:'Orchestrator model'}) as HTMLSelectElement;
    const effort=screen.getByRole('combobox',{name:'Orchestrator effort'}) as HTMLSelectElement;
    const approval=screen.getByRole('combobox',{name:'Approval policy'}) as HTMLSelectElement;
    expect(Array.from(model.options).map(o=>o.value)).toContain('gpt-6-astra');
    expect(Array.from(effort.options).map(o=>o.value)).toEqual(['high','xhigh']);
    fireEvent.change(model,{target:{value:'gpt-6-astra'}});
    fireEvent.change(approval,{target:{value:'untrusted'}});
    const {api}=await import('../src/ui/api.js');
    await waitFor(()=>expect(vi.mocked(api).mock.calls.some(([url,body])=>url==='/api/settings'&&(body as any).orchestratorModel==='gpt-6-astra')).toBe(true));
    await waitFor(()=>expect(vi.mocked(api).mock.calls.filter(([url])=>url==='/api/settings').length).toBeGreaterThanOrEqual(2));
    const writes=vi.mocked(api).mock.calls.filter(([url])=>url==='/api/settings').map(([,body])=>body as any);
    expect(writes.at(-1)?.orchestratorEffort).toBe('high');expect(writes.at(-1)?.approvalPolicy).toBe('untrusted');
  });
  it('renders pending approval requests with explicit approve and decline actions',async()=>{
    const task={id:'task-approval',title:'Run command',phase:'worker_running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),userRoot:'D:/repo',correctionCount:0,approvalRequests:[{requestId:17,method:'item/commandExecution/requestApproval',itemId:'item-1',threadId:'worker-1',turnId:'turn-1',command:'npm test',cwd:'D:/repo',reason:'Run the requested verification'}],messages:[{id:'m1',role:'user',text:'Run tests',createdAt:new Date().toISOString()}]};
    const activeFixture={...fixture,state:{...fixture.state,tasks:[task],activeTaskId:task.id}};
    const apiMod=await import('../src/ui/api.js');vi.mocked(apiMod.bootstrap).mockResolvedValue({...activeFixture,csrf:'test'} as any);vi.mocked(apiMod.api).mockImplementation(async(path:string)=>path==='/api/state'?activeFixture as any:{} as any);
    render(<App/>);expect(await screen.findByText('Approval needed')).toBeTruthy();expect(screen.getByText('npm test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Approve once'}));
    await waitFor(()=>expect(vi.mocked(apiMod.api).mock.calls.some(([url,body])=>url==='/api/tasks/task-approval/approval'&&(body as any).decision==='accept')).toBe(true));
  });
});
