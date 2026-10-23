// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('moves an existing native tab into the side pane through an accessible control',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} onDock={()=>{}} onUndock={()=>{}}/>);
    const side=await screen.findByRole('button',{name:'Open Example in side pane'});
    fireEvent.click(side);
    await waitFor(()=>expect(bridge.openSide).toHaveBeenCalledWith('one'));
    expect(await screen.findByLabelText('Example')).toBeTruthy();
    expect(screen.getAllByRole('button',{name:'Move side tab to main pane'}).length).toBe(1);
  });

  it('opens an existing tab beside the current page when dragged into the side drop zone',async()=>{
    render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} onDock={()=>{}} onUndock={()=>{}}/>);
    const dataTransfer={setData:vi.fn(),getData:vi.fn(()=> 'one'),effectAllowed:''};
    const tab=await screen.findByRole('presentation');
    fireEvent.dragStart(tab,{dataTransfer});
    fireEvent.drop(document.querySelector('.native-side-drop')!,{dataTransfer});
    await waitFor(()=>expect(bridge.openSide).toHaveBeenCalledWith('one'));
    expect(screen.getAllByRole('button',{name:'Move side tab to main pane'}).length).toBe(1);
  });

  it('shows saved task context and performs push only after an explicit user action',async()=>{
    vi.mocked(api).mockImplementation(async(url:string)=>{
      if(url==='/api/tasks/task-42/github')return {workspace,link:task.githubLink} as any;
      if(url==='/api/tasks/task-42/github/push')return {result:{pushed:true,message:'Pushed committed changes on feature to origin.'},workspace,link:task.githubLink} as any;
      return {} as any;
    });
    render(<EmbeddedWorkspace mode="github" task={task} placement="full" docked={false} onDock={()=>{}} onUndock={()=>{}}/>);
    expect(await screen.findByText('owner/repo')).toBeTruthy();
    expect((screen.getByRole('textbox',{name:'Head branch'}) as HTMLInputElement).value).toBe('feature');
    fireEvent.click(screen.getByRole('button',{name:'Push committed changes'}));
    await waitFor(()=>expect(api).toHaveBeenCalledWith('/api/tasks/task-42/github/push',{remote:'origin',branch:'feature'}));
    expect(await screen.findByText('Pushed committed changes on feature to origin.')).toBeTruthy();
  });

  it('docks the same native tab beside the task and undocks that tab back to the full workspace',async()=>{
    const onUndock=vi.fn();const {container,rerender}=render(<EmbeddedWorkspace mode="github" task={task} placement="side" docked onDock={()=>{}} onUndock={onUndock}/>);
    await waitFor(()=>expect(bridge.openChat).toHaveBeenCalledWith('one'));
    expect(container.querySelector('.chat-docked-workspace')?.classList.contains('is-hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'Open full workspace'}));rerender(<EmbeddedWorkspace mode="github" task={task} placement="full" docked={false} onDock={()=>{}} onUndock={onUndock}/>);
    await waitFor(()=>expect(bridge.undock).toHaveBeenCalledWith('one'));
    expect(onUndock).toHaveBeenCalledTimes(1);
  });
  it('offers a keyboard-operable workspace dock control',async()=>{
    const user=userEvent.setup();const onDock=vi.fn();render(<EmbeddedWorkspace mode="browser" task={null} placement="full" docked={false} onDock={onDock} onUndock={()=>{}}/>);
    const button=await screen.findByRole('button',{name:'Dock beside chat'});button.focus();await user.keyboard('{Enter}');expect(onDock).toHaveBeenCalledWith('browser');
  });
});
