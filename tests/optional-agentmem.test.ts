import { describe, expect, it, vi } from 'vitest';
import { isAgentMemEnabled, scopedAgentMemContext } from '../server/optional-agentmem.js';

describe('intentionally disabled AgentMem scope',()=>{
  it('skips the connector entirely for empty or whitespace project IDs',async()=>{
    const load=vi.fn(async()=>({secret:'scoped context'}));
    expect(isAgentMemEnabled('')).toBe(false);
    expect(isAgentMemEnabled('  ')).toBe(false);
    expect(await scopedAgentMemContext('',load)).toEqual({disabled:true});
    expect(await scopedAgentMemContext('   ',load)).toEqual({disabled:true});
    expect(load).not.toHaveBeenCalled();
  });
  it('loads context only for the explicitly selected project identity',async()=>{
    const load=vi.fn(async(id:string)=>({project:id}));
    expect(await scopedAgentMemContext(' demo-project ',load)).toEqual({project:'demo-project'});
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith('demo-project');
  });
});
