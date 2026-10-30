import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fake=vi.hoisted(()=>({projects:[] as any[],calls:[] as any[],registerFailureAfterCommit:false}));
vi.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:class FakeClient{
  async connect(){}
  async close(){}
  async callTool({name,arguments:args}:any){
    fake.calls.push({name,args});
    if(name==='projects'&&args.action==='list')return {isError:false,structuredContent:{projects:structuredClone(fake.projects)}};
    if(name==='projects'&&args.action==='register'){
      fake.projects.push({id:args.project_id,name:args.project_id,source_root:args.root,memory_root:`D:/projects/${args.project_id}`});
      if(fake.registerFailureAfterCommit)throw new Error('Fixture transport closed after registration.');
      return {isError:false,structuredContent:{ok:true}};
    }
    return {isError:true,content:[{type:'text',text:'Unexpected fixture tool.'}]};
  }
}}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js',()=>({StdioClientTransport:class FakeTransport{async close(){}}}));

import { AgentMem } from '../server/agentmem.js';
import { discoverProjectBinding, proposedAgentMemProjectId, verifyProjectBinding } from '../server/agentmem-project-settings.js';

const priorCodexHome=process.env.CODEX_HOME;
let codexHome='';

beforeEach(async()=>{
  fake.projects=[];fake.calls=[];fake.registerFailureAfterCommit=false;
  codexHome=await mkdtemp(path.join(os.tmpdir(),'opnex-agentmem-test-'));
  await writeFile(path.join(codexHome,'config.toml'),'[mcp_servers.agentmem]\ncommand="fixture-agentmem"\nargs=["--stdio"]\n[mcp_servers.agentmem.env]\nAGENTMEM_MEMORY_ROOT="D:/projects"\n');
  process.env.CODEX_HOME=codexHome;
});

afterEach(async()=>{
  if(priorCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=priorCodexHome;
  if(codexHome)await rm(codexHome,{recursive:true,force:true});
});

describe('optional project AgentMem adapter',()=>{
  it('builds a model MCP configuration pinned to one project without writing Codex configuration',async()=>{
    const adapter=new AgentMem();await adapter.configure();
    const config=await adapter.modelMcpServerConfig('alpha-kb','D:/work/alpha');
    expect(config).toMatchObject({enabled:true,env:{OPNEX_AGENTMEM_PROJECT_ID:'alpha-kb',OPNEX_AGENTMEM_PROJECT_ROOT:path.resolve('D:/work/alpha'),OPNEX_AGENTMEM_COMMAND:'fixture-agentmem'}});
    expect(config.enabled_tools).toContain('retrieve_evidence');
    expect(config.enabled_tools).not.toContain('projects');
    expect(config.env.OPNEX_AGENTMEM_ACCESS).toBe('read-write');
    const direct=await adapter.modelMcpServerConfig('alpha-kb','D:/work/alpha',true);
    expect(direct.env.OPNEX_AGENTMEM_ACCESS).toBe('read-only');
    expect(direct.enabled_tools).toContain('knowledge');
    expect(direct.enabled_tools).not.toContain('repository_resync');
    expect(direct.enabled_tools).not.toContain('index_project');
    expect(fake.calls).toHaveLength(0);
    expect(fake.projects).toEqual([]);
  });

  it('discovers only an exact canonical source-root match',async()=>{
    fake.projects=[
      {id:'alpha-kb',name:'Alpha',source_root:'D:/work/alpha/',memory_root:'D:/projects/alpha-kb'},
      {id:'alpha-copy-kb',name:'Alpha copy',source_root:'D:/work/alpha-copy',memory_root:'D:/projects/alpha-copy-kb'},
    ];
    const adapter=new AgentMem();await adapter.configure();
    const result=await discoverProjectBinding(adapter,'d:\\work\\alpha');
    expect(result).toMatchObject({project:{id:'alpha-kb',sourceRoot:'D:/work/alpha/'},conflict:false});
    expect(result.proposedId).toBe(proposedAgentMemProjectId('D:/work/alpha'));
    expect(fake.calls.filter(row=>row.name==='projects').map(row=>row.args.action)).toEqual(['list']);
  });

  it('requires one exact identity before connecting and never rebinds a registered project',async()=>{
    fake.projects=[{id:'alpha-kb',source_root:'D:/work/alpha',memory_root:'D:/projects/alpha-kb'}];
    const adapter=new AgentMem();await adapter.configure();
    await expect(verifyProjectBinding(adapter,'alpha-kb','d:/WORK/ALPHA/')).resolves.toMatchObject({id:'alpha-kb'});
    await expect(verifyProjectBinding(adapter,'alpha-kb','D:/work/other')).rejects.toThrow(/root does not match/i);
    await expect(verifyProjectBinding(adapter,'missing-kb','D:/work/alpha')).rejects.toThrow(/not registered/i);
    expect(fake.calls.some(row=>row.args.action==='register')).toBe(false);
  });

  it('creates a knowledge base only through an explicit setup action and saves the returned identity',async()=>{
    const adapter=new AgentMem();await adapter.configure();
    const id=proposedAgentMemProjectId('D:/work/new');
    await expect(adapter.createProjectBinding(id,'D:/work/new','Knowledge base for New')).resolves.toMatchObject({id,sourceRoot:path.resolve('D:/work/new')});
    expect(fake.calls.filter(row=>row.name==='projects').map(row=>row.args.action)).toEqual(['list','register','list']);
    expect(fake.calls.find(row=>row.args.action==='register')?.args).toMatchObject({project_id:id,root:'D:\\work\\new'});
  });

  it('reports duplicate root registrations instead of guessing which ID to use',async()=>{
    fake.projects=[
      {id:'first',source_root:'D:/work/alpha',memory_root:'D:/projects/first'},
      {id:'second',source_root:'d:\\work\\alpha',memory_root:'D:/projects/second'},
    ];
    const adapter=new AgentMem();await adapter.configure();
    const result=await discoverProjectBinding(adapter,'D:/work/alpha');
    expect(result).toMatchObject({project:undefined,conflict:true});
    await expect(verifyProjectBinding(adapter,'first','D:/work/alpha')).rejects.toThrow(/more than one/i);
  });

  it('leaves an ambiguous registration visible for retry if the service replies after creating it',async()=>{
    fake.registerFailureAfterCommit=true;
    const adapter=new AgentMem();await adapter.configure();
    const id=proposedAgentMemProjectId('D:/work/retry');
    await expect(adapter.createProjectBinding(id,'D:/work/retry')).rejects.toThrow(/transport closed/i);
    expect(await adapter.listProjects()).toMatchObject([{id,sourceRoot:path.resolve('D:/work/retry')}]);
    expect(fake.calls.filter(row=>row.args.action==='register')).toHaveLength(1);
  });
});
