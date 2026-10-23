// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmbeddedWorkspace } from '../src/ui/EmbeddedWorkspace';

const bridge={
  list:vi.fn(),open:vi.fn(),select:vi.fn(),openSide:vi.fn(),openMain:vi.fn(),openChat:vi.fn(),undock:vi.fn(),close:vi.fn(),navigate:vi.fn(),setCommenting:vi.fn(),annotationOverlay:vi.fn(),setBounds:vi.fn(),hide:vi.fn(),clearData:vi.fn(),onEvent:vi.fn(),
};
vi.mock('../src/ui/api',()=>({api:vi.fn()}));
import { api } from '../src/ui/api';
const tabs=[{id:'one',url:'https://example.com',title:'Example',pane:'main' as const,loading:false}];
const task={id:'task-42',title:'Feature branch',githubLink:{repository:'owner/repo',branch:'feature',baseBranch:'main',updatedAt:'2026-10-23T00:00:00Z'}} as any;
const gitWorkspace={available:true,authorizedRoot:'C:/repo',repositoryRoot:'C:/repo',currentBranch:'feature',branches:[{name:'feature',hash:'12345678',current:true,remote:false},{name:'main',hash:'abcdefgh',current:false,remote:false}],branchPage:{offset:0,pageSize:100,totalCount:2,hasMore:false,nextOffset:null},worktrees:[{path:'C:/repo',head:'12345678',branch:'feature',detached:false,locked:false,prunable:false}],commits:[{hash:'12345678',parents:['abcdefgh'],author:'Test',date:'2026-10-24T00:00:00Z',subject:'Latest work',refs:['HEAD -> feature']}],history:{offset:0,pageSize:100,hasMore:false,nextOffset:null},github:{available:true,authenticated:true,account:'ethan',repository:{name:'owner/repo',url:'https://github.com/owner/repo',defaultBranch:'main'},pullRequests:[],issues:[]}};

beforeEach(()=>{
  vi.clearAllMocks();
  (globalThis as any).ResizeObserver=class { observe(){} disconnect(){} };
  (window as any).pseudoharnessDesktop={browser:bridge};
  bridge.list.mockResolvedValue(tabs);bridge.open.mockResolvedValue(tabs);bridge.select.mockResolvedValue(tabs);bridge.openSide.mockResolvedValue([{...tabs[0],pane:'side'}]);bridge.openMain.mockResolvedValue(tabs);bridge.openChat.mockResolvedValue([{...tabs[0],pane:'chat'}]);bridge.undock.mockResolvedValue(tabs);bridge.close.mockResolvedValue([]);bridge.navigate.mockResolvedValue(tabs);bridge.setCommenting.mockResolvedValue(tabs);bridge.annotationOverlay.mockResolvedValue(tabs);bridge.setBounds.mockResolvedValue(undefined);bridge.hide.mockResolvedValue(undefined);bridge.clearData.mockResolvedValue(true);bridge.onEvent.mockReturnValue(()=>{});
  vi.mocked(api).mockResolvedValue(gitWorkspace as any);
});
afterEach(()=>{cleanup();delete (window as any).pseudoharnessDesktop;});

describe('embedded workspace',()=>{
  it('keeps every browser tab selectable and preserves its tab order across native events',async()=>{
    const original=[{...tabs[0]},{id:'two',url:'https://example.org',title:'Second',pane:'hidden' as const,loading:false},{id:'three',url:'https://example.net',title:'Third',pane:'hidden' as const,loading:false}];
    const switched=original.map(tab=>({...tab,pane:tab.id==='two'?'main' as const:'hidden' as const}));bridge.list.mockResolvedValue(original as any);let receiveEvent:(event:any)=>void=()=>{};bridge.onEvent.mockImplementation(callback=>{receiveEvent=callback;return ()=>{};});
    bridge.select.mockImplementation(async(id,pane)=>original.map(tab=>({...tab,pane:tab.id===id?pane:tab.id==='one'&&pane==='main'?'hidden':tab.pane})) as any);
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false}/>);
    expect(await screen.findByRole('tab',{name:'Second'})).toBeTruthy();expect(screen.getByRole('tab',{name:'Third'})).toBeTruthy();
    fireEvent.click(screen.getByRole('tab',{name:'Second'}));await waitFor(()=>expect(bridge.select).toHaveBeenCalledWith('two','main'));
    const dataTransfer={setData:vi.fn(),getData:vi.fn(()=> 'three'),effectAllowed:''};fireEvent.dragStart(screen.getAllByRole('presentation')[2],{dataTransfer});fireEvent.drop(screen.getAllByRole('presentation')[1],{dataTransfer});
    expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['Summary','Example','Third','Browser']);
    receiveEvent({type:'updated',tabs:switched});expect(screen.getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['Summary','Example','Third','Browser']);
  });

  it('opens an existing tab beside the current page when dragged into the side drop zone',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false}/>);
    const dataTransfer={setData:vi.fn(),getData:vi.fn(()=> 'one'),effectAllowed:''};
    const tab=await screen.findByRole('presentation');
    fireEvent.dragStart(tab,{dataTransfer});
    fireEvent.drop(document.querySelector('.native-side-drop')!,{dataTransfer});
    await waitFor(()=>expect(bridge.openSide).toHaveBeenCalledWith('one'));
    expect(screen.queryByRole('button',{name:/dock|side pane|main pane|full view/i})).toBeNull();
  });

  it('shows native repository and local Git data without opening github.com',async()=>{
    vi.mocked(api).mockImplementation(async(url)=>String(url).endsWith('/github')?gitWorkspace.github as any:gitWorkspace as any);
    render(<EmbeddedWorkspace mode="github" task={task} placement="full" docked={false}/>);
    expect(await screen.findByText('owner/repo')).toBeTruthy();expect(await screen.findByText('Latest work')).toBeTruthy();expect(vi.mocked(api)).toHaveBeenCalledWith('/api/tasks/task-42/git-workspace?offset=0&branchOffset=0',undefined,expect.any(AbortSignal));expect(vi.mocked(api)).toHaveBeenCalledWith('/api/tasks/task-42/git-workspace/github',undefined,expect.any(AbortSignal));expect(bridge.open).not.toHaveBeenCalled();
  });

  it('does not attach a stale annotation to a replacement task or wrong split-pane tab',async()=>{
    const taskTwo={...task,id:'task-43'};let receive:(event:any)=>void=()=>{};const onAnnotation=vi.fn();
    bridge.onEvent.mockImplementation(callback=>{receive=callback;return ()=>{};});
    const splitTabs=[{...tabs[0],pane:'main' as const},{id:'chat-tab',url:'https://example.net',title:'Chat page',pane:'chat' as const,loading:false}];bridge.list.mockResolvedValue(splitTabs as any);bridge.openChat.mockResolvedValue(splitTabs as any);
    const view=render(<EmbeddedWorkspace mode="browser" task={task} placement="side" docked onAnnotation={onAnnotation}/>);
    await waitFor(()=>expect(bridge.openChat).toHaveBeenCalledWith('one'));
    const annotation={url:'https://example.com',title:'Example',target:'heading',selectedText:'selected'};
    await act(async()=>receive({type:'annotation',tabs:splitTabs,tab:{id:'one',url:'https://example.com',title:'Example'},annotation}));
    expect(bridge.annotationOverlay).toHaveBeenCalledWith('one',false);expect(screen.queryByText('Page annotation')).toBeNull();
    await act(async()=>receive({type:'annotation',tabs:splitTabs,tab:{id:'chat-tab',url:'https://example.net',title:'Chat page'},annotation}));
    expect(await screen.findByText('Page annotation')).toBeTruthy();
    view.rerender(<EmbeddedWorkspace mode="browser" task={taskTwo} placement="side" docked onAnnotation={onAnnotation}/>);
    await waitFor(()=>expect(screen.queryByText('Page annotation')).toBeNull());
    expect(onAnnotation).not.toHaveBeenCalled();expect(bridge.annotationOverlay).toHaveBeenCalledWith('chat-tab',false);
  });
});
