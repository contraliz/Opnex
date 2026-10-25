import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let temp='';let previous:string|undefined;
async function setup(){previous=process.env.PSEUDOHARNESS_DATA_DIR;temp=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-skills-test-'));process.env.PSEUDOHARNESS_DATA_DIR=temp;return await import('../server/skill-library.js');}
afterEach(async()=>{const {closeSkillLibrary}=await import('../server/skill-library.js');closeSkillLibrary();if(previous===undefined)delete process.env.PSEUDOHARNESS_DATA_DIR;else process.env.PSEUDOHARNESS_DATA_DIR=previous;if(temp)await rm(temp,{recursive:true,force:true});temp='';});

describe('application saved skills',()=>{
  it('keeps different local profile data directories completely separate',async()=>{
    const library=await setup();const profileA=path.join(temp,'profile-a');const profileB=path.join(temp,'profile-b');process.env.PSEUDOHARNESS_DATA_DIR=profileA;
    const privateSkill=await library.createSkill({name:'Profile A only',description:'Local profile check',instructions:'Keep this in its owner profile.'});library.closeSkillLibrary();
    process.env.PSEUDOHARNESS_DATA_DIR=profileB;expect(await library.listSkills()).toEqual([]);await library.createSkill({name:'Profile B only',description:'Local profile check',instructions:'This profile has its own library.'});library.closeSkillLibrary();
    process.env.PSEUDOHARNESS_DATA_DIR=profileA;expect(await library.getSkill(privateSkill.id)).toMatchObject({name:'Profile A only',instructions:'Keep this in its owner profile.'});expect((await library.listSkills()).map(skill=>skill.name)).toEqual(['Profile A only']);
  });
  it('persists across reopen, keeps immutable revisions and archived items searchable on request',async()=>{
    const library=await setup();const original=await library.createSkill({name:'Project notes',description:'Short guidance',instructions:'Keep source links.',source:'Created in the app'});const first=original.revision;
    const edited=await library.updateSkill(original.id,{name:'Project notes',description:'Updated guidance',instructions:'Keep source links and dates.'},first);expect(edited.revision).not.toBe(first);expect(await library.getSkill(original.id)).toMatchObject({revision:edited.revision,instructions:'Keep source links and dates.'});
    await expect(library.updateSkill(original.id,{name:'Project notes',description:'Stale',instructions:'Do not overwrite.'},first)).rejects.toThrow('changed since it was loaded');
    await expect(library.createSkill({name:'project NOTES',description:'Duplicate',instructions:'Conflict.'})).rejects.toThrow('already exists');
    library.closeSkillLibrary();expect(await library.getSkill(original.id)).toMatchObject({revision:edited.revision});expect((await library.listSkills('updated')).map(x=>x.id)).toContain(original.id);
    await library.archiveSkill(original.id,true);expect(await library.listSkills()).toEqual([]);expect((await library.listSkills('',true)).map(x=>x.id)).toContain(original.id);
  });
  it('bounds slash-picker results to metadata without changing full library search',async()=>{
    const library=await setup();for(const name of ['Design checks','Code checks','Writing checks'])await library.createSkill({name,description:'Searchable summary',instructions:'Private body that belongs to explicit load only.'});
    expect(await library.listSkills('',false,2)).toHaveLength(2);expect(await library.listSkills()).toHaveLength(3);expect((await library.listSkills('',false,50)).every(skill=>!('instructions' in skill))).toBe(true);
  });
  it('loads an explicitly pinned prior revision while the skill remains active',async()=>{
    const library=await setup();const first=await library.createSkill({name:'Versioned procedure',description:'First revision',instructions:'Use the original version.'});
    const second=await library.updateSkill(first.id,{name:first.name,description:'Second revision',instructions:'Use the edited version.'},first.revision);
    expect(second.revision).not.toBe(first.revision);
    expect(await library.getSkillRevision(first.id,first.revision)).toMatchObject({revision:first.revision,instructions:'Use the original version.'});
    await library.archiveSkill(first.id,true);
    await expect(library.getSkillRevision(first.id,first.revision)).rejects.toThrow('unavailable or archived');
  });
  it('upgrades schema version 1 transactionally and refuses newer schemas without rewriting them',async()=>{
    const library=await setup();await mkdir(temp,{recursive:true});const dbPath=library.skillDatabasePath();const legacy=new DatabaseSync(dbPath);legacy.exec(`CREATE TABLE skills(id TEXT PRIMARY KEY,current_revision TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
      CREATE TABLE skill_versions(skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,revision TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(skill_id,revision));
      CREATE TABLE skill_files(skill_id TEXT NOT NULL,revision TEXT NOT NULL,relative_path TEXT NOT NULL,content BLOB NOT NULL,PRIMARY KEY(skill_id,revision,relative_path),FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision) ON DELETE CASCADE);
      CREATE TABLE skill_loads(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,revision TEXT NOT NULL,task_id TEXT NOT NULL,pass_id TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision));
      CREATE INDEX skill_versions_search ON skill_versions(name,description);CREATE INDEX skill_loads_pass ON skill_loads(task_id,pass_id,role);PRAGMA user_version=1;
      INSERT INTO skills VALUES('legacy-id','legacy-revision','2026-01-01','2026-01-01',0);INSERT INTO skill_versions VALUES('legacy-id','legacy-revision','Legacy skill','Preserved during migration','Still available.','Imported','2026-01-01');`);legacy.close();
    expect(await library.listSkills()).toMatchObject([{id:'legacy-id',name:'Legacy skill'}]);expect(await library.recordedSkillSaves('task','pass')).toEqual([]);library.closeSkillLibrary();
    const current=new DatabaseSync(dbPath);expect(Number((current.prepare('PRAGMA user_version').get() as any).user_version)).toBe(2);expect(current.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_saves'").get()).toBeTruthy();current.exec('PRAGMA user_version=99');current.close();library.closeSkillLibrary();
    await expect(library.listSkills()).rejects.toThrow('newer than this version');const unchanged=new DatabaseSync(dbPath);expect(Number((unchanged.prepare('PRAGMA user_version').get() as any).user_version)).toBe(99);unchanged.close();
  });
  it('imports a skill definition and safe supporting files, and rejects traversal and malformed package data',async()=>{
    const library=await setup();const imported=await library.importSkillPackage([{path:'Guides/SKILL.md',content:Buffer.from('---\nname: Review helper\ndescription: Check source claims\n---\nUse clear source references.').toString('base64')},{path:'Guides/references/guide.md',content:Buffer.from('Read-only reference.').toString('base64')}],'guide-folder');
    expect(imported).toMatchObject({name:'Review helper',description:'Check source claims',instructions:'Use clear source references.',source:'Imported: guide-folder'});expect(imported.files).toEqual([{path:'references/guide.md',size:20}]);
    const revised=await library.updateSkill(imported.id,{name:imported.name,description:'Updated source note',instructions:imported.instructions});expect(revised.source).toBe('Imported: guide-folder');expect(revised.revision).not.toBe(imported.revision);const asset=await library.readSkillFile(imported.id,imported.revision,'references/guide.md');expect(Buffer.from(asset.content,'base64').toString()).toBe('Read-only reference.');
    await expect(library.importSkillPackage([{path:'../SKILL.md',content:Buffer.from('instruction').toString('base64')}])).rejects.toThrow('safe relative path');
    await expect(library.importSkillPackage([{path:'SKILL.md',content:'***'}])).rejects.toThrow('base64');
  });
  it('runs the real stdio MCP discovery and immutable load tools scoped to the current pass',async()=>{
    const library=await setup();const skill=await library.createSkill({name:'Useful skill',description:'Relevant methods',instructions:'Check assumptions before editing.'});const taskId='task-runtime';const passId='pass-runtime';await writeFile(path.join(temp,'state.json'),JSON.stringify({tasks:[{id:taskId,currentPassId:passId}]}));
    const client=new Client({name:'skills-library-test',version:'1'});const gateway=path.resolve('server/skills-mcp-gateway.ts');const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',gateway],env:{...process.env,PSEUDOHARNESS_DATA_DIR:temp,PSEUDOHARNESS_SKILLS_TASK_ID:taskId,PSEUDOHARNESS_SKILLS_ROLE:'simple'},stderr:'ignore'});
    try{await client.connect(transport);const listed=await client.listTools();expect(listed.tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['skills_list','skills_search','skills_load','skills_read_file','skills_save']));const found=await client.callTool({name:'skills_search',arguments:{query:'methods'}});expect(JSON.stringify(found)).toContain(skill.name);const loaded=await client.callTool({name:'skills_load',arguments:{skill_id:`library:${skill.id}`}});expect(JSON.stringify(loaded)).toContain(skill.revision);expect(JSON.stringify(loaded)).toContain('Check assumptions before editing.');expect(await library.recordedSkillLoads(taskId,passId)).toHaveLength(1);const saved=await client.callTool({name:'skills_save',arguments:{skill_id:`library:${skill.id}`,expected_revision:skill.revision,name:skill.name,description:'Updated by agent',instructions:'Save must not execute this content.'}});const savedData=JSON.parse(((saved as any).content[0]).text);expect(savedData.revision).not.toBe(skill.revision);expect(JSON.stringify(await library.getSkill(skill.id))).toContain('Save must not execute this content.');expect(await library.recordedSkillSaves(taskId,passId)).toHaveLength(1);const stale=await client.callTool({name:'skills_save',arguments:{skill_id:`library:${skill.id}`,expected_revision:skill.revision,name:skill.name,description:'Stale',instructions:'Overwrite'}});expect(stale.isError).toBe(true);}
    finally{await client.close();}
  });
});
