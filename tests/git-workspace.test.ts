import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBranches, parseCommits, parseWorktrees, readGitWorkspace, type GitWorkspaceCommand } from '../server/git-workspace.js';

let temporary:string|undefined;
afterEach(async()=>{if(temporary){await rm(temporary,{recursive:true,force:true});temporary=undefined;}});
function git(args:string[],cwd:string){execFileSync('git',args,{cwd,stdio:'ignore',windowsHide:true});}
async function repository(){temporary=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-git-workspace-'));git(['init','--quiet','-b','main'],temporary);git(['config','user.name','Test Author'],temporary);git(['config','user.email','test@example.invalid'],temporary);return temporary;}

describe('local Git and GitHub workspace',()=>{
  it('parses Git worktree and commit records without losing branch metadata',()=>{
    expect(parseBranches('refs/heads/main\tabc\t\t*\nrefs/remotes/upstream/main\tdef\t\t')).toEqual([{name:'main',hash:'abc',current:true,remote:false},{name:'upstream/main',hash:'def',current:false,remote:true}]);
    expect(parseWorktrees('worktree C:/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree C:/repo-two\nHEAD def456\ndetached\nlocked reason\n')).toEqual([{path:'C:/repo',head:'abc123',branch:'main',detached:false,locked:false,prunable:false},{path:'C:/repo-two',head:'def456',detached:true,locked:true,prunable:false}]);
    const commits=parseCommits(`abc\x1fdef ghi\x1fA\x1f2026-10-01T00:00:00Z\x1fmerge\x1fHEAD -> main, origin/main\n`);
    expect(commits[0]).toMatchObject({hash:'abc',parents:['def','ghi'],subject:'merge',refs:['HEAD -> main','origin/main']});
  });

  it('reads real branches, linked worktrees, commit relationships and bounded history pages',async()=>{
    const root=await repository();
    await writeFile(path.join(root,'one.txt'),'one');git(['add','one.txt'],root);git(['commit','--quiet','-m','initial'],root);
    const branchHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim();
    git(['branch','feature'],root);git(['checkout','--quiet','feature'],root);await writeFile(path.join(root,'two.txt'),'two');git(['add','two.txt'],root);git(['commit','--quiet','-m','feature commit'],root);
    git(['checkout','--quiet','main'],root);git(['worktree','add','--quiet',path.join(root,'linked'),'feature'],root);
    const parent=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim();let stream='';
    for(let i=0;i<100;i++){const mark=i+1;const message=`commit ${String(i).padStart(3,'0')}`;stream+=`commit refs/heads/main\nmark :${mark}\ncommitter Test Author <test@example.invalid> ${1_800_000_000+i} +0000\ndata ${Buffer.byteLength(message)}\n${message}\nfrom ${i?`:${mark-1}`:parent}\nM 100644 inline count.txt\ndata ${String(i).length}\n${i}\n\n`;}
    try{execFileSync('git',['fast-import'],{cwd:root,input:stream,stdio:['pipe','ignore','ignore'],windowsHide:true});}catch(error){throw new Error((error as NodeJS.ErrnoException&{stderr?:string}).stderr||String(error));}
    const first=await readGitWorkspace(root,0);const second=await readGitWorkspace(root,100);
    expect(first.available).toBe(true);expect(first.currentBranch).toBe('main');expect(first.branches).toEqual(expect.arrayContaining([expect.objectContaining({name:'main',current:true}),expect.objectContaining({name:'feature',current:false})]));
    expect(first.worktrees).toHaveLength(2);expect(first.worktrees).toEqual(expect.arrayContaining([expect.objectContaining({branch:'main'}),expect.objectContaining({branch:'feature'})]));
    expect(first.commits).toHaveLength(100);expect(first.history).toMatchObject({offset:0,pageSize:100,hasMore:true,nextOffset:100});expect(second.commits).toHaveLength(2);expect(second.history.hasMore).toBe(false);
    expect(first.commits.some(commit=>commit.parents.includes(branchHead))).toBe(true);expect(first.commits[0].subject).toContain('commit');
  });

  it('bounds pagination and refuses to expose repository roots above the selected folder',async()=>{
    const root=await repository();const nested=path.join(root,'nested');await mkdir(nested);
    const outside=await readGitWorkspace(nested);expect(outside).toMatchObject({available:false,detail:'The Git repository is outside the selected project folder.',branches:[],commits:[]});
    await expect(readGitWorkspace(root,-1)).rejects.toThrow(/between 0 and 10000/);
    await expect(readGitWorkspace(root,10001)).rejects.toThrow(/between 0 and 10000/);
  });

  it('loads bounded branch pages while keeping the current branch visible on later pages',async()=>{
    const root=await repository();await writeFile(path.join(root,'main.txt'),'main');git(['add','main.txt'],root);git(['commit','--quiet','-m','fixture'],root);
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim();
    const refs=Array.from({length:105},(_,i)=>`update refs/heads/branch-${String(i).padStart(3,'0')} ${head}\n`).join('');execFileSync('git',['update-ref','--stdin'],{cwd:root,input:refs,stdio:['pipe','ignore','ignore'],windowsHide:true});
    const first=await readGitWorkspace(root);const later=await readGitWorkspace(root,0,undefined,100);
    expect(first.branches).toHaveLength(100);expect(first.branchPage).toMatchObject({offset:0,totalCount:106,hasMore:true,nextOffset:100});
    expect(later.branches).toHaveLength(6);expect(later.branchPage).toMatchObject({offset:100,totalCount:106,hasMore:false,nextOffset:null});expect(later.currentBranch).toBe('main');
  },30_000);

  it('handles missing gh and authenticated metadata without returning credential strings or issue bodies',async()=>{
    const root=await repository();await writeFile(path.join(root,'repo.txt'),'repo');git(['add','repo.txt'],root);git(['commit','--quiet','-m','fixture'],root);
    const missingGh:GitWorkspaceCommand=async(executable,args,cwd)=>executable==='gh'?{code:127,stdout:'',stderr:''}:{code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};
    const noGh=await readGitWorkspace(root,0,missingGh);expect(noGh.available).toBe(true);expect(noGh.github).toMatchObject({available:false,authenticated:false});expect(JSON.stringify(noGh)).not.toMatch(/token|password|cookie/i);
    const noAuth:GitWorkspaceCommand=async(executable,args,cwd)=>executable==='git'?{code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''}:args[0]==='--version'?{code:0,stdout:'gh version 2',stderr:''}:{code:1,stdout:'',stderr:'not logged in; ghp_DUMMYSECRET123456'};
    const unauthenticated=await readGitWorkspace(root,0,noAuth);expect(unauthenticated.github).toMatchObject({available:true,authenticated:false});expect(JSON.stringify(unauthenticated)).not.toContain('DUMMYSECRET');
    const authenticated:GitWorkspaceCommand=async(executable,args,cwd)=>{
      if(executable==='git')return {code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};
      if(args[0]==='auth')return {code:0,stdout:'',stderr:'Logged in to github.com account test-user with token ghp_SUPERSECRET123456'};
      if(args[0]==='--version')return {code:0,stdout:'gh version 2',stderr:''};
      if(args[0]==='repo')return {code:0,stdout:JSON.stringify({nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',description:'fixture',defaultBranchRef:{name:'main'}}),stderr:''};
      if(args[0]==='pr')return {code:0,stdout:JSON.stringify([{number:3,title:'Fixture PR',url:'https://github.com/owner/repo/pull/3',state:'OPEN',isDraft:false,headRefName:'feature',baseRefName:'main',author:{login:'dev'},updatedAt:'2026-10-24T00:00:00Z',body:'must not leak'}]),stderr:''};
      if(args[0]==='issue')return {code:0,stdout:JSON.stringify([{number:4,title:'Fixture issue',url:'https://github.com/owner/repo/issues/4',state:'OPEN',labels:[{name:'bug'}],updatedAt:'2026-10-24T00:00:00Z',body:'private issue body'}]),stderr:''};
      return {code:1,stdout:'',stderr:''};
    };
    const result=await readGitWorkspace(root,0,authenticated);const serialized=JSON.stringify(result);
    expect(result.github).toMatchObject({available:true,authenticated:true,account:'test-user',repository:{name:'owner/repo'},pullRequests:[{number:3,title:'Fixture PR'}],issues:[{number:4,title:'Fixture issue',labels:['bug']} ]});
    expect(serialized).not.toContain('ghp_SUPERSECRET');expect(serialized).not.toContain('private issue body');expect(serialized).not.toContain('must not leak');
  });
});
