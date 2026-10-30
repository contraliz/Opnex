import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { upgradeStoredState } from '../server/state.js';
import { loadConfiguredSkill, searchConfiguredSkills } from '../server/worker-staging.js';

const stamp='2026-10-30T00:00:00.000Z';

describe('optional external project knowledge skills',()=>{
  it('retires active AgentMem bindings while preserving session and audit history and requiring a fresh thread',()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'opnex-project-history-'));
    try{
      const project={id:'11111111-1111-4111-8111-111111111111',name:'Alpha',projectRoot:root,agentmemProjectId:'alpha-kb',agentmemEnabled:true,needsLocation:false,pinned:false,createdAt:stamp,updatedAt:stamp};
      const audit={recorded:true,coverage:'full_pass',selectedProjectId:'alpha-kb',workspaceRoot:root,identityStatus:'verified',verifiedProjectId:'alpha-kb',verifiedRoot:root,modelMcpStatus:'observed',contexts:[],calls:[{id:'call-1',source:'model',role:'simple',method:'retrieve_evidence',status:'completed',startedAt:stamp,updatedAt:stamp,projectId:'alpha-kb'}]};
      const task={id:'task-1',projectId:project.id,title:'Historical session',phase:'accepted',createdAt:stamp,updatedAt:stamp,userRoot:root,agentmemProjectId:'alpha-kb',userMessages:['Preserve this'],messages:[{id:'message-1',role:'user',text:'Preserve this',createdAt:stamp}],passes:[{id:'pass-1',index:1,createdAt:stamp,userInput:'Preserve this',userInputs:['Preserve this'],userMessageIds:['message-1'],phase:'accepted',correctionCount:0,processedTurns:[],simpleThreadId:'old-thread',agentmemAudit:audit,agentmemTaskId:'agent-task-1',agentmemLease:'lease-1',agentmemRecordStatus:'recorded',agentmemReceiptId:'receipt-1'}],currentPassId:'pass-1',simpleThreadId:'old-thread',agentmemTaskId:'agent-task-1',agentmemLease:'lease-1',agentmemRecordStatus:'recorded',agentmemReceiptId:'receipt-1',correctionCount:0,processedTurns:[]};
      const input={version:4,revision:19,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request',projectRoot:root,agentmemProjectId:'alpha-kb',agentmemAutoSetup:true},tasks:[task],projects:[project],activeTaskId:task.id,selectedProjectId:project.id,expandedProjectIds:[project.id,'unclassified']};

      const migrated=upgradeStoredState(structuredClone(input));
      expect(migrated.version).toBe(5);
      expect(migrated.settings).not.toHaveProperty('projectRoot');
      expect(migrated.settings).not.toHaveProperty('agentmemProjectId');
      expect(migrated.settings).not.toHaveProperty('agentmemAutoSetup');
      expect(migrated.projects[0]).not.toHaveProperty('agentmemProjectId');
      expect(migrated.projects[0]).not.toHaveProperty('agentmemEnabled');
      expect(migrated.tasks[0]).toMatchObject({projectId:project.id,userRoot:root,requiresFreshSession:true,messages:task.messages,simpleThreadId:'old-thread'});
      expect(migrated.tasks[0]).not.toHaveProperty('agentmemProjectId');
      expect(migrated.tasks[0]).not.toHaveProperty('agentmemTaskId');
      expect(migrated.tasks[0].passes?.[0]).toMatchObject({simpleThreadId:'old-thread',agentmemAudit:audit});
      expect(migrated.tasks[0].passes?.[0]).not.toHaveProperty('agentmemTaskId');
      expect(migrated.tasks[0].passes?.[0].legacyAgentMem).toMatchObject({taskId:'agent-task-1',lease:'lease-1',recordStatus:'recorded',receiptId:'receipt-1'});
      expect(upgradeStoredState(structuredClone(migrated))).toEqual(migrated);
    }finally{rmSync(root,{recursive:true,force:true});}
  });

  it('discovers and loads a project skill through the generic configured-skill API without special AgentMem injection',async()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'opnex-project-skill-'));
    try{
      const codexHome=path.join(root,'.codex');mkdirSync(codexHome);
      const skillDir=path.join(root,'.agents','skills','agentmem-project');mkdirSync(skillDir,{recursive:true});
      writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: agentmem-project\ndescription: Optional external project knowledge workflow.\n---\nUse the configured external service only when available.\n');
      const found=await searchConfiguredSkills('agentmem-project',codexHome,root);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({name:'agentmem-project',source:'Project skill'});
      const loaded=await loadConfiguredSkill(found[0].id,codexHome,root);
      expect(loaded.instructions).toContain('Use the configured external service only when available.');
      expect(loaded.source).toContain(path.join('.agents','skills','agentmem-project','SKILL.md'));
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
