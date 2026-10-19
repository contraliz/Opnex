import { afterEach, describe, expect, it, vi } from 'vitest';

describe('browser API session recovery',()=>{
  afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
  it('refreshes a process-local CSRF token once after backend restart',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({csrf:'old',state:{},runtime:{}}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({error:'Local request origin or session token rejected.'}),{status:403}))
      .mockResolvedValueOnce(new Response(JSON.stringify({csrf:'new',state:{},runtime:{}}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ok:true}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);const api=await import('../src/ui/api.js');await api.bootstrap();
    await expect(api.api('/api/tasks/new',{})).resolves.toEqual({ok:true});
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers['x-pseudoharness-token']).toBe('new');
  });
  it('reports an invalid response without leaking raw server content',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<internal detail>',{status:502})));
    vi.resetModules();const api=await import('../src/ui/api.js');
    await expect(api.bootstrap()).rejects.toThrow('invalid response (502)');
  });
});
