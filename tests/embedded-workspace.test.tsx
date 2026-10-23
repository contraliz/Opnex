// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmbeddedWorkspace } from '../src/ui/EmbeddedWorkspace';

const bridge={
  list:vi.fn(),open:vi.fn(),select:vi.fn(),openSide:vi.fn(),openMain:vi.fn(),openChat:vi.fn(),undock:vi.fn(),close:vi.fn(),navigate:vi.fn(),setBounds:vi.fn(),hide:vi.fn(),clearData:vi.fn(),onEvent:vi.fn(),
};
vi.mock('../src/ui/api',()=>({api:vi.fn()}));
import { api } from '../src/ui/api';
const tabs=[{id:'one',url:'https://example.com',title:'Example',pane:'main' as const,loading:false}];
const task={id:'task-42',title:'Feature branch',githubLink:{repository:'owner/repo',branch:'feature',baseBranch:'main',updatedAt:'2026-10-23T00:00:00Z'}} as any;
const workspace={available:true,authenticated:true,account:'ethan',branch:'feature',repository:{name:'owner/repo',url:'https://github.com/owner/repo',defaultBranch:'main'}};

beforeEach(()=>{
  vi.clearAllMocks();
  (globalThis as any).ResizeObserver=class { observe(){} disconnect(){} };
  (window as any).pseudoharnessDesktop={browser:bridge};
  bridge.list.mockResolvedValue(tabs);bridge.open.mockResolvedValue(tabs);bridge.select.mockResolvedValue(tabs);bridge.openSide.mockResolvedValue([{...tabs[0],pane:'side'}]);bridge.openMain.mockResolvedValue(tabs);bridge.openChat.mockResolvedValue([{...tabs[0],pane:'chat'}]);bridge.undock.mockResolvedValue(tabs);bridge.close.mockResolvedValue([]);bridge.navigate.mockResolvedValue(tabs);bridge.setBounds.mockResolvedValue(undefined);bridge.hide.mockResolvedValue(undefined);bridge.clearData.mockResolvedValue(true);bridge.onEvent.mockReturnValue(()=>{});
  vi.mocked(api).mockResolvedValue({workspace,link:task.githubLink} as any);
});
afterEach(()=>{cleanup();delete (window as any).pseudoharnessDesktop;});

describe('embedded workspace',()=>{
  it('moves a native browser tab into the side pane by dragging it to the workspace edge',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false}/>);
    const dataTransfer={setData:vi.fn(),getData:vi.fn(()=> 'one'),types:['application/x-pseudoharness-browser-tab'],effectAllowed:''};
    const tab=await screen.findByRole('presentation');
    fireEvent.dragStart(tab,{dataTransfer});
    const main=document.querySelector('.native-browser-host')!;
    fireEvent.dragOver(main,{dataTransfer,clientX:100});
    fireEvent.drop(main,{dataTransfer,clientX:100});
    await waitFor(()=>expect(bridge.openSide).toHaveBeenCalledWith('one'));
    expect(screen.queryByRole('button',{name:/side pane|main pane|Dock beside chat/i})).toBeNull();
  });

  it('shows saved task context and performs push only after an explicit user action',async()=>{
    vi.mocked(api).mockImplementation(async(url:string)=>{
      if(url==='/api/tasks/task-42/github')return {workspace,link:task.githubLink} as any;
      if(url==='/api/tasks/task-42/github/push')return {result:{pushed:true,message:'Pushed committed changes on feature to origin.'},workspace,link:task.githubLink} as any;
      return {} as any;
    });
    render(<EmbeddedWorkspace mode="github" task={task} placement="full" docked={false}/>);
    expect(await screen.findByText('owner/repo')).toBeTruthy();
    expect((screen.getByRole('textbox',{name:'Head branch'}) as HTMLInputElement).value).toBe('feature');
    fireEvent.click(screen.getByRole('button',{name:'Push committed changes'}));
    await waitFor(()=>expect(api).toHaveBeenCalledWith('/api/tasks/task-42/github/push',{remote:'origin',branch:'feature'}));
    expect(await screen.findByText('Pushed committed changes on feature to origin.')).toBeTruthy();
  });

  it('does not expose a separate docking button',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false}/>);
    expect(await screen.findByRole('tab',{name:/Example/})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/dock|side pane|main pane|open full workspace/i})).toBeNull();
  });
});
