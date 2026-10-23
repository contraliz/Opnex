import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGitHubPullRequest, pushGitHubBranch, readGitHubWorkspace, type GitHubCommandRunner } from '../server/github.js';

let root='';
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root='';});
async function workspace(){root=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-github-'));return root;}

describe('task-bound GitHub workflows',()=>{
  it('reports auth and PR status without returning raw CLI output',async()=>{
    await workspace();const runner:GitHubCommandRunner=vi.fn(async(executable,args)=>{
      if(executable==='git'&&args[0]==='branch')return {code:0,stdout:'feature/demo\n',stderr:''};
      if(executable==='gh'&&args[0]==='auth')return {code:0,stdout:'',stderr:'Logged in to github.com account demo-user (keyring)\nToken: ghp_supersecret1234567890'};
      if(executable==='gh'&&args[0]==='repo')return {code:0,stdout:JSON.stringify({nameWithOwner:'owner/repo',url:'https://github.com/owner/repo',defaultBranchRef:{name:'main'}}),stderr:''};
      if(executable==='gh'&&args[0]==='pr')return {code:0,stdout:JSON.stringify({number:8,title:'Ship it',url:'https://github.com/owner/repo/pull/8',headRefName:'feature/demo',baseRefName:'main',state:'OPEN',isDraft:false,reviewDecision:'REVIEW_REQUIRED',statusCheckRollup:[{name:'unit',status:'COMPLETED',conclusion:'SUCCESS'}]}),stderr:''};
      throw new Error(`Unexpected command ${args.join(' ')}`);
    });
    const result=await readGitHubWorkspace(root,runner);expect(result).toMatchObject({authenticated:true,account:'demo-user',repository:{name:'owner/repo',defaultBranch:'main'},branch:'feature/demo',pullRequest:{number:8,reviewDecision:'REVIEW_REQUIRED',checks:[{name:'unit',state:'COMPLETED',conclusion:'SUCCESS'}]}});
    expect(JSON.stringify(result)).not.toContain('ghp_supersecret');
  });

  it('requires an authenticated CLI and unchanged branch before pushing',async()=>{
    await workspace();const runner:GitHubCommandRunner=vi.fn(async(executable,args)=>{
      if(executable==='git'&&args[0]==='branch')return {code:0,stdout:'main\n',stderr:''};
      if(executable==='gh')return {code:0,stdout:'',stderr:''};
      if(executable==='git'&&args[0]==='push')return {code:0,stdout:'To github.com:owner/repo.git\n',stderr:''};
      throw new Error('Unexpected command.');
    });
    await expect(pushGitHubBranch({root,remote:'origin',branch:'feature/other'},runner)).rejects.toThrow('branch changed');
    expect(runner).not.toHaveBeenCalledWith('git',['push','--porcelain','--set-upstream','origin','feature/other'],root);
    const result=await pushGitHubBranch({root,remote:'origin',branch:'main'},runner);expect(result).toMatchObject({pushed:true,branch:'main'});
    expect(runner).toHaveBeenCalledWith('git',['push','--porcelain','--set-upstream','origin','main'],root);
  });

  it('refuses PR creation until the selected branch exists on origin and then uses explicit fields',async()=>{
    await workspace();let remotePublished=false;const runner:GitHubCommandRunner=vi.fn(async(executable,args)=>{
      if(executable==='git'&&args[0]==='branch')return {code:0,stdout:'feature/demo\n',stderr:''};
      if(executable==='gh'&&args[0]==='auth')return {code:0,stdout:'',stderr:''};
      if(executable==='gh'&&args[0]==='repo')return {code:0,stdout:'{"nameWithOwner":"owner/repo"}',stderr:''};
      if(executable==='git'&&args[0]==='remote')return {code:0,stdout:'https://github.com/owner/repo.git\n',stderr:''};
      if(executable==='git'&&args[0]==='ls-remote')return {code:0,stdout:remotePublished?'0123 refs/heads/feature/demo\n':'',stderr:''};
      if(executable==='gh'&&args[0]==='pr'&&args[1]==='create')return {code:0,stdout:'https://github.com/owner/repo/pull/12\n',stderr:''};
      throw new Error('Unexpected command.');
    });
    const input={root,branch:'feature/demo',base:'main',title:'Scoped task',body:'Implementation and verification.'};
    await expect(createGitHubPullRequest(input,runner)).rejects.toThrow('Push feature/demo');
    expect(runner).not.toHaveBeenCalledWith('gh',expect.arrayContaining(['pr','create']),root);
    remotePublished=true;const result=await createGitHubPullRequest(input,runner);expect(result).toMatchObject({created:true,url:'https://github.com/owner/repo/pull/12',branch:'feature/demo'});
    expect(runner).toHaveBeenCalledWith('gh',['pr','create','--repo','owner/repo','--base','main','--head','feature/demo','--title','Scoped task','--body','Implementation and verification.'],root);
  });

  it('rejects a remote whose hostname only contains the GitHub name',async()=>{
    await workspace();const runner:GitHubCommandRunner=vi.fn(async(executable,args)=>{
      if(executable==='git'&&args[0]==='branch')return {code:0,stdout:'feature/demo\n',stderr:''};
      if(executable==='gh'&&args[0]==='auth')return {code:0,stdout:'',stderr:''};
      if(executable==='gh'&&args[0]==='repo')return {code:0,stdout:'{"nameWithOwner":"owner/repo"}',stderr:''};
      if(executable==='git'&&args[0]==='remote')return {code:0,stdout:'https://github.com.attacker.example/owner/repo.git',stderr:''};
      throw new Error('Unexpected command.');
    });
    await expect(createGitHubPullRequest({root,branch:'feature/demo',base:'main',title:'Review',body:''},runner)).rejects.toThrow('not a GitHub repository');
    expect(runner).not.toHaveBeenCalledWith('git',['ls-remote','--heads','origin','refs/heads/feature/demo'],root);
  });
});
