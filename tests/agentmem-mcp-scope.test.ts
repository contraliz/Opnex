import { describe, expect, it } from 'vitest';
import { AGENTMEM_MODEL_READ_TOOLS, AGENTMEM_MODEL_TOOLS, AGENTMEM_MODEL_WRITE_TOOLS, scopeAgentMemToolArgs, scopeAgentMemToolSchema } from '../server/agentmem-mcp-scope.js';

describe('project-scoped AgentMem model MCP boundary',()=>{
  it('exposes scoped knowledge tools without exposing project or repository registration',()=>{
    expect(AGENTMEM_MODEL_READ_TOOLS.has('decisions')).toBe(true);
    for(const name of ['repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary'])expect(AGENTMEM_MODEL_READ_TOOLS.has(name)).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('knowledge')).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('repository_resync')).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('index_project')).toBe(true);
    expect(AGENTMEM_MODEL_TOOLS.has('projects')).toBe(false);
    expect(AGENTMEM_MODEL_TOOLS.has('repository_register')).toBe(false);
    expect(scopeAgentMemToolSchema({type:'object',properties:{project_id:{type:'string'},repository_id:{type:'string'},query:{type:'string'}},required:['project_id','repository_id','query']})).toEqual({type:'object',properties:{query:{type:'string'}},required:['query']});
  });

  it('pins knowledge and repository-index calls to the verified project identity',()=>{
    expect(scopeAgentMemToolArgs('retrieve_evidence',{query:'DEC001',limit:5},'hackshsid','repo-1')).toEqual({query:'DEC001',limit:5,project_id:'hackshsid'});
    expect(scopeAgentMemToolArgs('repository_search',{query:'DEC001'},'hackshsid','repo-1')).toEqual({query:'DEC001',project_id:'hackshsid',repository_id:'repo-1'});
    expect(scopeAgentMemToolArgs('repository_graph_query',{query:'captureTurnSourceFingerprint'},'hackshsid','repo-1')).toEqual({query:'captureTurnSourceFingerprint',project_id:'hackshsid',repository_id:'repo-1'});
    expect(scopeAgentMemToolArgs('repository_resync',{max_files:40},'hackshsid','repo-1')).toEqual({max_files:40,project_id:'hackshsid',repository_id:'repo-1'});
  });

  it('allows project knowledge writes while rejecting identity redirects and setup actions',()=>{
    expect(scopeAgentMemToolArgs('decisions',{action:'create',title:'x'},'hackshsid','repo-1')).toMatchObject({action:'create',project_id:'hackshsid'});
    expect(scopeAgentMemToolArgs('knowledge',{action:'update',page_id:'architecture',content:'updated'},'hackshsid','repo-1')).toMatchObject({action:'update',project_id:'hackshsid'});
    expect(()=>scopeAgentMemToolArgs('decisions',{action:'list',project_id:'other'},'hackshsid','repo-1')).toThrow(/selected project/i);
    expect(()=>scopeAgentMemToolArgs('repository_search',{query:'x',scope:{root:'D:/other'}},'hackshsid','repo-1')).toThrow(/alternate roots/i);
    expect(()=>scopeAgentMemToolArgs('repository_resync',{repository_id:'repo-other'},'hackshsid','repo-1')).toThrow(/alternate roots/i);
    expect(()=>scopeAgentMemToolArgs('requirements',{action:'fulfill',force:true},'hackshsid','repo-1')).toThrow(/bypass revision/i);
    expect(()=>scopeAgentMemToolArgs('decisions',{action:'delete'},'hackshsid','repo-1')).toThrow(/action must be one of/i);
    expect(()=>scopeAgentMemToolArgs('projects',{action:'register'},'new-project','','D:/workspace/new')).toThrow(/unavailable/i);
    expect(()=>scopeAgentMemToolArgs('repository_register',{},'new-project','','D:/workspace/new')).toThrow(/unavailable/i);
  });

  it('gives read-only roles read actions and rejects writes to shared read/write tools',()=>{
    const schema=scopeAgentMemToolSchema({type:'object',properties:{action:{type:'string'}},required:['action']},'knowledge',true);
    expect(schema.properties.action.enum).toEqual(['list','read','history']);
    expect(scopeAgentMemToolArgs('knowledge',{action:'read',page_id:'architecture'},'project','', 'D:/work',true)).toMatchObject({action:'read',project_id:'project'});
    expect(()=>scopeAgentMemToolArgs('knowledge',{action:'update',page_id:'architecture'},'project','','D:/work',true)).toThrow(/action must be one of/i);
    expect(()=>scopeAgentMemToolArgs('repository_resync',{max_files:10},'project','repo','D:/work',true)).toThrow(/read-only/i);
  });
});
