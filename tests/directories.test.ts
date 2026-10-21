import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listDirectories, resolveProjectDirectory, validateProjectDirectory } from '../server/directories.js';

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
});

async function realPath(value:string){return (await import('node:fs/promises')).realpath(value);}
