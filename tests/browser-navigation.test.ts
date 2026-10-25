import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {navigationState,navigate,attachNavigationHandlers}=require('../desktop/browser-navigation.cjs') as {
  navigationState:(contents:any)=>{canGoBack:boolean;canGoForward:boolean};
  navigate:(contents:any,action:string)=>void;
  attachNavigationHandlers:(contents:any,handlers:{validateUrl:(url:string)=>unknown;onMainFrameStart:(url:string)=>void})=>void;
};

function contents(history:{back:boolean;forward:boolean}){
  return {
    navigationHistory:{
      canGoBack:vi.fn(()=>history.back),
      canGoForward:vi.fn(()=>history.forward),
      goBack:vi.fn(),
      goForward:vi.fn(),
    },
    canGoBack:()=>{throw new Error('Deprecated webContents.canGoBack() was called.');},
    canGoForward:()=>{throw new Error('Deprecated webContents.canGoForward() was called.');},
    goBack:()=>{throw new Error('Deprecated webContents.goBack() was called.');},
    goForward:()=>{throw new Error('Deprecated webContents.goForward() was called.');},
    reload:vi.fn(),
  };
}

describe('native browser navigation history',()=>{
  it('reads back and forward availability from navigationHistory',()=>{
    const page=contents({back:true,forward:false});
    expect(navigationState(page)).toEqual({canGoBack:true,canGoForward:false});
    expect(page.navigationHistory.canGoBack).toHaveBeenCalledOnce();
    expect(page.navigationHistory.canGoForward).toHaveBeenCalledOnce();
  });

  it('guards back and forward actions against the matching history capability',()=>{
    const page=contents({back:false,forward:true});
    navigate(page,'back');
    navigate(page,'forward');
    expect(page.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(page.navigationHistory.goForward).toHaveBeenCalledOnce();

    page.navigationHistory.canGoBack.mockReturnValue(true);
    navigate(page,'back');
    expect(page.navigationHistory.goBack).toHaveBeenCalledOnce();
  });

  it('keeps reload on WebContents and ignores an unrecognized legacy action',()=>{
    const page=contents({back:false,forward:false});
    Object.defineProperty(page,'navigationHistory',{get(){throw new Error('Reload and unknown actions must not consult navigation history.');}});
    navigate(page,'reload');
    navigate(page,'unknown');
    expect(page.reload).toHaveBeenCalledOnce();
  });
});

describe('Electron navigation event details',()=>{
  function eventHandlers(){
    const handlers=new Map<string,(details:any,...legacyArgs:any[])=>void>();
    return {
      handlers,
      contents:{on:vi.fn((name:string,handler:(details:any,...legacyArgs:any[])=>void)=>handlers.set(name,handler))},
    };
  }

  it('validates URLs from the will-navigate and will-redirect details objects',()=>{
    const {contents,handlers}=eventHandlers();
    const validateUrl=vi.fn((url:string)=>{if(!url.startsWith('https://'))throw new Error('Blocked URL');});
    attachNavigationHandlers(contents,{validateUrl,onMainFrameStart:vi.fn()});

    for(const name of ['will-navigate','will-redirect']){
      const allow={url:'https://safe.example/',preventDefault:vi.fn()};
      handlers.get(name)?.(allow,'https://legacy-argument.example/');
      expect(allow.preventDefault).not.toHaveBeenCalled();
      const block={url:'file:///etc/passwd',preventDefault:vi.fn()};
      handlers.get(name)?.(block,'https://legacy-argument.example/');
      expect(block.preventDefault).toHaveBeenCalledOnce();
    }
    expect(validateUrl).toHaveBeenNthCalledWith(1,'https://safe.example/');
    expect(validateUrl).toHaveBeenNthCalledWith(2,'file:///etc/passwd');
    expect(contents.on).toHaveBeenCalledTimes(3);
  });

  it('updates navigation state only for main-frame did-start-navigation details',()=>{
    const {contents,handlers}=eventHandlers();
    const onMainFrameStart=vi.fn();
    attachNavigationHandlers(contents,{validateUrl:vi.fn(),onMainFrameStart});

    handlers.get('did-start-navigation')?.({url:'https://frame.example/',isMainFrame:false},'https://legacy-argument.example/',false,true);
    handlers.get('did-start-navigation')?.({url:'https://main.example/',isMainFrame:true},'https://legacy-argument.example/',false,false);

    expect(onMainFrameStart).toHaveBeenCalledOnce();
    expect(onMainFrameStart).toHaveBeenCalledWith('https://main.example/');
  });
});
