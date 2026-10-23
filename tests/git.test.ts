import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkspaceGitSnapshot } from '../server/git.js';

let temporary:string|undefined;
afterEach(async()=>{if(temporary){await rm(temporary,{recursive:true,force:true});temporary=undefined;}});

function git(args:string[],cwd:string){execFileSync('git',args,{cwd,stdio:'ignore',windowsHide:true});}
async function gitAvailable(){try{execFileSync('git',['--version'],{stdio:'ignore',windowsHide:true});return true;}catch{return false;}}
const canRunGit=await gitAvailable();

describe('read-only workspace Git snapshots',()=>{
  it.runIf(canRunGit)('shows actual tracked, staged, and untracked changes without touching the index',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-git-'));
    git(['init','--quiet'],temporary);git(['config','user.name','Pseudoharness test'],temporary);git(['config','user.email','test@example.invalid'],temporary);
    await writeFile(path.join(temporary,'app.ts'),'const value = 1;\n');await writeFile(path.join(temporary,'.gitignore'),'private.txt\n');await writeFile(path.join(temporary,'binary.dat'),Buffer.from([0,1,2,3]));
    git(['add','app.ts','.gitignore','binary.dat'],temporary);git(['commit','--quiet','-m','fixture'],temporary);
    await writeFile(path.join(temporary,'app.ts'),'const value = 2;\n');git(['add','app.ts'],temporary);await writeFile(path.join(temporary,'app.ts'),'const value = 3;\n');await writeFile(path.join(temporary,'binary.dat'),Buffer.from([0,2,4,6]));
    await writeFile(path.join(temporary,'new file.txt'),'first line\nsecond line\n');await writeFile(path.join(temporary,'private.txt'),'must stay ignored');
    const before=execFileSync('git',['status','--porcelain=v1','-z','--untracked-files=all'],{cwd:temporary}).toString();
    const snapshot=await readWorkspaceGitSnapshot(temporary);
    const after=execFileSync('git',['status','--porcelain=v1','-z','--untracked-files=all'],{cwd:temporary}).toString();
    const canonical=await realpath(temporary);
    expect(snapshot.available).toBe(true);expect(snapshot.workspaceRoot).toBe(canonical);expect(snapshot.repositoryRoot).toBe(canonical);
    expect(snapshot.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'app.ts',kind:'tracked'}),
      expect.objectContaining({path:'new file.txt',kind:'untracked'}),
    ]));
    expect(snapshot.diff).toContain('-const value = 1;');expect(snapshot.diff).toContain('+const value = 3;');
    expect(snapshot.diff).toContain('+second line');expect(snapshot.diff).not.toContain('must stay ignored');
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'app.ts',additions:1,deletions:1,binary:false,patch:expect.stringContaining('+const value = 3;')}),
      expect.objectContaining({path:'new file.txt',additions:2,deletions:0,binary:false}),
      expect.objectContaining({path:'binary.dat',additions:null,deletions:null,binary:true}),
    ]));
    expect(after).toBe(before);
  });

  it.runIf(canRunGit)('refuses to inspect a Git root above the selected workspace',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-git-boundary-'));
    git(['init','--quiet'],temporary);await mkdir(path.join(temporary,'workspace'));await writeFile(path.join(temporary,'outside.txt'),'private');
    const snapshot=await readWorkspaceGitSnapshot(path.join(temporary,'workspace'));
    expect(snapshot.available).toBe(false);expect(snapshot.message).toMatch(/outside this task workspace/);expect(snapshot.diff).toBe('');
  });

  it('reports a workspace without a Git repository without inventing a diff',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-no-git-'));
    const snapshot=await readWorkspaceGitSnapshot(temporary);
    expect(snapshot).toMatchObject({available:false,changes:[],diff:'',message:'This workspace is not inside a Git repository.'});
  });
});
