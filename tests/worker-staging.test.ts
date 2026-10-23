import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Assignment } from '../server/contracts.js';
import { loadSelectedSkills, workerContextComposePrompt, workerContextPlanPrompt, workerExecutePrompt } from '../server/worker-staging.js';

const assignment:Assignment={outcome:'Implement the task',deliverable:'One feature',read_scope:['src/'],write_scope:['D:/work/src'],exclusions:['Unrelated work'],constraints:['Keep compatibility'],context_refs:['architecture decisions'],skill_refs:['testing'],acceptance:['The feature works'],verification:['Run a focused check'],ordinary_authority:['Choose local names'],escalation_conditions:['Public API changes'],receipt_requirements:['Return a receipt']};
let temporaryRoot='';
afterEach(async()=>{if(temporaryRoot)await rm(temporaryRoot,{recursive:true,force:true});temporaryRoot='';});

describe('staged worker context',()=>{
  it('withholds assignment details from both context stages and releases selected skills only with execution',()=>{
    const broad=workerContextPlanPrompt(assignment,'D:/work');
    expect(broad).toContain('BROAD SCOPE');expect(broad).toContain('Implement the task');
    expect(broad).not.toContain('acceptance');expect(broad).not.toContain('testing');expect(broad).not.toContain('write_scope');
    const context=workerContextComposePrompt({objective:assignment.outcome}, {status:'disabled',detail:'No project selected'});
    expect(context).not.toContain('assignment details');expect(context).not.toContain('testing');expect(context).toContain('disabled');
    const execute=workerExecutePrompt(assignment,'No project context available.','--- testing ---\nUse focused tests.');
    expect(execute).toContain(JSON.stringify(assignment,null,2));expect(execute).toContain('Use focused tests.');
  });

  it('loads exact named skill files from supported Codex roots and refuses path traversal or missing names',async()=>{
    temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-skills-'));
    const selected=path.join(temporaryRoot,'plugins','cache','test-plugin','1.0.0','skills','testing');
    await mkdir(selected,{recursive:true});await writeFile(path.join(selected,'SKILL.md'),'# Testing\nUse a focused check.');
    const content=await loadSelectedSkills(['testing'],temporaryRoot);
    expect(content).toContain('Use a focused check.');
    await expect(loadSelectedSkills(['../testing'],temporaryRoot)).rejects.toThrow('Invalid skill reference');
    await expect(loadSelectedSkills(['not-installed'],temporaryRoot)).rejects.toThrow('No execution turn was started');
    expect(await readFile(path.join(selected,'SKILL.md'),'utf8')).toContain('Use a focused check.');
  });
});
