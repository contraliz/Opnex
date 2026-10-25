import { describe, expect, it } from 'vitest';
import { AGENTMEM_MODEL_READ_TOOLS, AGENTMEM_MODEL_TOOLS, AGENTMEM_MODEL_WRITE_TOOLS, scopeAgentMemToolArgs, scopeAgentMemToolSchema } from '../server/agentmem-mcp-scope.js';

describe('project-scoped AgentMem model MCP boundary',()=>{
  it('exposes scoped knowledge writes and makes registration available only during setup',()=>{
    expect(AGENTMEM_MODEL_READ_TOOLS.has('decisions')).toBe(true);
    for(const name of ['repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary'])expect(AGENTMEM_MODEL_READ_TOOLS.has(name)).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('knowledge')).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('repository_resync')).toBe(true);
    expect(AGENTMEM_MODEL_TOOLS.has('projects')).toBe(true);
    expect(AGENTMEM_MODEL_TOOLS.has('repository_register')).toBe(true);
    expect(AGENTMEM_MODEL_WRITE_TOOLS.has('index_project')).toBe(true);
    expect(scopeAgentMemToolSchema({type:'object',properties:{action:{type:'string'},project_id:{type:'string'},root:{type:'string'},description:{type:'string'}},required:['action','project_id','root']},'projects','register')).toMatchObject({properties:{action:{enum:['register']},description:{type:'string'}},required:['action']});
    expect(scopeAgentMemToolSchema({type:'object',properties:{project_id:{type:'string'},repository_id:{type:'string'},query:{type:'string'}},required:['project_id','repository_id','query']})).toEqual({type:'object',properties:{query:{type:'string'}},required:['query']});
  });

  it('pins KB and repository-index calls to the verified project/repository identity',()=>{
    expect(scopeAgentMemToolArgs('retrieve_evidence',{query:'DEC001',limit:5},'hackshsid','repo-1')).toEqual({query:'DEC001',limit:5,project_id:'hackshsid'});
    expect(scopeAgentMemToolArgs('repository_search',{query:'DEC001'},'hackshsid','repo-1')).toEqual({query:'DEC001',project_id:'hackshsid',repository_id:'repo-1'});
    expect(scopeAgentMemToolArgs('repository_graph_query',{query:'captureTurnSourceFingerprint'},'hackshsid','repo-1')).toEqual({query:'captureTurnSourceFingerprint',project_id:'hackshsid',repository_id:'repo-1'});
    expect(scopeAgentMemToolArgs('repository_resync',{max_files:40},'hackshsid','repo-1')).toEqual({max_files:40,project_id:'hackshsid',repository_id:'repo-1'});
  });

  it('allows supported KB writes while rejecting project/repository redirects and bypasses',()=>{
    expect(scopeAgentMemToolArgs('decisions',{action:'create',title:'x'},'hackshsid','repo-1')).toMatchObject({action:'create',project_id:'hackshsid'});
    expect(scopeAgentMemToolArgs('knowledge',{action:'update',page_id:'architecture',content:'updated'},'hackshsid','repo-1')).toMatchObject({action:'update',project_id:'hackshsid'});
    expect(()=>scopeAgentMemToolArgs('decisions',{action:'list',project_id:'other'},'hackshsid','repo-1')).toThrow(/selected project/i);
    expect(()=>scopeAgentMemToolArgs('repository_search',{query:'x',scope:{root:'D:/other'}},'hackshsid','repo-1')).toThrow(/alternate roots/i);
    expect(()=>scopeAgentMemToolArgs('repository_resync',{repository_id:'repo-other'},'hackshsid','repo-1')).toThrow(/alternate roots/i);
    expect(()=>scopeAgentMemToolArgs('requirements',{action:'fulfill',force:true},'hackshsid','repo-1')).toThrow(/bypass revision/i);
    expect(()=>scopeAgentMemToolArgs('decisions',{action:'delete'},'hackshsid','repo-1')).toThrow(/action must be one of/i);
    expect(scopeAgentMemToolArgs('projects',{action:'register'},'new-project','','D:/workspace/new','register')).toEqual({action:'register',project_id:'new-project',root:'D:/workspace/new',description:''});
    expect(scopeAgentMemToolArgs('repository_register',{},'new-project','','D:/workspace/new','repository')).toEqual({project_id:'new-project',repository_root:'D:/workspace/new'});
    expect(()=>scopeAgentMemToolArgs('projects',{action:'list'},'new-project','','D:/workspace/new','register')).toThrow(/action must be one of/i);
    expect(()=>scopeAgentMemToolArgs('projects',{action:'register'},'new-project','','D:/workspace/new','ready')).toThrow(/only available/i);
    expect(()=>scopeAgentMemToolArgs('repository_register',{repository_root:'D:/other'},'new-project','','D:/workspace/new','repository')).toThrow(/alternate roots/i);
    expect(()=>scopeAgentMemToolArgs('repository_register',{},'new-project','','D:/workspace/new','ready')).toThrow(/only available/i);
  });
});
