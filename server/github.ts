import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type GitHubCommandResult={code:number|null;stdout:string;stderr:string};
export type GitHubCommandRunner=(executable:'git'|'gh',args:string[],cwd:string)=>Promise<GitHubCommandResult>;
export type GitHubWorkspace={available:boolean;authenticated:boolean;account?:string;repository?:{name:string;url:string;defaultBranch:string};branch?:string;pullRequest?:{number:number;title:string;url:string;headBranch:string;baseBranch:string;state:string;isDraft:boolean;reviewDecision?:string;checks?:{name:string;state:string;conclusion?:string}[]};detail?:string};

const run:GitHubCommandRunner=(executable,args,cwd)=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const finish=(result:GitHubCommandResult)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>{if(stdout.length<128_000)stdout+=String(value).slice(0,128_000-stdout.length);});child.stderr.on('data',value=>{if(stderr.length<8000)stderr+=String(value).slice(0,8000-stderr.length);});
  child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});child.on('close',code=>finish({code,stdout,stderr}));
  const timer=setTimeout(()=>{child.kill();finish({code:null,stdout,stderr:'GitHub operation timed out.'});},30_000);timer.unref?.();
});
const safeText=(s:string)=>s.replace(/(?:gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})/g,'[redacted]').replace(/(https?:\/\/)[^/@\s]+(?::[^/@\s]*)?@/gi,'$1[redacted]@').slice(0,700);
function validName(name:string){return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name)&&!name.includes('..')&&!name.startsWith('-')&&!name.endsWith('/');}
function validBranch(name:string){return validName(name)&&!name.includes('//')&&!name.includes('@{')&&!name.endsWith('.lock');}
function isGitHubRemote(remote:string){if(/^git@github\.com:[^\s]+$/i.test(remote))return true;try{const url=new URL(remote);if(url.hostname.toLowerCase()!=='github.com'||url.password)return false;if(url.protocol==='https:')return !url.username;if(url.protocol==='ssh:')return url.username==='git';return false;}catch{return false;}}
function within(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}
async function checkedRoot(root:string){const resolved=await realpath(root);if(!path.isAbsolute(resolved))throw new Error('The selected task workspace is unavailable.');return resolved;}
async function call(runner:GitHubCommandRunner,exe:'git'|'gh',args:string[],cwd:string,label:string){try{const result=await runner(exe,args,cwd);if(result.code!==0)throw new Error(safeText(result.stderr.trim())||`${label} failed.`);return result.stdout;}catch(error){if(error instanceof Error&&error.message==='The selected task workspace is unavailable.')throw error;throw new Error(`${label}: ${safeText(error instanceof Error?error.message:String(error))}`);}}

function parsePullRequest(value:any):GitHubWorkspace['pullRequest']{
  if(!value||typeof value.number!=='number'||typeof value.title!=='string'||typeof value.url!=='string')return;
  const checks=Array.isArray(value.statusCheckRollup)?value.statusCheckRollup.flatMap((check:any)=>typeof check?.name==='string'?[{name:check.name,state:String(check.status||check.state||'UNKNOWN'),...(typeof check.conclusion==='string'?{conclusion:check.conclusion}:{})}]:[]):[];
  return {number:value.number,title:value.title,url:value.url,headBranch:String(value.headRefName||''),baseBranch:String(value.baseRefName||''),state:String(value.state||''),isDraft:value.isDraft===true,...(typeof value.reviewDecision==='string'?{reviewDecision:value.reviewDecision}:{}),...(checks.length?{checks:checks.slice(0,80)}:{})};
}

export async function readGitHubWorkspace(inputRoot:string,runner:GitHubCommandRunner=run):Promise<GitHubWorkspace>{
  const root=await checkedRoot(inputRoot);
  const [branchResult,authResult]=await Promise.all([
    runner('git',['branch','--show-current'],root).catch(()=>({code:1,stdout:'',stderr:''})),
    runner('gh',['auth','status','--hostname','github.com'],root).catch(()=>({code:1,stdout:'',stderr:''})),
  ]);
  const authenticated=authResult.code===0;
  const accountText=`${authResult.stdout}\n${authResult.stderr}`;
  const account=authenticated?accountText.match(/Logged in to github\.com account ([A-Za-z0-9-]+)/i)?.[1]:undefined;
  if(!authenticated)return {available:true,authenticated:false,branch:branchResult.stdout.trim()||undefined,detail:'GitHub CLI is not authenticated. Install gh and run `gh auth login`; its credential store is separate from the embedded browser session.'};
  const repoResult=await runner('gh',['repo','view','--json','nameWithOwner,url,defaultBranchRef'],root).catch(()=>({code:1,stdout:'',stderr:''}));
  if(repoResult.code!==0)return {available:true,authenticated:true,...(account?{account}:{}),branch:branchResult.stdout.trim()||undefined,detail:`GitHub CLI is signed in, but this workspace is not linked to a readable GitHub repository. ${safeText(repoResult.stderr.trim())}`.trim()};
  let repo:any;try{repo=JSON.parse(repoResult.stdout);}catch{return {available:true,authenticated:true,...(account?{account}:{}),detail:'GitHub CLI returned an invalid repository response.'};}
  if(typeof repo?.nameWithOwner!=='string'||typeof repo?.url!=='string')return {available:true,authenticated:true,...(account?{account}:{}),detail:'GitHub CLI did not return a repository identity.'};
  let pullRequest:GitHubWorkspace['pullRequest'];
  const prResult=await runner('gh',['pr','view','--json','number,title,url,headRefName,baseRefName,state,isDraft,reviewDecision,statusCheckRollup'],root).catch(()=>({code:1,stdout:'',stderr:''}));
  if(prResult.code===0)try{pullRequest=parsePullRequest(JSON.parse(prResult.stdout));}catch{}
  return {available:true,authenticated:true,...(account?{account}:{}),repository:{name:repo.nameWithOwner,url:repo.url,defaultBranch:String(repo.defaultBranchRef?.name||'main')},branch:branchResult.stdout.trim()||undefined,...(pullRequest?{pullRequest}:{})};
}

export async function pushGitHubBranch(input:{root:string;remote:string;branch:string},runner:GitHubCommandRunner=run){
  const root=await checkedRoot(input.root);if(!validName(input.remote)||input.remote.includes('/'))throw new Error('Enter a valid Git remote name.');if(!validBranch(input.branch))throw new Error('Enter a valid local branch name.');
  const current=await call(runner,'git',['branch','--show-current'],root,'Could not read the current branch');if(current.trim()!==input.branch)throw new Error('The selected branch changed. Refresh the GitHub workspace before pushing.');
  await call(runner,'gh',['auth','status','--hostname','github.com'],root,'GitHub authentication is unavailable');
  await call(runner,'git',['push','--porcelain','--set-upstream',input.remote,input.branch],root,'Push failed');
  return {pushed:true,remote:input.remote,branch:input.branch,message:`Pushed committed changes on ${input.branch} to ${input.remote}. Uncommitted workspace changes were not included.`};
}

export async function createGitHubPullRequest(input:{root:string;branch:string;base:string;title:string;body:string},runner:GitHubCommandRunner=run){
  const root=await checkedRoot(input.root);if(!validBranch(input.branch))throw new Error('Enter a valid head branch name.');if(!validBranch(input.base))throw new Error('Enter a valid base branch name.');
  if(!input.title.trim()||input.title.length>256||input.body.length>20_000)throw new Error('Enter a PR title up to 256 characters and a description up to 20,000 characters.');
  const current=(await call(runner,'git',['branch','--show-current'],root,'Could not read the current branch')).trim();if(current!==input.branch)throw new Error('The selected branch changed. Refresh the GitHub workspace before creating a PR.');
  await call(runner,'gh',['auth','status','--hostname','github.com'],root,'GitHub authentication is unavailable');
  const repo=JSON.parse(await call(runner,'gh',['repo','view','--json','nameWithOwner'],root,'Could not resolve the GitHub repository'));
  if(typeof repo?.nameWithOwner!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(repo.nameWithOwner))throw new Error('The current repository has no safe GitHub owner/name identity.');
  const remote=await call(runner,'git',['remote','get-url','origin'],root,'GitHub remote origin is unavailable');
  if(!isGitHubRemote(remote.trim()))throw new Error('The origin remote is not a GitHub repository.');
  const remoteBranch=await runner('git',['ls-remote','--heads','origin',`refs/heads/${input.branch}`],root);
  if(remoteBranch.code!==0)throw new Error(`Could not confirm that ${input.branch} is pushed to origin.`);
  if(!remoteBranch.stdout.trim())throw new Error(`Push ${input.branch} to origin before opening a pull request.`);
  const stdout=await call(runner,'gh',['pr','create','--repo',repo.nameWithOwner,'--base',input.base,'--head',input.branch,'--title',input.title.trim(),'--body',input.body],root,'Pull request creation failed');
  const url=stdout.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/)?.[0];if(!url)throw new Error('GitHub CLI completed, but did not return a verifiable pull request URL.');
  return {created:true,url,repository:repo.nameWithOwner,branch:input.branch,base:input.base};
}

export function validateGitHubRoot(root:string,candidate:string){return within(path.resolve(root),path.resolve(candidate));}
