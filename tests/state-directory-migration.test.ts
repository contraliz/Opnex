import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultDataDirectory, legacyDataDirectory } from '../server/paths.js';
import { migrateLegacyStateDirectory } from '../server/state-directory-migration.js';

const roots:string[]=[];
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'opnex-state-migration-'));roots.push(root);
  const home=path.join(root,'home');
  const env:NodeJS.ProcessEnv=process.platform==='win32'?{LOCALAPPDATA:path.join(root,'local')}:process.platform==='darwin'?{}:{XDG_DATA_HOME:path.join(root,'xdg')};
  return {root,home,env,current:defaultDataDirectory({platform:process.platform,home,env}),legacy:legacyDataDirectory({platform:process.platform,home,env})};
}

afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20})));});

describe('Opnex state-directory migration',()=>{
  it.skipIf(process.platform!=='win32')('does not probe or migrate the legacy Windows LocalAppData root',async()=>{
    const {home,env,current,legacy}=await fixture();await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,'state.json'),'legacy-state');
    const probes:string[]=[];
    const result=(migrateLegacyStateDirectory as unknown as (...args:any[])=>any)(env,'win32',home,(candidate:string)=>{probes.push(candidate);return true;});
    expect(current).toBe(path.win32.join(env.LOCALAPPDATA!,'Opnex'));
    expect(legacy).toBe(path.win32.join(env.LOCALAPPDATA!,'Pseudoharness'));
    expect(result).toEqual({status:'unchanged',current});
    expect(probes).toEqual([]);
    await expect(access(current)).rejects.toMatchObject({code:'ENOENT'});
    await expect(readFile(path.join(legacy,'state.json'),'utf8')).resolves.toBe('legacy-state');
  });

  it.skipIf(process.platform==='win32')('copies legacy state into the Opnex directory and leaves the source as a backup',async()=>{
    const {home,env,current,legacy}=await fixture();await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,'state.json'),'legacy-settings-and-sessions');
    expect(migrateLegacyStateDirectory(env,process.platform,home)).toMatchObject({status:'copied',current,legacy});
    await expect(readFile(path.join(current,'state.json'),'utf8')).resolves.toBe('legacy-settings-and-sessions');
    await expect(readFile(path.join(legacy,'state.json'),'utf8')).resolves.toBe('legacy-settings-and-sessions');
    await expect(access(path.join(current,'.opnex-state-migration.json'))).resolves.toBeUndefined();
  });

  it.skipIf(process.platform==='win32')('preserves both directories without merging when the destination already has data',async()=>{
    const {home,env,current,legacy}=await fixture();await mkdir(legacy,{recursive:true});await mkdir(current,{recursive:true});
    await writeFile(path.join(legacy,'state.json'),'legacy-state');await writeFile(path.join(current,'state.json'),'existing-opnex-state');
    expect(migrateLegacyStateDirectory(env,process.platform,home)).toMatchObject({status:'legacy-preserved',current,legacy});
    await expect(readFile(path.join(legacy,'state.json'),'utf8')).resolves.toBe('legacy-state');
    await expect(readFile(path.join(current,'state.json'),'utf8')).resolves.toBe('existing-opnex-state');
  });

  it.skipIf(process.platform==='win32')('copies legacy data into an empty destination directory',async()=>{
    const {home,env,current,legacy}=await fixture();await mkdir(legacy,{recursive:true});await mkdir(current,{recursive:true});
    await writeFile(path.join(legacy,'skills.sqlite3'),'skills');
    expect(migrateLegacyStateDirectory(env,process.platform,home).status).toBe('copied');
    await expect(readFile(path.join(current,'skills.sqlite3'),'utf8')).resolves.toBe('skills');
  });

  it.skipIf(process.platform==='win32')('recognizes its prior copy without overwriting newer Opnex data',async()=>{
    const {home,env,current,legacy}=await fixture();await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,'state.json'),'legacy-state');
    expect(migrateLegacyStateDirectory(env,process.platform,home).status).toBe('copied');
    await writeFile(path.join(current,'state.json'),'newer-opnex-state');
    expect(migrateLegacyStateDirectory(env,process.platform,home)).toMatchObject({status:'previously-copied',current,legacy});
    await expect(readFile(path.join(current,'state.json'),'utf8')).resolves.toBe('newer-opnex-state');
    await expect(readFile(path.join(legacy,'state.json'),'utf8')).resolves.toBe('legacy-state');
  });

  it('does not migrate a caller-selected data directory',async()=>{
    const {home,env,legacy}=await fixture();await mkdir(legacy,{recursive:true});await writeFile(path.join(legacy,'state.json'),'legacy-state');
    const chosen=path.join(os.tmpdir(),'explicit-opnex-state');
    expect(migrateLegacyStateDirectory({...env,OPNEX_DATA_DIR:chosen},process.platform,home)).toMatchObject({status:'explicit',current:chosen});
    await expect(readFile(path.join(legacy,'state.json'),'utf8')).resolves.toBe('legacy-state');
  });
});
