import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertProjectIdentityChangeAllowed, assertTaskCanResumeInProject, sameProjectRoot } from '../server/project-identity.js';
import { saveProjectInState, upgradeStoredState, type Project, type State, type Task } from '../server/state.js';

const stamp='2026-10-29T00:00:00.000Z';
const project=(patch:Partial<Project>={}):Project=>({id:'11111111-1111-4111-8111-111111111111',name:'Alpha',projectRoot:'D:/work/alpha',agentmemProjectId:'',agentmemEnabled:false,needsLocation:false,pinned:false,createdAt:stamp,updatedAt:stamp,...patch});
const task=(patch:Partial<Task>={}):Task=>({id:'session-alpha',title:'Keep its history',phase:'accepted',createdAt:stamp,updatedAt:stamp,userRoot:'D:/work/alpha',agentmemProjectId:'',userMessages:['hello'],messages:[{id:'message-1',role:'user',text:'hello',createdAt:stamp}],correctionCount:0,processedTurns:[],...patch});
const state=(projects:Project[]=[],tasks:Task[]=[]):State=>({version:4,revision:0,settings:{orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'},tasks,activeTaskId:null,projects,selectedProjectId:null,expandedProjectIds:projects.map(row=>row.id)});

describe('project-owned workspaces',()=>{
  it('compares full canonical paths with Windows case and separator rules',()=>{
    expect(sameProjectRoot('D:/Work/Alpha/','d:\\work\\alpha')).toBe(true);
    expect(sameProjectRoot('D:/work/alpha','D:/work/alpha-copy')).toBe(false);
  });

  it('migrates multiple sessions by exact directory and binding while preserving unassigned and missing history',()=>{
    const temp=mkdtempSync(path.join(os.tmpdir(),'opnex-project-migration-'));
    const alphaRoot=path.join(temp,'alpha'),betaRoot=path.join(temp,'beta');mkdirSync(alphaRoot);mkdirSync(betaRoot);
    try{
      const alpha=project({projectRoot:alphaRoot,agentmemProjectId:'alpha-kb',agentmemEnabled:true});
      const assignment={outcome:'Keep the existing session history.',deliverable:'A migrated project with its session history.',read_scope:[],write_scope:[],exclusions:[],constraints:[],context_refs:[],acceptance:['Session history remains intact.'],verification:['Compare the migrated history with the saved session.'],ordinary_authority:['Implement the approved state migration.'],escalation_conditions:['Escalate ambiguous project identity.'],receipt_requirements:['Return a concise migration receipt.']};
      const preservedPass={id:'pass-alpha-1',index:1,createdAt:stamp,userInput:'hello',userInputs:['hello'],userMessageIds:['message-1'],phase:'accepted' as const,assignment,receipt:{status:'complete' as const,result:'Done',changes:['src/a.ts'],acceptance:{met:['Done'],unmet:[]},verification:[],risks:[],knowledge:{consulted:[],updated:[]},decision_required:null},correctionCount:0,processedTurns:['turn-worker'],workerThreadId:'worker-alpha',agentmemAudit:{recorded:true,selectedProjectId:'alpha-kb',workspaceRoot:alphaRoot,identityStatus:'verified' as const,modelMcpStatus:'observed' as const,contexts:[],calls:[]}};
      const original={version:3,revision:7,settings:{projectRoot:alphaRoot,agentmemProjectId:'alpha-kb',agentmemAutoSetup:false,orchestratorModel:'gpt-6-sol',orchestratorEffort:'high',approvalPolicy:'on-request'},activeTaskId:'alpha-one',projects:[{...alpha,agentmemAutoSetup:false}],selectedProjectId:alpha.id,expandedProjectIds:[alpha.id,'unclassified'],tasks:[
        task({id:'alpha-one',projectId:alpha.id,userRoot:alphaRoot,agentmemProjectId:'alpha-kb',passes:[preservedPass],currentPassId:'pass-alpha-1',workerThreadId:'worker-alpha',processedTurns:['turn-worker'],assignment,receipt:preservedPass.receipt}),
        task({id:'alpha-two',userRoot:alphaRoot,agentmemProjectId:'alpha-kb'}),
        task({id:'beta-one',userRoot:betaRoot,agentmemProjectId:'beta-kb'}),
        task({id:'beta-two',userRoot:betaRoot,agentmemProjectId:'beta-kb'}),
        task({id:'conflict-one',userRoot:'D:/legacy/conflict',agentmemProjectId:'alpha-kb'}),
        task({id:'conflict-two',userRoot:'D:/legacy/conflict',agentmemProjectId:'beta-kb'}),
        task({id:'missing-root',userRoot:'D:/legacy/missing',agentmemProjectId:'missing-kb'}),
      ]};
      const expected=structuredClone(original);
      const migrated=upgradeStoredState(structuredClone(original));
      const byId=new Map(migrated.projects.map(row=>[row.id,row]));
      const alphaProject=migrated.projects.find(row=>sameProjectRoot(row.projectRoot,alphaRoot))!;
      const betaProject=migrated.projects.find(row=>sameProjectRoot(row.projectRoot,betaRoot))!;
      const missingProject=migrated.projects.find(row=>sameProjectRoot(row.projectRoot,'D:/legacy/missing'))!;
      expect(migrated.version).toBe(4);
      expect(migrated.settings).not.toHaveProperty('projectRoot');
      expect(migrated.settings).not.toHaveProperty('agentmemProjectId');
      expect(migrated.tasks.map(row=>row.id)).toEqual(expected.tasks.map((row:any)=>row.id));
      expect(migrated.tasks.map(row=>row.projectId)).toEqual([alpha.id,alpha.id,betaProject.id,betaProject.id,undefined,undefined,missingProject.id]);
      expect(alphaProject.id).toBe(alpha.id);
      expect(byId.has(betaProject.id)).toBe(true);
      expect(missingProject.needsLocation).toBe(true);
      expect(migrated.tasks[0]).toMatchObject({id:'alpha-one',messages:expected.tasks[0]?.messages,passes:[expected.tasks[0]?.passes?.[0]],agentmemProjectId:'alpha-kb',workerThreadId:'worker-alpha'});
      expect(migrated.tasks[0].passes?.[0]).toMatchObject({id:'pass-alpha-1',workerThreadId:'worker-alpha',processedTurns:['turn-worker'],receipt:preservedPass.receipt,agentmemAudit:preservedPass.agentmemAudit});
    }finally{rmSync(temp,{recursive:true,force:true});}
  });

  it('keeps a version 4 unclassified session unassigned after a restart',()=>{
    const alpha=project();
    const unclassified=task({id:'unclassified-history',projectId:undefined,userRoot:alpha.projectRoot});
    const upgraded=upgradeStoredState(state([alpha],[unclassified]));
    expect(upgraded.projects.map(row=>row.id)).toEqual([alpha.id]);
    expect(upgraded.tasks[0]).not.toHaveProperty('projectId');
    expect(upgraded.tasks[0]).toMatchObject({userRoot:alpha.projectRoot,messages:unclassified.messages});
  });

  it('blocks project directory or integration changes while a session is active or resumable',()=>{
    const current=project();const changed={...current,projectRoot:'D:/work/other'};
    expect(()=>assertProjectIdentityChangeAllowed(current,changed,[task({projectId:current.id,phase:'paused_after_restart'})])).toThrow(/Finish or stop/);
    expect(()=>assertProjectIdentityChangeAllowed(current,changed,[task({phase:'accepted'})])).not.toThrow();
  });

  it('keeps a session bound to its recorded root and KB after it is moved in the project list',()=>{
    const target=project({projectRoot:'D:/work/other',agentmemEnabled:true,agentmemProjectId:'other-kb'});
    expect(()=>assertTaskCanResumeInProject(task(),target)).toThrow(/Start a new session/);
    expect(()=>assertTaskCanResumeInProject(task(),project())).not.toThrow();
  });

  it('deduplicates projects by directory rather than display name',()=>{
    const first=project();const s=state([first]);
    expect(()=>saveProjectInState(s,{...project({id:'22222222-2222-4222-8222-222222222222',name:'Same directory, other name'}),projectRoot:'d:\\work\\alpha'})).toThrow(/already belongs/);
  });
});
