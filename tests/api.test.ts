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
  it('sends skill edits as authenticated PUT requests',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({csrf:'skill-token',state:{},runtime:{}}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({skill:{id:'skill-1'}}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);const api=await import('../src/ui/api.js');await api.bootstrap();
    await expect(api.apiPut('/api/skills/skill-1',{name:'Updated'})).resolves.toEqual({skill:{id:'skill-1'}});
    expect(fetchMock.mock.calls[1][0]).toBe('/api/skills/skill-1');expect(fetchMock.mock.calls[1][1]).toMatchObject({method:'PUT',headers:{'content-type':'application/json','x-pseudoharness-token':'skill-token'},body:'{"name":"Updated"}'});
  });
  it('reports malformed responses without leaking raw server content',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<internal detail>',{status:502})));
    vi.resetModules();const api=await import('../src/ui/api.js');
    await expect(api.bootstrap()).rejects.toThrow('local service could not complete the request');
  });
  it('turns structured validation errors into a readable message and preserves status metadata',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:JSON.stringify([{path:['projectRoot'],message:'Folder does not exist.'}] )}),{status:400,headers:{'content-type':'application/json'}})));
    vi.resetModules();const api=await import('../src/ui/api.js');
    let caught:unknown;try{await api.api('/api/settings',{});}catch(error){caught=error;}
    expect(caught).toBeInstanceOf(api.ApiError);
    expect(caught).toMatchObject({status:400,code:'HTTP_ERROR'});
    expect(String(caught)).toContain('project root: Folder does not exist.');
    expect(String(caught)).not.toContain('{');
  });
  it('gives a useful offline message when the local service cannot be reached',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    vi.resetModules();const api=await import('../src/ui/api.js');
    await expect(api.api('/api/directories')).rejects.toThrow('Check that it is running, then retry.');
  });
  it('explains plain text server errors without displaying object serialization',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('Folder access was denied.',{status:403})));
    vi.resetModules();const api=await import('../src/ui/api.js');
    await expect(api.api('/api/directories')).rejects.toThrow('Folder access was denied.');
  });
  it('explains when a stale server serves the app page for an unavailable API route',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('<!doctype html><html></html>',{status:200,headers:{'content-type':'text/html; charset=utf-8'}})));
    vi.resetModules();const api=await import('../src/ui/api.js');
    await expect(api.api('/api/directories?path=D%3A%5Cworkspace')).rejects.toThrow('Restart Pseudoharness and reload so its UI and backend versions match.');
  });
});
