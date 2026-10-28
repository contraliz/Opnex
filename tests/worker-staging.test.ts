import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workerOutcomeSchema, type Assignment } from '../server/contracts.js';
import { loadConfiguredSkill, loadSelectedSkills, parseWorkerStructuredOutput, searchConfiguredSkills, workerContextComposePrompt, workerContextPlanPrompt, workerExecutePrompt, workerOutcomeResponseFormatPrompt } from '../server/worker-staging.js';

const assignment:Assignment={outcome:'Implement the task',deliverable:'One feature',read_scope:['src/'],write_scope:['D:/work/src'],exclusions:['Unrelated work'],constraints:['Keep compatibility'],context_refs:['architecture decisions'],skill_refs:['testing'],acceptance:['The feature works'],verification:['Run a focused check'],ordinary_authority:['Choose local names'],escalation_conditions:['Public API changes'],receipt_requirements:['Return a receipt']};
let temporaryRoot='';
afterEach(async()=>{if(temporaryRoot)await rm(temporaryRoot,{recursive:true,force:true});temporaryRoot='';});

describe('staged worker context',()=>{
  it('withholds assignment details from both context stages and releases selected skills only with execution',()=>{
    const broad=workerContextPlanPrompt(assignment,'D:/work');
    expect(broad).toContain('BROAD SCOPE');expect(broad).toContain('Implement the task');
    expect(broad).toContain('Return only one valid JSON object');expect(broad).toContain('"type":"context_plan"');
    expect(broad).not.toContain('acceptance');expect(broad).not.toContain('testing');expect(broad).not.toContain('write_scope');
    const context=workerContextComposePrompt({objective:assignment.outcome}, {status:'disabled',detail:'No project selected'});
    expect(context).not.toContain('assignment details');expect(context).not.toContain('testing');expect(context).toContain('disabled');expect(context).toContain('"type":"context_ready"');
    const execute=workerExecutePrompt(assignment,'No project context available.','--- testing ---\nUse focused tests.');
    expect(execute).toContain(JSON.stringify(assignment,null,2));expect(execute).toContain('Use focused tests.');
  });

  it('parses a single JSON object and normalizes only a whole-message JSON fence',()=>{
    expect(parseWorkerStructuredOutput('{"type":"context_plan"}')).toEqual({type:'context_plan'});
    expect(parseWorkerStructuredOutput('```json\n{"type":"context_plan"}\n```')).toEqual({type:'context_plan'});
    expect(()=>parseWorkerStructuredOutput('Here is the result: {"type":"context_plan"}')).toThrow();
  });

  it('shows the complete validated receipt shape to recruited execution and integration models',()=>{
    const format=workerOutcomeResponseFormatPrompt();
    expect(format).toContain('Do not make acceptance an array.');
    expect(format).toContain('status (one of "complete", "incomplete", "blocked", "failed")');
    expect(format).toContain('verification (an array of objects with check');
    expect(format).toContain('earlier context retrieval does not count');
    expect(format).toContain('No AgentMem knowledge update was needed because ...');
    expect(format).toContain('No repository-index resync was needed because ...');
    expect(format).toContain('do not leave knowledge.updated empty');
    const example=format.match(/Example receipt for an AgentMem-enabled read-only task: (\{.*\})\. Replace the example evidence/s)?.[1];
    expect(example).toBeTruthy();
    expect(workerOutcomeSchema.parse(JSON.parse(example!))).toMatchObject({type:'receipt',receipt:{acceptance:{met:expect.any(Array),unmet:expect.any(Array)}}});
    const execute=workerExecutePrompt(assignment,'Context','');
    expect(execute).toContain(format);
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
  it('searches and explicitly resolves configured filesystem skills under namespaced stable references',async()=>{
    temporaryRoot=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-codex-skills-'));const selected=path.join(temporaryRoot,'skills','review-helper');await mkdir(selected,{recursive:true});await writeFile(path.join(selected,'SKILL.md'),'---\nname: Review helper\ndescription: Source review instructions\n---\nPreserve citations.');
    const found=await searchConfiguredSkills('source review',temporaryRoot);expect(found).toHaveLength(1);expect(found[0]).toMatchObject({id:expect.stringMatching(/^codex:review-helper:[a-f0-9]{12}$/),name:'Review helper',description:'Source review instructions'});const loaded=await loadConfiguredSkill(found[0].id,temporaryRoot);expect(loaded).toMatchObject({id:found[0].id,revision:found[0].revision,source:await realpath(path.join(selected,'SKILL.md')),instructions:'Preserve citations.'});await expect(loadConfiguredSkill('codex:review-helper:000000000000',temporaryRoot)).rejects.toThrow('unavailable or changed');
  });
});
