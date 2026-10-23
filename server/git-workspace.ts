import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export type GitCommandResult={code:number|null;stdout:string;stderr:string};
export type GitWorkspaceCommand=(executable:'git'|'gh',args:string[],cwd:string,maxStdoutBytes?:number)=>Promise<GitCommandResult>;
export type GitWorkspaceCommit={hash:string;parents:string[];author:string;date:string;subject:string;refs:string[]};
export type GitWorkspaceBranch={name:string;hash:string;upstream?:string;current:boolean;remote:boolean};
export type GitWorkspaceWorktree={path:string;head?:string;branch?:string;detached:boolean;locked:boolean;prunable:boolean};

const run:GitWorkspaceCommand=(executable,args,cwd,maxStdoutBytes=4_000_000)=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',settled=false;
  const finish=(result:GitCommandResult)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',value=>{if(stdout.length<maxStdoutBytes)stdout+=String(value).slice(0,maxStdoutBytes-stdout.length);else child.kill();});
  child.stderr.on('data',value=>{if(stderr.length<4096)stderr+=String(value).slice(0,4096-stderr.length);});
  child.on('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
  child.on('close',code=>finish({code,stdout,stderr}));
  const timer=setTimeout(()=>{child.kill();finish({code:null,stdout,stderr:'The local Git inspection timed out.'});},12_000);timer.unref?.();
});

function isWithin(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}
async function call(runner:GitWorkspaceCommand,exe:'git'|'gh',args:string[],cwd:string,maxStdoutBytes?:number){const result=await runner(exe,args,cwd,maxStdoutBytes);if(result.code!==0)throw Object.assign(new Error(result.stderr.trim().slice(0,500)||`${exe} command failed.`),{code:result.code});return result.stdout;}
export function parseBranches(output:string):GitWorkspaceBranch[]{return output.split('\n').filter(Boolean).map(row=>{const [refname,hash,upstream,head]=row.split('\t');const remote=refname.startsWith('refs/remotes/');return {name:refname.replace(/^refs\/(?:heads|remotes)\//,''),hash,...(upstream?{upstream}:{}),current:head==='*',remote};});}
export function parseWorktrees(output:string):GitWorkspaceWorktree[]{
  const entries:GitWorkspaceWorktree[]=[];
  for(const block of output.trim().split(/\r?\n\r?\n/).filter(Boolean)){
    const row:GitWorkspaceWorktree={path:'',detached:false,locked:false,prunable:false};
    for(const line of block.split(/\r?\n/)){
      if(line.startsWith('worktree '))row.path=line.slice(9);
      else if(line.startsWith('HEAD '))row.head=line.slice(5);
      else if(line.startsWith('branch refs/heads/'))row.branch=line.slice('branch refs/heads/'.length);
      else if(line==='detached')row.detached=true;
      else if(line.startsWith('locked'))row.locked=true;
      else if(line.startsWith('prunable'))row.prunable=true;
    }
    if(row.path)entries.push(row);
  }
  return entries;
}
export function parseCommits(output:string):GitWorkspaceCommit[]{
  return output.split('\n').filter(Boolean).flatMap(row=>{const [hash,parentText,author,date,subject,refText]=row.split('\x1f');if(!hash||parentText===undefined||!author||!date)return [];return [{hash,parents:parentText?parentText.split(' '):[],author:author.slice(0,100),date,subject:(subject||'').slice(0,500),refs:(refText||'').split(', ').filter(Boolean).slice(0,20)}];});
}
function parseJsonArray(output:string):any[]{const value=JSON.parse(output);return Array.isArray(value)?value:[];}
function safeAccount(output:string,stderr:string){const match=`${output}\n${stderr}`.match(/Logged in to github\.com account ([A-Za-z0-9-]+)/i);return match?.[1];}

const emptyGithub=(detail:string)=>({available:false,authenticated:false,detail});
export async function readGitHubMetadata(inputRoot:string,runner:GitWorkspaceCommand=run){
  if(typeof inputRoot!=='string'||!inputRoot.trim())return emptyGithub('GitHub inspection needs a selected local repository and GitHub CLI.');
  let root:string;try{root=await realpath(inputRoot);}catch{return emptyGithub('The selected project folder is no longer available.');}
  let repo:string;try{repo=(await call(runner,'git',['rev-parse','--show-toplevel'],root)).trim();}catch{return emptyGithub('GitHub inspection needs a selected local Git repository.');}
  const repositoryRoot=await realpath(repo);if(!isWithin(root,repositoryRoot))return emptyGithub('The Git repository is outside the selected project folder.');
  const version=await runner('gh',['--version'],repositoryRoot).catch(()=>({code:127,stdout:'',stderr:''}));
  if(version.code!==0)return {available:false,authenticated:false,detail:'GitHub CLI (gh) is not installed or is unavailable on PATH. Local Git data is available independently.'};
  const auth=await runner('gh',['auth','status','--hostname','github.com'],repositoryRoot).catch(()=>({code:127,stdout:'',stderr:''}));
  if(auth.code!==0)return {available:true,authenticated:false,detail:'No authenticated GitHub connection is available. Check network access and run gh auth login if needed. Local Git data is available independently.'};
  const account=safeAccount(auth.stdout,auth.stderr);
  const [repoInfo,prs,issues]=await Promise.all([
    runner('gh',['repo','view','--json','nameWithOwner,url,description,defaultBranchRef'],repositoryRoot).catch(()=>({code:1,stdout:'',stderr:''})),
    runner('gh',['pr','list','--limit','20','--json','number,title,url,state,isDraft,headRefName,baseRefName,author,updatedAt'],repositoryRoot).catch(()=>({code:1,stdout:'',stderr:''})),
    runner('gh',['issue','list','--limit','20','--json','number,title,url,state,labels,updatedAt'],repositoryRoot).catch(()=>({code:1,stdout:'',stderr:''})),
  ]);
  const result:Record<string,unknown>={available:true,authenticated:true,...(account?{account}:{})};
  if(repoInfo.code===0)try{const value=JSON.parse(repoInfo.stdout);if(typeof value?.nameWithOwner==='string'&&typeof value?.url==='string')Object.assign(result,{repositoryAvailable:true,repository:{name:value.nameWithOwner,url:value.url,description:typeof value.description==='string'?value.description.slice(0,500):'',defaultBranch:typeof value.defaultBranchRef?.name==='string'?value.defaultBranchRef.name:'main'}});}catch{}
  const cleanItems=(response:GitCommandResult,kind:'pullRequests'|'issues')=>{if(response.code!==0)return undefined;try{return parseJsonArray(response.stdout).slice(0,20).map(item=>kind==='pullRequests'?({number:Number(item.number),title:String(item.title||'').slice(0,240),url:String(item.url||''),state:String(item.state||''),isDraft:item.isDraft===true,headBranch:String(item.headRefName||'').slice(0,180),baseBranch:String(item.baseRefName||'').slice(0,180),author:String(item.author?.login||'').slice(0,100),updatedAt:String(item.updatedAt||'')}):({number:Number(item.number),title:String(item.title||'').slice(0,240),url:String(item.url||''),state:String(item.state||''),labels:Array.isArray(item.labels)?item.labels.slice(0,10).map((label:any)=>String(label.name||'').slice(0,60)):[],updatedAt:String(item.updatedAt||'')}));}catch{return undefined;}};
  const pullRequests=cleanItems(prs,'pullRequests'),issueList=cleanItems(issues,'issues');Object.assign(result,{pullRequestsAvailable:prs.code===0,issuesAvailable:issues.code===0});if(pullRequests)Object.assign(result,{pullRequests});if(issueList)Object.assign(result,{issues:issueList});
  Object.assign(result,{detail:'GitHub metadata read with the local GitHub CLI credential store. Credentials and browser cookies are not returned by this endpoint.'});return result;
}

export async function readGitWorkspace(inputRoot:string,offset=0,runner:GitWorkspaceCommand=run,branchOffset=0){
  if(!Number.isInteger(offset)||offset<0||offset>9_999)throw new Error('History position must be between 0 and 9999.');
  if(!Number.isInteger(branchOffset)||branchOffset<0||branchOffset>99_999)throw new Error('Branch position must be between 0 and 99999.');
  if(typeof inputRoot!=='string'||!inputRoot.trim())return {available:false,authorizedRoot:'',detail:'Choose a project folder in Settings to inspect local Git data.',branches:[],worktrees:[],commits:[],history:{offset,pageSize:100,hasMore:false,nextOffset:null},github:{available:false,authenticated:false,detail:'GitHub inspection needs a selected local repository and GitHub CLI.'}};
  let authorizedRoot:string;try{authorizedRoot=await realpath(inputRoot);}catch{throw new Error('The selected project folder is no longer available.');}
  let repo:string;
  try{repo=(await call(runner,'git',['rev-parse','--show-toplevel'],authorizedRoot)).trim();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {available:false,authorizedRoot,detail:'Git is not installed or is unavailable on PATH.',branches:[],worktrees:[],commits:[],history:{offset,pageSize:100,hasMore:false,nextOffset:null},github:{available:false,authenticated:false,detail:'GitHub inspection needs Git and GitHub CLI.'}};return {available:false,authorizedRoot,detail:'Choose a folder inside a Git repository to see local branches and history.',branches:[],worktrees:[],commits:[],history:{offset,pageSize:100,hasMore:false,nextOffset:null},github:{available:false,authenticated:false,detail:'GitHub repository details are unavailable without a local Git repository.'}};}
  let repositoryRoot:string;try{repositoryRoot=await realpath(repo);}catch{throw new Error('Git returned a repository folder that is no longer available.');}
  if(!isWithin(authorizedRoot,repositoryRoot))return {available:false,authorizedRoot,repositoryRoot,detail:'The Git repository is outside the selected project folder.',branches:[],worktrees:[],commits:[],history:{offset,pageSize:100,hasMore:false,nextOffset:null},github:{available:false,authenticated:false,detail:'The Git repository is outside the selected project folder.'}};
  const [branchText,branchCountText,worktreeText,logResult,currentBranchText]=await Promise.all([
    call(runner,'git',['for-each-ref','--sort=refname',`--count=${branchOffset+101}`,'--format=%(refname)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)','refs/heads','refs/remotes'],repositoryRoot,16_000_000),
    call(runner,'git',['for-each-ref','--count=100001','--format=.','refs/heads','refs/remotes'],repositoryRoot),
    call(runner,'git',['worktree','list','--porcelain'],repositoryRoot),
    runner('git',['log','--all','--topo-order','--date-order','--max-count=101',`--skip=${offset}`,'--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D'],repositoryRoot).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')throw error;return {code:0,stdout:'',stderr:''};}),
    call(runner,'git',['symbolic-ref','--quiet','--short','HEAD'],repositoryRoot).catch(()=>''),
  ]);
  const allBranches=parseBranches(branchText);const branches=allBranches.slice(branchOffset,branchOffset+100);const observedBranchCount=(branchCountText.match(/\./g)||[]).length;const branchTotal=Math.min(observedBranchCount,100_000);const branchLimitReached=observedBranchCount>100_000&&branchOffset+branches.length>=100_000;const worktrees=parseWorktrees(worktreeText);
  const rawCommits=parseCommits(logResult.stdout);const hasMore=rawCommits.length>100&&offset+100<10_000;const commits=rawCommits.slice(0,100);
  const branchHasMore=branchOffset+branches.length<branchTotal;
  return {available:true,authorizedRoot,repositoryRoot,currentBranch:currentBranchText.trim()||undefined,branches,branchPage:{offset:branchOffset,pageSize:100,totalCount:branchTotal,totalIsExact:observedBranchCount<=100_000,hasMore:branchHasMore,nextOffset:branchHasMore?branchOffset+branches.length:null,limitReached:branchLimitReached},worktrees,commits,history:{offset,pageSize:100,hasMore,nextOffset:hasMore?offset+100:null,limitReached:offset+100>=10_000&&rawCommits.length>100}};
}
