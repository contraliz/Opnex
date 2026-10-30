// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/ui/App.js';

const demoProject={id:'11111111-1111-4111-8111-111111111111',name:'Demo project',projectRoot:'D:/workspace/demo',needsLocation:false,pinned:false,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'};
const fixture={state:{version:5,settings:{deepseekProvider:'opencode-go',deepseekModel:'deepseek-v4.1-flash',deepseekReasoningEffort:'max',orchestratorModel:'gpt-6.1-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},tasks:[],activeTaskId:null,projects:[demoProject],selectedProjectId:demoProject.id,expandedProjectIds:[demoProject.id,'unclassified']},runtime:{codex:{state:'connected',error:'',models:[{id:'gpt-6.1-sol',displayName:'GPT-6.1 Sol',efforts:['low']},{id:'gpt-6-astra',displayName:'GPT-6 Astra',efforts:['medium','high']},{id:'gpt-6-luna',displayName:'GPT-6 Luna',efforts:['high']}],workerAvailable:true}}};
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
    expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Worker model'}));
    for(let index=0;index<2;index++)await user.tab({shift:true});
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Save settings'}));
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'Close settings'}));
    await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
    await waitFor(()=>expect(document.activeElement).toBe(opener));
  });

  it('gives the nested directory picker focus and Escape priority, then returns to Browse',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const opener=screen.getByRole('button',{name:'Configure workspace demo'});await user.click(opener);
    const settings=await screen.findByRole('dialog',{name:'Configure demo'});
    const browse=within(settings).getByRole('button',{name:'Browse workspace folders'});
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
    expect(screen.getByRole('dialog',{name:'Configure demo'})).toBeTruthy();
    await waitFor(()=>expect(document.activeElement).toBe(browse));
    await user.keyboard('{Escape}');
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Configure demo'})).toBeNull());
    expect(windowEscape).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it('discards canceled drafts, retains failed saves, and persists successful saves',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    const opener=screen.getByRole('button',{name:'Settings'});await user.click(opener);
    let dialog=await screen.findByRole('dialog',{name:'Settings'});
    let model=within(dialog).getByRole('button',{name:'Worker model'});
    expect(model.textContent).toContain('GPT-6 Luna');
    await user.click(model);await user.click(within(dialog).getByRole('option',{name:/DeepSeek V4.1 Flash/}));
    expect(model.textContent).toContain('DeepSeek V4.1 Flash');
    await user.click(within(dialog).getByRole('button',{name:'Cancel'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());

    await user.click(opener);dialog=await screen.findByRole('dialog',{name:'Settings'});
    model=within(dialog).getByRole('button',{name:'Worker model'});
    expect(model.textContent).toContain('GPT-6 Luna');
    await user.click(model);await user.click(within(dialog).getByRole('option',{name:/DeepSeek V4.1 Flash/}));failSettingsSave=true;
    await user.click(within(dialog).getByRole('button',{name:'Save settings'}));
    await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Save settings'}).textContent).toBe('Save settings'));
    expect(screen.getByRole('dialog',{name:'Settings'})).toBeTruthy();
    expect(within(dialog).getByRole('button',{name:'Worker model'}).textContent).toContain('DeepSeek V4.1 Flash');
    expect(serverState.settings.executionProfile).toBeUndefined();

    failSettingsSave=false;
    await user.click(within(dialog).getByRole('button',{name:'Save settings'}));
    await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Settings'})).toBeNull());
    expect(serverState.settings.executionProfile).toEqual({provider:'deepseek',model:'deepseek-v4.1-flash',effort:'max'});
    expect(serverState.settings.deepseekProvider).toBe('opencode-go');
    await user.click(opener);dialog=await screen.findByRole('dialog',{name:'Settings'});
    expect(within(dialog).getByRole('button',{name:'Worker model'}).textContent).toContain('DeepSeek V4.1 Flash');
  });

  it('preserves active edits when a separate settings field changes in a live state update',async()=>{
    const user=userEvent.setup();render(<App/>);await screen.findByRole('textbox',{name:'Task message'});
    await user.click(screen.getByRole('button',{name:'Settings'}));
    const dialog=await screen.findByRole('dialog',{name:'Settings'});
    const model=within(dialog).getByRole('button',{name:'Worker model'});
    await user.click(model);await user.click(within(dialog).getByRole('option',{name:/DeepSeek V4.1 Flash/}));
    const externalState={...serverState,settings:{...serverState.settings,orchestratorEffort:'high'}};
    act(()=>eventSource.onmessage({data:JSON.stringify({state:externalState,runtime:fixture.runtime})}));
    expect(within(dialog).getByRole('button',{name:'Worker model'}).textContent).toContain('DeepSeek V4.1 Flash');
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
