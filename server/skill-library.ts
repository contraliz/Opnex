import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateDirectory } from './paths.js';

export const MAX_SKILL_INSTRUCTIONS=256*1024;
export const MAX_SKILL_FILES=128;
export const MAX_SKILL_FILE_BYTES=2*1024*1024;
export const MAX_SKILL_TOTAL_BYTES=8*1024*1024;
export type SkillFileInput={path:string;content:string};
export type SkillVersion={skillId:string;revision:string;name:string;description:string;instructions:string;source:string;createdAt:string;files:{path:string;size:number}[]};
export type SkillSummary={id:string;name:string;description:string;source:string;revision:string;createdAt:string;updatedAt:string;archived:boolean;fileCount:number};
const databases=new Map<string,DatabaseSync>();

function database(){
  const next=path.join(stateDirectory(),'skills.sqlite3');
  const existing=databases.get(next);if(existing)return existing;
  const opened=new DatabaseSync(next);
  try{
    opened.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    const version=Number(opened.prepare('PRAGMA user_version').get()?.user_version||0);
    if(version>2)throw new Error(`The skills database is newer than this version of Pseudoharness can read (schema ${version}).`);
    if(version===0){opened.exec(`BEGIN IMMEDIATE; CREATE TABLE skills(id TEXT PRIMARY KEY, current_revision TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)));
      CREATE TABLE skill_versions(skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE, revision TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(skill_id,revision));
      CREATE TABLE skill_files(skill_id TEXT NOT NULL, revision TEXT NOT NULL, relative_path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(skill_id,revision,relative_path), FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision) ON DELETE CASCADE);
      CREATE TABLE skill_loads(id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, revision TEXT NOT NULL, task_id TEXT NOT NULL, pass_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision));
      CREATE INDEX skill_versions_search ON skill_versions(name,description); CREATE INDEX skill_loads_pass ON skill_loads(task_id,pass_id,role); PRAGMA user_version=1; COMMIT;`);}
    if(version<2){opened.exec(`BEGIN IMMEDIATE; CREATE TABLE skill_saves(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,revision TEXT NOT NULL,task_id TEXT NOT NULL,pass_id TEXT NOT NULL,role TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision)); CREATE INDEX skill_saves_pass ON skill_saves(task_id,pass_id,role); PRAGMA user_version=2; COMMIT;`);}
  }catch(error){opened.close();throw error;}
  databases.set(next,opened);return opened;
}
export async function initializeSkillLibrary(){await mkdir(stateDirectory(),{recursive:true,mode:0o700});database();}
function validateText(value:unknown,label:string,max:number){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label} must contain between 1 and ${max.toLocaleString()} characters.`);return value.trim();}
function normalizeFiles(files:unknown):{path:string;content:Buffer}[]{
  if(files===undefined)return [];
  if(!Array.isArray(files)||files.length>MAX_SKILL_FILES)throw new Error(`A skill can include up to ${MAX_SKILL_FILES} supporting files.`);
  const paths=new Set<string>();let total=0;
  return files.map((entry,index)=>{
    if(!entry||typeof entry!=='object')throw new Error(`Supporting file ${index+1} is invalid.`);
    const relative=String((entry as SkillFileInput).path||'').replaceAll('\\','/');
    if(!relative||relative.startsWith('/')||/^[A-Za-z]:/.test(relative)||relative.split('/').some(part=>!part||part==='.'||part==='..')||relative.length>240)throw new Error(`Supporting file path "${relative}" must be a safe relative path.`);
    if(paths.has(relative.toLocaleLowerCase()))throw new Error(`The supporting file path "${relative}" is duplicated.`);paths.add(relative.toLocaleLowerCase());
    const raw=(entry as SkillFileInput).content;
    if(typeof raw!=='string'||raw.length>Math.ceil(MAX_SKILL_FILE_BYTES*4/3)+16)throw new Error(`Supporting file "${relative}" is too large.`);
    let content:Buffer;try{content=Buffer.from(raw,'base64');if(content.toString('base64')!==raw.replace(/\s/g,''))throw new Error();}catch{throw new Error(`Supporting file "${relative}" is not valid base64 data.`);}
    if(content.length>MAX_SKILL_FILE_BYTES)throw new Error(`Supporting file "${relative}" exceeds the 2 MiB limit.`);total+=content.length;
    if(total>MAX_SKILL_TOTAL_BYTES)throw new Error('Supporting files exceed the 8 MiB total limit.');return {path:relative,content};
  });
}
function versionInput(input:{name:unknown;description:unknown;instructions:unknown;source?:unknown;files?:unknown}){
  const name=validateText(input.name,'Skill name',120),description=typeof input.description==='string'?input.description.trim().slice(0,1000):'';
  const instructions=validateText(input.instructions,'Instructions',MAX_SKILL_INSTRUCTIONS);
  const source=typeof input.source==='string'?input.source.trim().slice(0,500):'Created in Pseudoharness';
  const files=normalizeFiles(input.files);const material=JSON.stringify({name,description,instructions,source,files:files.map(file=>[file.path,createHash('sha256').update(file.content).digest('hex')])});
  const revision=createHash('sha256').update(material).digest('hex');return {name,description,instructions,source,files,revision};
}
export async function createSkill(input:{name:unknown;description:unknown;instructions:unknown;source?:unknown;files?:unknown},record?:{taskId:string;passId:string;role:string}){
  await initializeSkillLibrary();const parsed=versionInput(input),id=randomUUID(),now=new Date().toISOString(),d=database();d.exec('BEGIN IMMEDIATE');try{if(d.prepare('SELECT 1 FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.revision=s.current_revision WHERE s.archived=0 AND v.name=? COLLATE NOCASE').get(parsed.name))throw new Error(`An active saved skill named "${parsed.name}" already exists.`);d.prepare('INSERT INTO skills(id,current_revision,created_at,updated_at,archived) VALUES(?,?,?,?,0)').run(id,parsed.revision,now,now);d.prepare('INSERT INTO skill_versions(skill_id,revision,name,description,instructions,source,created_at) VALUES(?,?,?,?,?,?,?)').run(id,parsed.revision,parsed.name,parsed.description,parsed.instructions,parsed.source,now);const ins=d.prepare('INSERT INTO skill_files(skill_id,revision,relative_path,content) VALUES(?,?,?,?)');for(const file of parsed.files)ins.run(id,parsed.revision,file.path,file.content);if(record)d.prepare('INSERT INTO skill_saves(id,skill_id,revision,task_id,pass_id,role,action,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,parsed.revision,record.taskId,record.passId,record.role,'create',now);d.exec('COMMIT');}catch(error){d.exec('ROLLBACK');throw error;}return getSkill(id);
}
export async function importSkillPackage(files:unknown,sourceLabel='Imported skill'){
  const normalized=normalizeFiles(files);const definition=normalized.find(file=>path.posix.basename(file.path).toLowerCase()==='skill.md');
  if(!definition)throw new Error('Choose a skill folder that contains a SKILL.md file.');
  const root=definition.path.slice(0,-'SKILL.md'.length).replace(/\/$/,'');
  const content=definition.content.toString('utf8');const front=content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const field=(key:string)=>front?.[1].match(new RegExp(`^${key}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\r\\n#]*))\\s*$`,'mi'))?.slice(1).find(Boolean)?.trim()||'';
  const name=field('name')||path.posix.basename(root)||'Imported skill';const description=field('description');const instructions=front?content.slice(front[0].length).trim():content.trim();
  if(!instructions)throw new Error('SKILL.md needs instruction content before it can be saved.');
  const extras=normalized.filter(file=>file!==definition).map(file=>({path:root&&file.path.startsWith(`${root}/`)?file.path.slice(root.length+1):file.path,content:file.content.toString('base64')}));
  return createSkill({name,description,instructions,source:`Imported: ${String(sourceLabel).slice(0,300)}`,files:extras});
}
export async function updateSkill(id:string,input:{name:unknown;description:unknown;instructions:unknown;source?:unknown;files?:unknown},expectedRevision?:string,record?:{taskId:string;passId:string;role:string}){
  await initializeSkillLibrary();const d=database();d.exec('BEGIN IMMEDIATE');try{const current=d.prepare('SELECT current_revision FROM skills WHERE id=? AND archived=0').get(id) as {current_revision:string}|undefined;if(!current)throw new Error('Saved skill not found or archived.');if(expectedRevision&&current.current_revision!==expectedRevision)throw new Error('This skill changed since it was loaded. Reload the latest revision before saving.');const oldVersion=d.prepare('SELECT source FROM skill_versions WHERE skill_id=? AND revision=?').get(id,current.current_revision) as {source:string};
  const parsed=versionInput({...input,source:input.source??oldVersion.source});if(input.files===undefined){const old=d.prepare('SELECT relative_path,content FROM skill_files WHERE skill_id=? AND revision=?').all(id,current.current_revision) as any[];parsed.files=old.map(file=>({path:file.relative_path,content:Buffer.from(file.content)}));const material=JSON.stringify({name:parsed.name,description:parsed.description,instructions:parsed.instructions,source:parsed.source,files:parsed.files.map(file=>[file.path,createHash('sha256').update(file.content).digest('hex')])});parsed.revision=createHash('sha256').update(material).digest('hex');}if(d.prepare('SELECT 1 FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.revision=s.current_revision WHERE s.archived=0 AND s.id<>? AND v.name=? COLLATE NOCASE').get(id,parsed.name))throw new Error(`An active saved skill named "${parsed.name}" already exists.`);const now=new Date().toISOString();if(parsed.revision!==current.current_revision){d.prepare('INSERT INTO skill_versions(skill_id,revision,name,description,instructions,source,created_at) VALUES(?,?,?,?,?,?,?)').run(id,parsed.revision,parsed.name,parsed.description,parsed.instructions,parsed.source,now);const insert=d.prepare('INSERT INTO skill_files(skill_id,revision,relative_path,content) VALUES(?,?,?,?)');for(const file of parsed.files)insert.run(id,parsed.revision,file.path,file.content);d.prepare('UPDATE skills SET current_revision=?,updated_at=? WHERE id=?').run(parsed.revision,now,id);}if(record)d.prepare('INSERT INTO skill_saves(id,skill_id,revision,task_id,pass_id,role,action,created_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,parsed.revision,record.taskId,record.passId,record.role,'update',now);d.exec('COMMIT');}catch(error){d.exec('ROLLBACK');throw error;}return getSkill(id);
}
export async function archiveSkill(id:string,archived:boolean){await initializeSkillLibrary();const d=database();const result=d.prepare('UPDATE skills SET archived=?,updated_at=? WHERE id=?').run(archived?1:0,new Date().toISOString(),id);if(!result.changes)throw new Error('Saved skill not found.');return getSkill(id,true);}
function mapSummary(row:any):SkillSummary{return {id:row.id,name:row.name,description:row.description,source:row.source,revision:row.revision,createdAt:row.version_created_at,updatedAt:row.updated_at,archived:!!row.archived,fileCount:Number(row.file_count||0)};}
const summarySql=`SELECT s.id,s.updated_at,s.archived,v.name,v.description,v.source,v.revision,v.created_at AS version_created_at,(SELECT count(*) FROM skill_files f WHERE f.skill_id=s.id AND f.revision=v.revision) AS file_count FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.revision=s.current_revision`;
export async function listSkills(query='',includeArchived=false,limit?:number){
  await initializeSkillLibrary();const d=database();const q=query.trim().slice(0,200);
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<1))throw new Error('The saved-skill result limit must be a positive integer.');
  const bounded=limit===undefined?null:Math.min(50,limit);const pattern=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
  const sql=`${summarySql} WHERE (?=1 OR s.archived=0) AND (?='' OR v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\') ORDER BY s.archived,v.name COLLATE NOCASE`;
  const rows=bounded===null?d.prepare(sql).all(includeArchived?1:0,q,pattern,pattern):d.prepare(`${sql} LIMIT ?`).all(includeArchived?1:0,q,pattern,pattern,bounded);
  return rows.map(mapSummary);
}
export async function getSkill(id:string,includeArchived=false):Promise<SkillVersion&SkillSummary>{await initializeSkillLibrary();const d=database(),row=d.prepare(`${summarySql} WHERE s.id=? AND (?=1 OR s.archived=0)`).get(id,includeArchived?1:0);if(!row)throw new Error('Saved skill not found.');const files=d.prepare('SELECT relative_path, length(content) AS size FROM skill_files WHERE skill_id=? AND revision=? ORDER BY relative_path').all(id,(row as any).revision).map((f:any)=>({path:f.relative_path,size:Number(f.size)}));const version=d.prepare('SELECT instructions FROM skill_versions WHERE skill_id=? AND revision=?').get(id,(row as any).revision) as any;return {...mapSummary(row),skillId:id,revision:(row as any).revision,name:(row as any).name,description:(row as any).description,source:(row as any).source,createdAt:(row as any).version_created_at,instructions:version.instructions,files};}
export async function getSkillRevision(id:string,revision:string):Promise<SkillVersion&SkillSummary>{
  await initializeSkillLibrary();if(!/^[a-f0-9]{64}$/i.test(revision))throw new Error('That saved-skill revision is invalid.');
  const d=database(),row=d.prepare(`SELECT s.id,s.updated_at,s.archived,v.name,v.description,v.source,v.revision,v.created_at AS version_created_at,(SELECT count(*) FROM skill_files f WHERE f.skill_id=s.id AND f.revision=v.revision) AS file_count FROM skills s JOIN skill_versions v ON v.skill_id=s.id WHERE s.id=? AND s.archived=0 AND v.revision=?`).get(id,revision.toLocaleLowerCase());if(!row)throw new Error('The selected saved-skill revision is unavailable or archived. Search the Skills library and choose an active skill.');
  const files=d.prepare('SELECT relative_path, length(content) AS size FROM skill_files WHERE skill_id=? AND revision=? ORDER BY relative_path').all(id,revision.toLocaleLowerCase()).map((f:any)=>({path:f.relative_path,size:Number(f.size)}));const version=d.prepare('SELECT instructions FROM skill_versions WHERE skill_id=? AND revision=?').get(id,revision.toLocaleLowerCase()) as any;
  return {...mapSummary(row),skillId:id,revision:(row as any).revision,name:(row as any).name,description:(row as any).description,source:(row as any).source,createdAt:(row as any).version_created_at,instructions:version.instructions,files};
}
export async function searchSkillDescriptions(query:string,limit=20){const rows=await listSkills(query);return rows.slice(0,Math.min(50,Math.max(1,limit))).map(({id,name,description,source,revision})=>({id:`library:${id}`,name,description,source,revision}));}
export async function loadSkillForAgent(id:string,taskId:string,passId:string,role:string){await initializeSkillLibrary();if(!['direct','simple','orchestrator','worker'].includes(role))throw new Error('This role cannot load saved skills.');const skill=await getSkill(id);const d=database();d.prepare('INSERT INTO skill_loads(id,skill_id,revision,task_id,pass_id,role,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,skill.revision,taskId,passId,role,new Date().toISOString());return skill;}
export async function readSkillFile(id:string,revision:string,filePath:string){await initializeSkillLibrary();if(!/^[a-f0-9]{64}$/.test(revision)||!filePath||filePath.startsWith('/')||filePath.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))throw new Error('Choose a supporting file from the saved skill revision.');const file=database().prepare('SELECT content FROM skill_files WHERE skill_id=? AND revision=? AND relative_path=?').get(id,revision,filePath) as {content:Uint8Array}|undefined;if(!file)throw new Error('That supporting file is not part of this skill revision.');const content=Buffer.from(file.content);return {path:filePath,size:content.length,content:content.toString('base64'),text:content.includes(0)?undefined:content.toString('utf8')};}
export async function recordedSkillLoads(taskId:string,passId:string){if(!existsSync(skillDatabasePath()))return [];await initializeSkillLibrary();const d=database();return d.prepare('SELECT l.skill_id AS skillId,l.revision,l.role,l.created_at AS loadedAt,v.name,v.description,v.source,v.instructions FROM skill_loads l JOIN skill_versions v ON v.skill_id=l.skill_id AND v.revision=l.revision WHERE l.task_id=? AND l.pass_id=? ORDER BY l.created_at').all(taskId,passId) as any[];}
export async function recordedSkillSaves(taskId:string,passId:string){if(!existsSync(skillDatabasePath()))return [];await initializeSkillLibrary();const d=database();return d.prepare('SELECT s.skill_id AS skillId,s.revision,s.role,s.action,s.created_at AS savedAt,v.name,v.description,v.source FROM skill_saves s JOIN skill_versions v ON v.skill_id=s.skill_id AND v.revision=s.revision WHERE s.task_id=? AND s.pass_id=? ORDER BY s.created_at').all(taskId,passId) as any[];}
export function skillDatabasePath(){return path.join(stateDirectory(),'skills.sqlite3');}
export function closeSkillLibrary(){for(const connection of databases.values())connection.close();databases.clear();}
