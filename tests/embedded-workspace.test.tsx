// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmbeddedWorkspace } from '../src/ui/EmbeddedWorkspace';

const page=(overrides:Record<string,unknown>={})=>({id:'page-1',workspaceId:'browser:test',url:'https://example.com/',title:'Example Domain',pane:'hidden' as const,loading:false,canGoBack:true,canGoForward:false,...overrides});
const listeners=new Set<(event:any)=>void>();
const bridge={
  list:vi.fn(),open:vi.fn(),select:vi.fn(),openSide:vi.fn(),openMain:vi.fn(),openChat:vi.fn(),undock:vi.fn(),close:vi.fn(),navigate:vi.fn(),setCommenting:vi.fn(),annotationOverlay:vi.fn(),setBounds:vi.fn(),hide:vi.fn(),clearData:vi.fn(),
  workspaceGet:vi.fn(),workspaceOpen:vi.fn(),workspaceRelease:vi.fn(),workspaceSetBounds:vi.fn(),workspaceNavigate:vi.fn(),workspaceSetCommenting:vi.fn(),workspaceAnnotationOverlay:vi.fn(),
  onEvent:vi.fn(),
};
vi.mock('../src/ui/api',()=>({api:vi.fn()}));
import { api } from '../src/ui/api';
const task={id:'task-42',title:'Feature branch'} as any;
const gitWorkspace={available:true,authorizedRoot:'C:/repo',repositoryRoot:'C:/repo',currentBranch:'feature',branches:[{name:'feature',hash:'12345678',current:true,remote:false}],branchPage:{offset:0,pageSize:100,totalCount:1,hasMore:false,nextOffset:null},worktrees:[],commits:[{hash:'12345678',parents:[],author:'Test',date:'2026-10-24T00:00:00Z',subject:'Latest work',refs:['HEAD -> feature']}],history:{offset:0,pageSize:100,hasMore:false,nextOffset:null},github:{available:true,authenticated:true,account:'ethan',repository:{name:'owner/repo',url:'https://github.com/owner/repo',defaultBranch:'main'},pullRequests:[],issues:[]}};

beforeEach(()=>{
  vi.clearAllMocks();listeners.clear();
  (globalThis as any).ResizeObserver=class { observe(){} disconnect(){} };
  (window as any).pseudoharnessDesktop={browser:bridge};
  bridge.workspaceOpen.mockResolvedValue(page());bridge.workspaceGet.mockResolvedValue(page());bridge.workspaceRelease.mockResolvedValue(undefined);bridge.workspaceSetBounds.mockResolvedValue(undefined);bridge.workspaceNavigate.mockImplementation(async(_id,navigation)=>page(typeof navigation==='object'?{url:navigation.url,title:'Navigated'}:navigation==='back'?{url:'https://example.com/',title:'Example Domain'}:{}));bridge.workspaceSetCommenting.mockResolvedValue(undefined);bridge.workspaceAnnotationOverlay.mockResolvedValue(undefined);bridge.onEvent.mockImplementation(callback=>{listeners.add(callback);return()=>listeners.delete(callback);});
  vi.mocked(api).mockImplementation(async(url)=>String(url)==='/api/github/auth'?({state:'idle',cliAvailable:true,authenticated:false} as any):gitWorkspace as any);
});
afterEach(()=>{cleanup();delete (window as any).pseudoharnessDesktop;});

describe('native embedded browser workspace',()=>{
  it('opens one persistent page per workspace ID and shows address suggestions without nested browser tabs',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={task} placement="full" docked={false} workspaceId="browser:test" active/>);
    expect(await screen.findByRole('combobox',{name:'Website address'})).toBeTruthy();
    expect(bridge.workspaceOpen).toHaveBeenCalledWith('browser:test','https://www.google.com/');
    expect(screen.queryByRole('tab')).toBeNull();expect(screen.queryByText('Summary')).toBeNull();
    const address=screen.getByRole('combobox',{name:'Website address'});
    fireEvent.focus(address);fireEvent.change(address,{target:{value:'github'}});
    expect(await screen.findByRole('option',{name:/GitHub device sign-in/})).toBeTruthy();
    fireEvent.keyDown(address,{key:'ArrowDown'});fireEvent.keyDown(address,{key:'Enter'});
    await waitFor(()=>expect(bridge.workspaceNavigate).toHaveBeenCalledWith('browser:test',{url:'https://github.com/'}));
  });

  it('normalizes bare hosts, preserves explicit local HTTP and rejects credentials and unsafe schemes',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} workspaceId="browser:address"/>);
    const address=await screen.findByRole('combobox',{name:'Website address'});
    fireEvent.change(address,{target:{value:'example.org'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
    await waitFor(()=>expect(bridge.workspaceNavigate).toHaveBeenCalledWith('browser:address',{url:'https://example.org/'}));
    fireEvent.change(address,{target:{value:'http://127.0.0.1:4567/fixture'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
    await waitFor(()=>expect(bridge.workspaceNavigate).toHaveBeenCalledWith('browser:address',{url:'http://127.0.0.1:4567/fixture'}));
    const before=bridge.workspaceNavigate.mock.calls.length;
    fireEvent.change(address,{target:{value:'https://user:secret@example.org'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
    expect((await screen.findByRole('alert')).textContent).toContain('credentials');
    fireEvent.change(address,{target:{value:'javascript:alert(1)'}});fireEvent.click(screen.getByRole('button',{name:'Go'}));
    expect(bridge.workspaceNavigate).toHaveBeenCalledTimes(before);
  });

  it('routes back, forward, reload and popups to the owned page or a peer app workspace',async()=>{
    const openBrowser=vi.fn();let receive:(event:any)=>void=()=>{};bridge.onEvent.mockImplementation(callback=>{receive=callback;return()=>{};});
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} workspaceId="browser:owned" onOpenBrowserTab={openBrowser}/>);
    await screen.findByRole('button',{name:'Back'});fireEvent.click(screen.getByRole('button',{name:'Back'}));fireEvent.click(screen.getByRole('button',{name:'Reload'}));
    await waitFor(()=>expect(bridge.workspaceNavigate).toHaveBeenCalledWith('browser:owned','back'));
    expect(bridge.workspaceNavigate).toHaveBeenCalledWith('browser:owned','reload');
    await act(async()=>receive({type:'open-request',workspaceId:'browser:owned',url:'https://github.com/login/device',tabs:[page()]}));
    expect(openBrowser).toHaveBeenCalledWith('https://github.com/login/device');
  });

  it('updates native bounds for the active body and hides its view when switched away',async()=>{
    const original=HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect=function(){if(this.classList.contains('native-browser-workspace'))return {x:10,y:20,left:10,top:20,right:910,bottom:720,width:900,height:700,toJSON(){}} as DOMRect;if(this.classList.contains('native-browser-page'))return {x:10,y:70,left:10,top:70,right:910,bottom:720,width:900,height:650,toJSON(){}} as DOMRect;return original.call(this);};
    try{
      const view=render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} workspaceId="browser:bounds" active/>);
      await waitFor(()=>expect(bridge.workspaceSetBounds).toHaveBeenCalledWith('browser:bounds',expect.objectContaining({x:10,y:70,width:900,height:650}),true));
      view.rerender(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} workspaceId="browser:bounds" active={false}/>);
      await waitFor(()=>expect(bridge.workspaceSetBounds).toHaveBeenCalledWith('browser:bounds',expect.any(Object),false));
    }finally{HTMLElement.prototype.getBoundingClientRect=original;}
  });

  it('releases only the workspace it owns and forwards captured task/root to local Git',async()=>{
    const view=render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} workspaceId="browser:release"/>);
    await screen.findByRole('combobox',{name:'Website address'});view.unmount();
    await waitFor(()=>expect(bridge.workspaceRelease).toHaveBeenCalledWith('browser:release'));
    vi.mocked(api).mockImplementation(async url=>String(url)==='/api/github/auth'?({state:'idle',cliAvailable:true,authenticated:false} as any):String(url).endsWith('/github')?gitWorkspace.github as any:gitWorkspace as any);
    render(<EmbeddedWorkspace mode="github" task={task} placement="full" docked={false} workspaceId="git:captured" projectRoot="D:/project-at-open"/>);
    expect(await screen.findByText('owner/repo')).toBeTruthy();
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/tasks/task-42/git-workspace?offset=0&branchOffset=0',undefined,expect.any(AbortSignal));
    expect(vi.mocked(api)).toHaveBeenCalledWith('/api/tasks/task-42/git-workspace/github',undefined,expect.any(AbortSignal));
    expect(bridge.open).not.toHaveBeenCalled();
  });
});
