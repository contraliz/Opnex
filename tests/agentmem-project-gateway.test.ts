import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';

const clients:Array<{client:Client;transport:StdioClientTransport}>=[];
afterEach(async()=>{
  for(const {client,transport} of clients.splice(0)){
    try{await client.close();}catch{}
    try{await transport.close();}catch{}
  }
});

describe('project AgentMem MCP gateway',()=>{
  it('returns a nonblocking status tool when the optional service never completes initialization',async()=>{
    const env={
      ...process.env,
      OPNEX_AGENTMEM_PROJECT_ID:'alpha-kb',
      OPNEX_AGENTMEM_PROJECT_ROOT:process.cwd(),
      OPNEX_AGENTMEM_REPOSITORY_ID:'',
      OPNEX_AGENTMEM_COMMAND:process.execPath,
      OPNEX_AGENTMEM_ARGS:JSON.stringify(['-e','setInterval(()=>{},1000)']),
      OPNEX_AGENTMEM_CONFIG_ENV:'{}',
      OPNEX_AGENTMEM_ACCESS:'read-write',
    };
    const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','server/agentmem-mcp-gateway.ts'],env,stderr:'ignore'});
    const client=new Client({name:'opnex-agentmem-gateway-test',version:'1.0.0'});
    clients.push({client,transport});
    await client.connect(transport);
    const started=performance.now();
    const response=await client.listTools();
    expect(performance.now()-started).toBeLessThan(1000);
    expect(response.tools).toMatchObject([{name:'agentmem_status'}]);
  },10000);
});
