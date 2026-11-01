import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require=createRequire(import.meta.url);
const {desktopUserDataPath,desktopUserDataPaths,desktopUserDataPathForLock,desktopStorageFallbackPaths,migrateDesktopUserData}=require('../desktop/storage-migration.cjs');
const roots:string[]=[];
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'opnex-desktop-migration-'));roots.push(root);return desktopUserDataPaths(root);}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20})));});

describe('Electron Opnex user-data migration',()=>{
  it('selects the current Roaming Opnex root directly for Windows startup',()=>{
    const appData=path.win32.resolve('C:\\fixtures\\AppData\\Roaming');
    expect(desktopUserDataPath(appData,'win32')).toBe(path.win32.join(appData,'Opnex'));
    expect(desktopUserDataPath(appData,'win32')).not.toBe(path.win32.join(appData,'Pseudoharness'));
  });

  it('copies the legacy profile while preserving its source and excluding the old process lock',async()=>{
    const paths=await fixture();await mkdir(path.join(paths.legacy,'local-state'),{recursive:true});
    await writeFile(path.join(paths.legacy,'local-state','state.json'),'saved-settings');await writeFile(path.join(paths.legacy,'local-state','skills.sqlite3'),'saved-skills');await writeFile(path.join(paths.legacy,'lockfile'),'');
    expect(desktopUserDataPathForLock(paths)).toBe(paths.legacy);
    expect(migrateDesktopUserData(paths)).toEqual({directory:paths.current,migrated:true,status:'copied'});
    await expect(readFile(path.join(paths.current,'local-state','state.json'),'utf8')).resolves.toBe('saved-settings');
    await expect(readFile(path.join(paths.current,'local-state','skills.sqlite3'),'utf8')).resolves.toBe('saved-skills');
    await expect(readFile(path.join(paths.legacy,'local-state','state.json'),'utf8')).resolves.toBe('saved-settings');
    await expect(access(path.join(paths.current,'lockfile'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(access(path.join(paths.legacy,'lockfile'))).resolves.toBeUndefined();
    expect(desktopUserDataPathForLock(paths)).toBe(paths.current);
    expect(desktopStorageFallbackPaths(paths,new Error('A completed migration must remain on the Opnex root.'))).toBeNull();
    expect(migrateDesktopUserData(paths)).toMatchObject({migrated:false,status:'previously-copied'});
  });

  it('selects legacy data only when the destination is safe to leave unused',async()=>{
    const paths=await fixture();
    await mkdir(paths.legacy,{recursive:true});const failure=new Error('The destination refused the migration copy.');
    expect(desktopStorageFallbackPaths(paths,failure)).toEqual({userData:paths.legacy});
    await mkdir(paths.current,{recursive:true});expect(desktopStorageFallbackPaths(paths,failure)).toEqual({userData:paths.legacy});
    await writeFile(path.join(paths.current,'state.json'),'new Opnex data');expect(desktopStorageFallbackPaths(paths,failure)).toBeNull();
    expect(desktopStorageFallbackPaths(paths,Object.assign(new Error('Two populated roots.'),{code:'OPNEX_STORAGE_MIGRATION_CONFLICT'}))).toBeNull();
  });

  it('does not fall back to a non-directory or linked legacy root',async()=>{
    const paths=await fixture(),failure=new Error('The copy failed.');
    for(const legacyStat of [{isDirectory:()=>false,isSymbolicLink:()=>false},{isDirectory:()=>true,isSymbolicLink:()=>true}]){
      const operations={existsSync:(target:string)=>target===paths.legacy,lstatSync:()=>legacyStat};
      expect(desktopStorageFallbackPaths(paths,failure,operations)).toBeNull();
    }
  });

  it('copies into an empty Opnex folder',async()=>{
    const paths=await fixture();await mkdir(paths.legacy,{recursive:true});await mkdir(paths.current,{recursive:true});await writeFile(path.join(paths.legacy,'Local State'),'electron-profile');
    expect(migrateDesktopUserData(paths)).toMatchObject({directory:paths.current,migrated:true});
    await expect(readFile(path.join(paths.current,'Local State'),'utf8')).resolves.toBe('electron-profile');
    await expect(readFile(path.join(paths.legacy,'Local State'),'utf8')).resolves.toBe('electron-profile');
  });

  it('refuses an ambiguous two-profile merge and preserves both sides',async()=>{
    const paths=await fixture();await mkdir(paths.legacy,{recursive:true});await mkdir(paths.current,{recursive:true});
    await writeFile(path.join(paths.legacy,'local-state.json'),'legacy');await writeFile(path.join(paths.current,'local-state.json'),'opnex');
    expect(()=>migrateDesktopUserData(paths)).toThrow(/Both legacy and Opnex desktop data directories contain data/);
    await expect(readFile(path.join(paths.legacy,'local-state.json'),'utf8')).resolves.toBe('legacy');
    await expect(readFile(path.join(paths.current,'local-state.json'),'utf8')).resolves.toBe('opnex');
  });

  it('preserves the migration error when staging cleanup also fails',()=>{
    const legacy=path.join(os.tmpdir(),'opnex-migration-fixture','Pseudoharness'),current=path.join(os.tmpdir(),'opnex-migration-fixture','Opnex'),staging=path.join(os.tmpdir(),'.opnex-storage-migration-fixture');
    const copyError=Object.assign(new Error('Fixture migration copy failure.'),{code:'EACCES'}),cleanupError=Object.assign(new Error(`EPERM, Permission denied: '${staging}'`),{code:'EPERM'});
    const operations={existsSync:(target:string)=>target===legacy,lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false}),readdirSync:()=>[],mkdirSync:()=>undefined,mkdtempSync:()=>staging,cpSync:()=>{throw copyError;},rmSync:()=>{throw cleanupError;}};
    let thrown:unknown;try{migrateDesktopUserData({legacy,current},operations);}catch(error){thrown=error;}
    expect(thrown).toBe(copyError);expect((thrown as Error&{cleanupError?:Error})?.cleanupError).toBe(cleanupError);
  });
});
