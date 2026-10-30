import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBranches, parseCommits, parseWorktrees, readGitHubMetadata, readGitWorkspace, type GitWorkspaceCommand } from '../server/git-workspace.js';
import { layoutCommitGraph } from '../src/ui/git-graph.js';

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

  it('returns a real merge fixture with both parent edges and branch labels',async()=>{
    const root=await repository();await writeFile(path.join(root,'base.txt'),'base');git(['add','base.txt'],root);git(['commit','--quiet','-m','base commit'],root);
    git(['branch','feature'],root);git(['checkout','--quiet','feature'],root);await writeFile(path.join(root,'feature.txt'),'feature');git(['add','feature.txt'],root);git(['commit','--quiet','-m','feature divergence'],root);
    git(['checkout','--quiet','main'],root);await writeFile(path.join(root,'main.txt'),'main');git(['add','main.txt'],root);git(['commit','--quiet','-m','main divergence'],root);git(['merge','--quiet','--no-ff','feature','-m','merge feature'],root);
    const result=await readGitWorkspace(root);const merge=result.commits.find(commit=>commit.subject==='merge feature');expect(merge?.parents).toHaveLength(2);expect(merge?.refs).toContain('HEAD -> main');expect(result.commits.find(commit=>commit.subject==='feature divergence')?.refs).toContain('feature');
    const graph=layoutCommitGraph(result.commits);const row=result.commits.findIndex(commit=>commit.hash===merge?.hash);const mergeEdges=graph.edges.filter(edge=>edge.row===row);expect(mergeEdges).toHaveLength(2);expect(new Set(mergeEdges.map(edge=>edge.parentHash))).toEqual(new Set(merge?.parents));expect(new Set(mergeEdges.map(edge=>edge.toLane)).size).toBe(2);
  });

  it('bounds pagination and shows an existing parent repository for the selected folder',async()=>{
    const root=await repository();const nested=path.join(root,'nested');await mkdir(nested);
    const parentRepository=await readGitWorkspace(nested);expect(parentRepository).toMatchObject({available:true,authorizedRoot:nested,repositoryRoot:root});
    await expect(readGitWorkspace(root,-1)).rejects.toThrow(/between 0 and 9999/);
    await expect(readGitWorkspace(root,10000)).rejects.toThrow(/between 0 and 9999/);
  });

  it('marks the 10,000 commit safety cap and never offers an impossible next page',async()=>{
    const root=await repository();let logArgs:string[]=[];
    const runner:GitWorkspaceCommand=async(_executable,args,cwd)=>{
      if(args[0]==='log'){logArgs=args;const rows=Array.from({length:101},(_,index)=>`hash-${index}\x1fparent-${index}\x1fAuthor\x1f2026-10-24T00:00:00Z\x1fcommit ${index}\x1f`);return {code:0,stdout:rows.join('\n'),stderr:''};}
      try{return {code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};}catch(error){const e=error as NodeJS.ErrnoException&{status?:number;stderr?:Buffer};return {code:e.status??128,stdout:'',stderr:e.stderr?.toString()||''};}
    };
    const result=await readGitWorkspace(root,9_900,runner);
    expect(logArgs).toContain('--max-count=101');expect(logArgs).toContain('--skip=9900');
    expect(result.commits).toHaveLength(100);expect(result.history).toMatchObject({offset:9_900,hasMore:false,nextOffset:null,limitReached:true});
  });

  it('loads bounded branch pages while keeping the current branch visible on later pages',async()=>{
    const root=await repository();await writeFile(path.join(root,'main.txt'),'main');git(['add','main.txt'],root);git(['commit','--quiet','-m','fixture'],root);
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim();
    const refs=Array.from({length:205},(_,i)=>`update refs/heads/branch-${String(i).padStart(3,'0')} ${head}\n`).join('');execFileSync('git',['update-ref','--stdin'],{cwd:root,input:refs,stdio:['pipe','ignore','ignore'],windowsHide:true});
    const branchCalls:{args:string[];maxOutput?:number}[]=[];const runner:GitWorkspaceCommand=async(executable,args,cwd,maxOutput)=>{if(executable==='git'&&args[0]==='for-each-ref')branchCalls.push({args,maxOutput});return {code:0,stdout:execFileSync(executable,args,{cwd}).toString(),stderr:''};};
    const first=await readGitWorkspace(root,0,runner);const later=await readGitWorkspace(root,0,runner,100);
    expect(first.branches).toHaveLength(100);expect(first.branchPage).toMatchObject({offset:0,totalCount:206,hasMore:true,nextOffset:100});
    expect(later.branches).toHaveLength(100);expect(later.branchPage).toMatchObject({offset:100,totalCount:206,hasMore:true,nextOffset:200});expect(later.currentBranch).toBe('main');
    expect(branchCalls.some(call=>call.args.includes('--count=101')&&call.maxOutput===16_000_000)).toBe(true);expect(branchCalls.some(call=>call.args.includes('--count=100001')&&call.args.includes('--format=.'))).toBe(true);
  },30_000);

  it('keeps local history available without calling gh and tolerates an empty repository',async()=>{
    const root=await repository();let ghCalls=0;const runner:GitWorkspaceCommand=async(executable,args,cwd)=>{if(executable==='gh'){ghCalls++;throw new Error('must stay off the local Git path');}try{return {code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};}catch(error){const e=error as NodeJS.ErrnoException&{status?:number;stderr?:Buffer};return {code:e.status??128,stdout:'',stderr:e.stderr?.toString()||''};}};
    const result=await readGitWorkspace(root,0,runner);expect(result.available).toBe(true);expect(result.commits).toEqual([]);expect(result.history).toMatchObject({hasMore:false,nextOffset:null});expect(ghCalls).toBe(0);
  });

  it('handles missing gh and authenticated metadata without returning credential strings or issue bodies',async()=>{
    const root=await repository();await writeFile(path.join(root,'repo.txt'),'repo');git(['add','repo.txt'],root);git(['commit','--quiet','-m','fixture'],root);
    const missingGh:GitWorkspaceCommand=async(executable,args,cwd)=>executable==='gh'?{code:127,stdout:'',stderr:''}:{code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};
    const noGh=await readGitHubMetadata(root,missingGh);expect(noGh).toMatchObject({available:false,authenticated:false});expect(JSON.stringify(noGh)).not.toMatch(/token|password|cookie/i);
    const noAuth:GitWorkspaceCommand=async(executable,args,cwd)=>executable==='git'?{code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''}:args[0]==='--version'?{code:0,stdout:'gh version 2',stderr:''}:{code:1,stdout:'',stderr:'not logged in; ghp_DUMMYSECRET123456'};
    const unauthenticated=await readGitHubMetadata(root,noAuth);expect(unauthenticated).toMatchObject({available:true,authenticated:false});expect(JSON.stringify(unauthenticated)).not.toContain('DUMMYSECRET');
    const authenticated:GitWorkspaceCommand=async(executable,args,cwd)=>{
      if(executable==='git')return {code:0,stdout:execFileSync('git',args,{cwd}).toString(),stderr:''};
      if(args[0]==='--version')return {code:0,stdout:'gh version 2',stderr:''};
      if(args[0]==='auth')return {code:0,stdout:'',stderr:'Logged in to github.com account test-user with token ghp_SUPERSECRET123456'};
      if(args[0]==='repo')return {code:0,stdout:JSON.stringify({nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',description:'fixture',defaultBranchRef:{name:'main'}}),stderr:''};
      if(args[0]==='pr')return {code:0,stdout:JSON.stringify([{number:3,title:'Fixture PR',url:'https://github.com/owner/repo/pull/3',state:'OPEN',isDraft:false,headRefName:'feature',baseRefName:'main',author:{login:'dev'},updatedAt:'2026-10-24T00:00:00Z',body:'must not leak'}]),stderr:''};
      if(args[0]==='issue')return {code:0,stdout:JSON.stringify([{number:4,title:'Fixture issue',url:'https://github.com/owner/repo/issues/4',state:'OPEN',labels:[{name:'bug'}],updatedAt:'2026-10-24T00:00:00Z',body:'private issue body'}]),stderr:''};
      return {code:1,stdout:'',stderr:''};
    };
    const result=await readGitHubMetadata(root,authenticated);const serialized=JSON.stringify(result);
    expect(result).toMatchObject({available:true,authenticated:true,account:'test-user',repository:{name:'owner/repo'},pullRequests:[{number:3,title:'Fixture PR'}],issues:[{number:4,title:'Fixture issue',labels:['bug']} ]});
    expect(serialized).not.toContain('ghp_SUPERSECRET');expect(serialized).not.toContain('private issue body');expect(serialized).not.toContain('must not leak');
  });
});
