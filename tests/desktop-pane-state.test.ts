import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);const {assignTabToPane,removeTabFromPanes}=require('../desktop/pane-state.cjs') as {assignTabToPane:(state:Record<string,string|null>,id:string,pane:string)=>Record<string,string|null>;removeTabFromPanes:(state:Record<string,string|null>,id:string)=>Record<string,string|null>};

describe('native browser pane assignments',()=>{
  it('moves a tab between full workspace and chat side pane without changing its native tab identity',()=>{
    const nativeWebContentsId='webcontents-44';const full={main:nativeWebContentsId,side:null,chat:null};
    const besideChat=assignTabToPane(full,nativeWebContentsId,'chat');expect(besideChat).toEqual({main:null,side:null,chat:nativeWebContentsId});
    const restored=assignTabToPane(besideChat,nativeWebContentsId,'main');expect(restored).toEqual({main:nativeWebContentsId,side:null,chat:null});
    expect(Object.values(restored).filter(value=>value===nativeWebContentsId)).toHaveLength(1);
  });
  it('rejects unknown panes and removes closed tabs from every assignment',()=>{
    expect(()=>assignTabToPane({main:null,side:null,chat:null},'tab','remote')).toThrow('Unknown browser pane');
    expect(removeTabFromPanes({main:'tab',side:null,chat:null},'tab')).toEqual({main:null,side:null,chat:null});
  });
});
