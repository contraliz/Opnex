import { describe, expect, it } from 'vitest';
import { withAgentMemTimeout } from '../server/agentmem-adapter-timeout.js';

describe('optional AgentMem adapter timeouts',()=>{
  it('returns the service result before its deadline',async()=>{
    await expect(withAgentMemTimeout(Promise.resolve('available'),50,'AgentMem request')).resolves.toBe('available');
  });

  it('bounds a request that never settles so the caller can continue without AgentMem',async()=>{
    const stalled=new Promise<never>(()=>{});
    await expect(withAgentMemTimeout(stalled,5,'AgentMem tool catalog')).rejects.toThrow('AgentMem tool catalog timed out.');
  });

  it('rejects invalid timeout budgets',async()=>{
    await expect(withAgentMemTimeout(Promise.resolve('unused'),0,'AgentMem request')).rejects.toThrow('timeout must be a positive finite number');
  });
});
