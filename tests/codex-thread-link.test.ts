import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require=createRequire(import.meta.url);const {codexThreadUrl,openCodexThread}=require('../desktop/codex-thread-link.cjs') as {codexThreadUrl:(threadId:string)=>string;openCodexThread:(threadId:string,openExternal:(url:string)=>Promise<void>)=>Promise<boolean>};

describe('Codex thread deep links',()=>{
  it('builds the exact Codex thread URI from a raw thread ID',()=>{
    const threadId='019c6e27-e55b-73d1-87d8-4e01f1f75043';
    expect(codexThreadUrl(threadId)).toBe(`codex://threads/${threadId}`);
  });

  it('opens only the URI constructed from the exact validated thread ID',async()=>{
    const openExternal=vi.fn(async()=>{});const threadId='019c6e27-e55b-73d1-87d8-4e01f1f75043';
    await expect(openCodexThread(threadId,openExternal)).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(`codex://threads/${threadId}`);
  });

  it.each(['','https://github.com/','codex://other/123','../123','id?next=https://example.com','id#fragment','with space','%2f'])('rejects non-ID input %j',threadId=>{
    expect(()=>codexThreadUrl(threadId)).toThrow();
  });

  it('never calls the external handler for rejected input',async()=>{
    const openExternal=vi.fn(async()=>{});
    await expect(openCodexThread('https://example.com',openExternal)).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
