import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureTurnSourceFingerprint, compareTurnSourceFingerprints } from '../server/turn-source-snapshot.js';

let temporary:string|undefined;
afterEach(async()=>{if(temporary){await rm(temporary,{recursive:true,force:true});temporary=undefined;}});
function git(args:string[],cwd:string){execFileSync('git',args,{cwd,stdio:'ignore',windowsHide:true});}
async function gitAvailable(){try{execFileSync('git',['--version'],{stdio:'ignore',windowsHide:true});return true;}catch{return false;}}
const canRunGit=await gitAvailable();

describe('per-turn workspace source snapshots',()=>{
  it.runIf(canRunGit)('distinguishes an unchanged workspace from text, binary, and committed source changes without storing contents',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-turn-source-'));
    git(['init','--quiet'],temporary);git(['config','user.name','Pseudoharness test'],temporary);git(['config','user.email','test@example.invalid'],temporary);
    await writeFile(path.join(temporary,'src.ts'),'const answer = 1;\n');await writeFile(path.join(temporary,'asset.bin'),Buffer.from([0,1,2,3]));git(['add','.'],temporary);git(['commit','--quiet','-m','baseline'],temporary);
    const baseline=await captureTurnSourceFingerprint(temporary);expect(baseline.available).toBe(true);
    const unchanged=await captureTurnSourceFingerprint(temporary);expect(compareTurnSourceFingerprints(baseline,unchanged)).toMatchObject({status:'verified',changedPaths:[],repositoryRevisionChanged:false});
    await writeFile(path.join(temporary,'src.ts'),'const answer = 2;\n');await writeFile(path.join(temporary,'asset.bin'),Buffer.from([0,9,8,7]));
    const edited=await captureTurnSourceFingerprint(temporary);expect(compareTurnSourceFingerprints(baseline,edited)).toMatchObject({status:'verified',changedPaths:['asset.bin','src.ts'],repositoryRevisionChanged:false});
    expect(JSON.stringify(baseline)).not.toContain('const answer = 1');expect(JSON.stringify(edited)).not.toContain('const answer = 2');
    git(['add','.'],temporary);git(['commit','--quiet','-m','completed work'],temporary);
    const committed=await captureTurnSourceFingerprint(temporary);expect(compareTurnSourceFingerprints(edited,committed)).toMatchObject({status:'verified',repositoryRevisionChanged:true});
  });

  it('fails closed for a workspace without a repository snapshot instead of treating it as unchanged',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-turn-source-no-git-'));
    const snapshot=await captureTurnSourceFingerprint(temporary);
    expect(snapshot.available).toBe(false);
    expect(compareTurnSourceFingerprints(snapshot,snapshot)).toMatchObject({status:'unavailable',reason:'This workspace is not inside a Git repository.'});
  });

  it.runIf(canRunGit)('audits the complete changed-path inventory even when the UI diff preview limit is exceeded',async()=>{
    temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-turn-source-many-'));
    git(['init','--quiet'],temporary);git(['config','user.name','Pseudoharness test'],temporary);git(['config','user.email','test@example.invalid'],temporary);
    await mkdir(path.join(temporary,'src'),{recursive:true});await writeFile(path.join(temporary,'src','base.ts'),'export const base = true;\n');git(['add','.'],temporary);git(['commit','--quiet','-m','baseline'],temporary);
    await mkdir(path.join(temporary,'generated'),{recursive:true});
    for(let index=0;index<225;index++)await writeFile(path.join(temporary,'generated',`file-${index}.txt`),`value ${index}\n`);
    const baseline=await captureTurnSourceFingerprint(temporary);
    expect(baseline.available).toBe(true);
    expect(Object.keys(baseline.signatures)).toHaveLength(225);
    const unchanged=await captureTurnSourceFingerprint(temporary);
    expect(compareTurnSourceFingerprints(baseline,unchanged)).toMatchObject({status:'verified',changedPaths:[]});
    await writeFile(path.join(temporary,'generated','file-111.txt'),'changed while status stayed untracked\n');
    const changed=await captureTurnSourceFingerprint(temporary);
    expect(compareTurnSourceFingerprints(unchanged,changed)).toMatchObject({status:'verified',changedPaths:['generated/file-111.txt']});
  });
});
