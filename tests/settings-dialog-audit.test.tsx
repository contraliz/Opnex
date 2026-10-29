// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/ui/App.js';

const fixture={state:{version:3,settings:{projectRoot:'D:/workspace/demo',agentmemProjectId:'demo-project',deepseekProvider:'opencode-go',deepseekModel:'deepseek-v4.1-flash',deepseekReasoningEffort:'max',orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:[],activeTaskId:null,projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']},runtime:{codex:{state:'connected',error:'',models:[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',efforts:['low']},{id:'gpt-6-astra',displayName:'GPT-6 Astra',efforts:['medium','high']},{id:'gpt-6-luna',displayName:'GPT-6 Luna',efforts:['high']}],workerAvailable:true},agentmem:{connected:true,projectVerified:true,detail:'Connected · demo-project'}}};
const isSnapshotRoute=(path:string)=>path==='/api/state'||path==='/api/v1/snapshot';
let serverState:any;
let eventSource:any;
let observedWindowKeydown:((event:KeyboardEvent)=>void)|null=null;
let failSettingsSave=false;
vi.mock('../src/ui/api.js',()=>({KERNEL_PROTOCOL_VERSION:1,bootstrap:vi.fn(async()=>({state:serverState,runtime:fixture.runtime,csrf:'test'})),api:vi.fn(async(path:string)=>isSnapshotRoute(path)?{state:serverState,runtime:fixture.runtime}:{}),apiPut:vi.fn(async()=>({}))}));

function nativeWorkspaceBridge(){const pages=new Map<string,any>();const listeners=new Set<(event:any)=>void>();return {workspaceGet:vi.fn(async(id:string)=>pages.get(id)||null),workspaceOpen:vi.fn(async(workspaceId:string,url:string)=>{const page={id:workspaceId,workspaceId,url,title:new URL(url).hostname,pane:'hidden',loading:false,canGoBack:false,canGoForward:false};pages.set(workspaceId,page);return page;}),workspaceRelease:vi.fn(async(id:string)=>{pages.delete(id);}),workspaceSetBounds:vi.fn(async()=>{}),workspaceNavigate:vi.fn(async()=>{}),workspaceSetCommenting:vi.fn(async()=>{}),workspaceAnnotationOverlay:vi.fn(async()=>{}),onEvent:vi.fn((callback:(event:any)=>void)=>{listeners.add(callback);return()=>listeners.delete(callback);})};}

beforeEach(async()=>{
  vi.clearAllMocks();delete (window as any).pseudoharnessDesktop;eventSource=undefined;failSettingsSave=false;serverState={...fixture.state,settings:{...fixture.state.settings}};
  const range=Range.prototype as any;range.getClientRects??=()=>[];range.getBoundingClientRect??=()=>new DOMRect(0,0,0,0);
  (globalThis as any).EventSource=class{onmessage:any;onerror:any;constructor(){eventSource=this;}close(){}};
  const apiMod=await import('../src/ui/api.js');
  vi.mocked(apiMod.bootstrap).mockImplementation(async()=>({state:serverState,runtime:fixture.runtime,csrf:'test'} as any));
  vi.mocked(apiMod.api).mockImplementation(async(path:string,body:any)=>{
    if(isSnapshotRoute(path))return {state:serverState,runtime:fixture.runtime} as any;
    if(path==='/api/settings'){
      if(failSettingsSave)throw new Error('Save failed for the focused regression test.');
      serverState={...serverState,settings:{...body}};return {} as any;
    }
    if(path==='/api/agentmem/projects')return {projects:[]} as any;
    if(path.startsWith('/api/directories'))return {path:'D:/workspace/demo',parent:'D:/workspace',entries:[{name:'one',path:'D:/workspace/demo/one'}],truncated:false} as any;
    if(path==='/api/skills'||path.startsWith('/api/skills?'))return {skills:[]} as any;
    return {} as any;
  });
});

afterEach(()=>{
  if(observedWindowKeydown)window.removeEventListener('keydown',observedWindowKeydown);
  observedWindowKeydown=null;cleanup();delete (window as any).pseudoharnessDesktop;
});

describe('Settings audit regressions',()=>{
  it('keeps reverse and forward Tab inside Settings and restores the opener',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
    const dialog=await screen.findByRole('dialog',{name:'Settings'});
    expect(document.activeElement).toBe(screen.getByRole('textbox',{name:/Project root/}));
    for(let index=0;index<3;index++)await user.tab({shift:true});
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Save settings'}));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Close settings'}));
    await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
    await waitFor(()=>expect(document.activeElement).toBe(opener));
  });

  it('gives the nested directory picker focus and Escape priority, then returns to Browse',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
    const settings=await screen.findByRole('dialog',{name:'Settings'});
    const browse=within(settings).getByRole('button',{name:'Browse project root folders'});
    const windowEscape=vi.fn();observedWindowKeydown=windowEscape;window.addEventListener('keydown',windowEscape);
    await user.click(browse);
    const picker=await screen.findByRole('dialog',{name:'Choose a folder'});
    await screen.findByText('one');
    const path=within(picker).getByRole('textbox',{name:'Folder path'});
    expect(document.activeElement).toBe(path);
    const useFolder=within(picker).getByRole('button',{name:'Use this folder'});
    await waitFor(()=>expect((useFolder as HTMLButtonElement).disabled).toBe(false));
    const cancelPicker=within(picker).getByRole('button',{name:'Cancel folder selection'});
    await user.tab({shift:true});expect(document.activeElement).toBe(cancelPicker);
    await user.tab({shift:true});
    expect(picker.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(useFolder);
    await user.tab();expect(document.activeElement).toBe(cancelPicker);
    windowEscape.mockClear();
    await user.keyboard('{Escape}');
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Choose a folder'})).toBeNull());
    expect(windowEscape).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeTruthy();
    await waitFor(()=>expect(document.activeElement).toBe(browse));
    await user.keyboard('{Escape}');
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());
    expect(windowEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('discards canceled drafts, retains failed saves, and persists successful saves',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
    let dialog=await screen.findByRole('dialog',{name:'Settings'});
    let model=within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement;
    expect(model.value).toBe('deepseek-v4.1-flash');
    await user.type(model,'cancelled-model-draft',{initialSelectionStart:0,initialSelectionEnd:model.value.length});
    await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());

    await user.click(opener);dialog=await screen.findByRole('dialog',{name:'Settings'});
    model=within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement;
    expect(model.value).toBe('deepseek-v4.1-flash');
    await user.type(model,'failed-save-model',{initialSelectionStart:0,initialSelectionEnd:model.value.length});failSettingsSave=true;
    await user.click(within(dialog).getByRole('button',{name:'Save settings'}));
    await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Save settings'}).textContent).toBe('Save settings'));
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeTruthy();
    expect((within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement).value).toBe('failed-save-model');
    expect(serverState.settings.deepseekModel).toBe('deepseek-v4.1-flash');

    failSettingsSave=false;
    await user.type(model,'successful-save-model',{initialSelectionStart:0,initialSelectionEnd:model.value.length});
    await user.click(within(dialog).getByRole('button',{name:'Save settings'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());
    expect(serverState.settings.deepseekModel).toBe('successful-save-model');
    await user.click(opener);dialog=await screen.findByRole('dialog',{name:'Settings'});
    expect((within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement).value).toBe('successful-save-model');
  });

  it('preserves active edits when a separate settings field changes in a live state update',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    await user.click(screen.getByRole('button',{name:'Settings'}));
    const dialog=await screen.findByRole('dialog',{name:'Settings'});
    const model=within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement;
    await user.type(model,'local-unsaved-model',{initialSelectionStart:0,initialSelectionEnd:model.value.length});
    const externalState={...serverState,settings:{...serverState.settings,orchestratorEffort:'high'}};
    act(()=>eventSource.onmessage({data:JSON.stringify({state:externalState,runtime:fixture.runtime})}));
    expect((within(dialog).getByRole('textbox',{name:'DeepSeek Harness model'}) as HTMLInputElement).value).toBe('local-unsaved-model');
  });

  it('lets ChoicePopover Escape close only the menu before Settings, including its Composer caller',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const composerChoice=screen.getByRole('button',{name:'Approval policy'});
    await user.click(composerChoice);await waitFor(()=>expect(composerChoice.getAttribute('aria-expanded')).toBe('true'));
    await user.keyboard('{Escape}');await waitFor(()=>expect(composerChoice.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull();

    const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
    const dialog=await screen.findByRole('dialog',{name:'Settings'});
    const settingsChoice=within(dialog).getByRole('button',{name:'Approval policy'});
    await user.click(settingsChoice);await waitFor(()=>expect(settingsChoice.getAttribute('aria-expanded')).toBe('true'));
    const windowEscape=vi.fn();observedWindowKeydown=windowEscape;window.addEventListener('keydown',windowEscape);
    await user.keyboard('{Escape}');
    expect(settingsChoice.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeTruthy();
    expect(windowEscape).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());
    expect(windowEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('opens Settings from Sessions, Browser, Git, and Skills workspaces',async()=>{
    const user=userEvent.setup();(window as any).pseudoharnessDesktop=nativeWorkspaceBridge();render(<App/>);
    await screen.findByRole('textbox',{name:'Task message'});
    for(const kind of ['Sessions','Browser','Git','Skills']){
      await user.click(screen.getByRole('tab',{name:kind}));
      if(kind!=='Sessions')await waitFor(()=>expect(document.querySelector(`.activity-rail [aria-label="${kind}"]`)?.getAttribute('aria-current')).toBe('page'));
      const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
      const dialog=await screen.findByRole('dialog',{name:'Settings'});
      expect(dialog).toBeTruthy();
      await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
      await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());
    }
  });
});
