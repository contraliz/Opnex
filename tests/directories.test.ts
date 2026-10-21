import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChildDirectory, listDirectories, resolveProjectDirectory, validateProjectDirectory } from '../server/directories.js';

let temporary:string|undefined;
afterEach(async()=>{if(temporary){await rm(temporary,{recursive:true,force:true});temporary=undefined;}});

describe('local directory browsing',()=>{
  it('returns canonical directory paths and only child directories',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    await mkdir(path.join(temporary,'Projects'));
    await mkdir(path.join(temporary,'Archive'));
    await writeFile(path.join(temporary,'notes.txt'),'not listed');
    const listing=await listDirectories(temporary);
    expect(listing.path).toBe(await realPath(temporary));
    expect(listing.parent).toBe(path.dirname(listing.path!));
    expect(listing.entries.map(entry=>entry.name)).toEqual(['Archive','Projects']);
    expect(listing.entries.every(entry=>entry.path.startsWith(listing.path!))).toBe(true);
    expect(listing.truncated).toBe(false);
  });

  it('rejects relative, missing and file paths with actionable errors',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    const file=path.join(temporary,'file.txt');await writeFile(file,'content');
    await expect(listDirectories('relative/path')).rejects.toThrow('Enter an absolute folder path.');
    await expect(resolveProjectDirectory('relative/path')).rejects.toThrow('Enter an absolute folder path.');
    await expect(listDirectories(path.join(temporary,'missing'))).rejects.toThrow('does not exist');
    await expect(resolveProjectDirectory(path.join(temporary,'missing'))).rejects.toThrow('That folder does not exist or is not a directory.');
    await expect(resolveProjectDirectory(path.join(temporary,'missing'))).rejects.not.toThrow(temporary);
    await expect(listDirectories(file)).rejects.toThrow('not a directory');
    await expect(resolveProjectDirectory(file)).rejects.toThrow('Project root must be a directory.');
    expect(await resolveProjectDirectory(temporary)).toBe(await realPath(temporary));
  });

  it('returns a root location for the computer navigation entry',async()=>{
    const listing=await listDirectories(undefined,true);
    expect(listing.path).toBeNull();
    expect(listing.roots?.length).toBeGreaterThan(0);
  });

  it('validates a selected folder without enumerating its contents',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    await mkdir(path.join(temporary,'child'));
    const result=await validateProjectDirectory(path.join(temporary,'child'));
    expect(result.path).toBe(await realPath(path.join(temporary,'child')));
    expect(result.parent).toBe(await realPath(temporary));
    expect(result.entries).toEqual([]);
  });

  it('creates one child folder under the canonical selected parent without recursion',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    const parent=path.join(temporary,'Projects');await mkdir(parent);
    const created=await createChildDirectory(parent,'New project');
    expect(created).toEqual({parent:await realPath(parent),entry:{name:'New project',path:path.join(await realPath(parent),'New project')}});
    expect((await listDirectories(parent)).entries.map(entry=>entry.name)).toEqual(['New project']);
    await expect(createChildDirectory(parent,'nested/child')).rejects.toThrow('single folder name');
    await expect(access(path.join(temporary,'nested'))).rejects.toThrow();
  });

  it('rejects empty, traversal, separator and control-character names',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    for(const name of ['', '   ','.','..','../outside','nested/child',`nested\\child`,'bad\u0000name'])await expect(createChildDirectory(temporary,name)).rejects.toThrow();
    if(process.platform==='win32')for(const name of ['CON','folder.','folder ','bad:name'])await expect(createChildDirectory(temporary,name)).rejects.toThrow('not valid for a Windows folder');
    await expect(createChildDirectory(path.join(temporary,'missing'),'New')).rejects.toThrow('does not exist');
  });

  it('does not overwrite an existing file or folder',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-folders-'));
    const existing=path.join(temporary,'same');await writeFile(existing,'keep this file');
    await expect(createChildDirectory(temporary,'same')).rejects.toThrow('already exists');
    expect(await readFile(existing,'utf8')).toBe('keep this file');
    await mkdir(path.join(temporary,'folder'));
    await expect(createChildDirectory(temporary,'folder')).rejects.toThrow('already exists');
  });
});

async function realPath(value:string){return (await import('node:fs/promises')).realpath(value);}
