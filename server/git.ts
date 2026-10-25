import { spawn } from 'node:child_process';
import { lstat, realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceGitChange={path:string;status:string;kind:'tracked'|'untracked'};
export type WorkspaceGitFile=WorkspaceGitChange&{additions:number|null;deletions:number|null;binary:boolean;patch?:string;omittedReason?:string};
export type WorkspaceGitSnapshot={available:boolean;workspaceRoot:string;repositoryRoot?:string;branch?:string;headRevision?:string;capturedAt:string;changes:WorkspaceGitChange[];files:WorkspaceGitFile[];diff:string;truncated:boolean;message?:string};
export type WorkspaceGitInventory={available:boolean;workspaceRoot:string;repositoryRoot?:string;headRevision?:string;capturedAt:string;changes:WorkspaceGitChange[];message?:string};

const MAX_STATUS_BYTES=1024*1024;
const MAX_DIFF_BYTES=512*1024;
const MAX_CHANGES=200;
const MAX_UNTRACKED_FILES=80;
const MAX_UNTRACKED_FILE_BYTES=64*1024;

type GitOutput={stdout:string;stderr:string;truncated:boolean};

function runGit(args:string[],cwd:string,maxBytes:number,timeoutMs=10000):Promise<GitOutput>{
  return new Promise((resolve,reject)=>{
    const child=spawn('git',args,{cwd,windowsHide:true,shell:false,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),truncated=false,settled=false;
    const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve({stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),truncated});};
    const collect=(current:Buffer,chunk:Buffer,limit:number)=>{const room=Math.max(0,limit-current.length);if(chunk.length>room){truncated=true;child.kill();return Buffer.concat([current,chunk.subarray(0,room)]);}return Buffer.concat([current,chunk]);};
    child.stdout.on('data',(chunk:Buffer)=>{stdout=collect(stdout,chunk,maxBytes);});
    child.stderr.on('data',(chunk:Buffer)=>{stderr=collect(stderr,chunk,4096);});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(truncated){finish();return;}
      if(code!==0){const detail=stderr.toString('utf8').trim();finish(new Error(detail||`Git exited with status ${code??'unknown'}.`));return;}
      finish();
    });
    const timer=setTimeout(()=>{truncated=true;child.kill();finish(new Error('Git did not finish the read-only status request in time.'));},timeoutMs);
    timer.unref?.();
  });
}

function isWithin(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}
function hasControlCharacters(value:string){return [...value].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127);}
function parseStatus(output:string):WorkspaceGitChange[]{
  return output.split('\0').filter(Boolean).map(record=>({status:record.slice(0,2),path:record.slice(3),kind:record.slice(0,2)==='??'?'untracked':'tracked'}));
}

/** Complete, bounded status inventory for source-change auditing; unlike the UI diff it does not truncate at MAX_CHANGES. */
export async function readWorkspaceGitInventory(inputRoot:string):Promise<WorkspaceGitInventory>{
  let root:string;
  try{root=await realpath(inputRoot);}catch{return {available:false,workspaceRoot:path.resolve(inputRoot),capturedAt:new Date().toISOString(),changes:[],message:'The task workspace is no longer available.'};}
  const base={workspaceRoot:root,capturedAt:new Date().toISOString()};
  let top:string;
  try{top=(await runGit(['rev-parse','--show-toplevel'],root,8192)).stdout.trim();}
  catch(error){
    const message=error instanceof Error?error.message:'';
    if(/not a git repository/i.test(message))return {...base,available:false,changes:[],message:'This workspace is not inside a Git repository.'};
    if((error as NodeJS.ErrnoException).code==='ENOENT')return {...base,available:false,changes:[],message:'Git is not available on PATH.'};
    return {...base,available:false,changes:[],message:message||'Could not inspect the Git repository.'};
  }
  let repositoryRoot:string;
  try{repositoryRoot=await realpath(top);}catch{return {...base,available:false,changes:[],message:'Git returned a repository path that is no longer available.'};}
  if(!isWithin(root,repositoryRoot))return {...base,available:false,repositoryRoot,changes:[],message:'The Git repository root is outside this task workspace.'};
  const status=await runGit(['-c','core.quotepath=false','status','--porcelain=v1','-z','--untracked-files=all','--no-renames'],root,4*1024*1024);
  if(status.truncated)return {...base,available:false,repositoryRoot,changes:[],message:'The complete Git change inventory exceeds the audit safety limit.'};
  const changes=parseStatus(status.stdout);
  if(changes.length>10000)return {...base,available:false,repositoryRoot,changes:[],message:'The Git change inventory exceeds the audit safety limit.'};
  if(changes.some(change=>!change.path||hasControlCharacters(change.path)))return {...base,available:false,repositoryRoot,changes:[],message:'A changed path cannot be represented safely in the audit.'};
  const head=await runGit(['rev-parse','--verify','HEAD'],root,8192).catch(()=>null);
  return {...base,available:true,repositoryRoot,changes,...(head?.stdout.trim()?{headRevision:head.stdout.trim()}:{}),...(changes.length?{}:{message:'The working tree is clean.'})};
}
function addedFilePatch(name:string,content:string){
  const pathHeader=[...name.replaceAll('\\','/')].map(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127?'?':character).join('');
  const lines=content.split(/\r\n|\n|\r/);if(lines.at(-1)==='')lines.pop();
  return {patch:`diff --git a/${pathHeader} b/${pathHeader}\nnew file mode 100644\n--- /dev/null\n+++ b/${pathHeader}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line=>`+${line}`).join('\n')}${lines.length?'\n':''}`,additions:lines.length};
}

async function untrackedPatches(root:string,changes:WorkspaceGitChange[],remainingBytes:number){
  const files:WorkspaceGitFile[]=[];let bytes=0,truncated=false,count=0;
  for(const change of changes){
    if(change.kind!=='untracked')continue;
    const file:WorkspaceGitFile={...change,additions:null,deletions:null,binary:false};files.push(file);
    count++;if(count>MAX_UNTRACKED_FILES){truncated=true;file.omittedReason='The untracked-file preview limit was reached.';continue;}
    if(hasControlCharacters(change.path)){truncated=true;file.omittedReason='This filename contains control characters and cannot be shown safely.';continue;}
    try{
      const candidate=path.resolve(root,change.path);if(!isWithin(root,candidate)){truncated=true;file.omittedReason='This path resolves outside the workspace.';continue;}
      const metadata=await lstat(candidate);if(!metadata.isFile()||metadata.isSymbolicLink()){truncated=true;file.omittedReason='Symlinks and non-regular files are not previewed.';continue;}if(metadata.size>MAX_UNTRACKED_FILE_BYTES){truncated=true;file.omittedReason='This file exceeds the 64 KB preview limit.';continue;}
      const resolved=await realpath(candidate);if(!isWithin(root,resolved)){truncated=true;file.omittedReason='This path resolves outside the workspace.';continue;}
      const data=await readFile(resolved);if(data.includes(0)){truncated=true;file.binary=true;file.omittedReason='Binary file content is not rendered.';continue;}
      const content=new TextDecoder('utf-8',{fatal:true}).decode(data);const addition=addedFilePatch(change.path,content);
      const size=Buffer.byteLength(addition.patch);if(size>remainingBytes-bytes){truncated=true;file.omittedReason='The overall diff size limit was reached.';continue;}file.patch=addition.patch;file.additions=addition.additions;file.deletions=0;bytes+=size;
    }catch(error){truncated=true;file.omittedReason=error instanceof TypeError?'This file is not valid UTF-8 text.':'The file could not be read safely.';}
  }
  return {files,bytes,truncated};
}

function readGitPathToken(value:string,start:number):{value:string;next:number}|null{
  if(value[start]!=='"'){const next=value.indexOf(' ',start);return next<0?{value:value.slice(start),next:value.length}:{value:value.slice(start,next),next};}
  const bytes:number[]=[];let index=start+1;
  while(index<value.length){const character=value[index++];if(character==='"')return {value:new TextDecoder().decode(new Uint8Array(bytes)),next:index};if(character==='\\'){
      const escaped=value[index++];const simple:Record<string,number>={t:9,n:10,r:13,b:8,f:12,v:11,'\\':92,'"':34};if(escaped in simple){bytes.push(simple[escaped]);continue;}
      if(/[0-7]/.test(escaped||'')){let octal=escaped;for(let count=0;count<2&&/[0-7]/.test(value[index]||'');count++)octal+=value[index++];bytes.push(parseInt(octal,8));continue;}
      return null;
    }
    bytes.push(...new TextEncoder().encode(character));
  }
  return null;
}
function pathFromGitHeader(header:string,changes:WorkspaceGitChange[]):string|undefined{
  const body=header.slice('diff --git '.length);
  for(const change of changes){const expected=`a/${change.path} b/${change.path}`;if(body===expected)return change.path;}
  if(body.startsWith('"')){const first=readGitPathToken(body,0);if(!first||!body.startsWith(' ',first.next))return;const second=readGitPathToken(body,first.next+1);if(!second||second.next!==body.length)return;const from=first.value,to=second.value;if(from.startsWith('a/')&&to.startsWith('b/')&&from.slice(2)===to.slice(2))return from.slice(2);}
  return undefined;
}
function splitTrackedPatches(diff:string,changes:WorkspaceGitChange[]){
  const starts=[...diff.matchAll(/^diff --git /gm)].map(match=>match.index!);const patches=new Map<string,string>();let unmatched=false;
  starts.forEach((start,index)=>{const end=starts[index+1]??diff.length;const patch=diff.slice(start,end);const header=patch.slice(0,patch.indexOf('\n'));const name=pathFromGitHeader(header,changes);if(name)patches.set(name,patch);else unmatched=true;});return {patches,unmatched};
}
function parseNumstat(output:string){
  const rows=new Map<string,{additions:number|null;deletions:number|null;binary:boolean}>();
  for(const record of output.split('\0').filter(Boolean)){const first=record.indexOf('\t'),second=record.indexOf('\t',first+1);if(first<0||second<0)continue;const add=record.slice(0,first),del=record.slice(first+1,second),name=record.slice(second+1);rows.set(name,{additions:add==='-'?null:Number(add),deletions:del==='-'?null:Number(del),binary:add==='-'||del==='-'});}
  return rows;
}

export async function readWorkspaceGitSnapshot(inputRoot:string):Promise<WorkspaceGitSnapshot>{
  let root:string;
  try{root=await realpath(inputRoot);}catch{throw new Error('The task workspace is no longer available.');}
  const base={workspaceRoot:root,capturedAt:new Date().toISOString()};
  let top:string;
  try{top=(await runGit(['rev-parse','--show-toplevel'],root,8192)).stdout.trim();}
  catch(error){
    const message=error instanceof Error?error.message:'';
    if(/not a git repository/i.test(message))return {available:false,...base,changes:[],files:[],diff:'',truncated:false,message:'This workspace is not inside a Git repository.'};
    if((error as NodeJS.ErrnoException).code==='ENOENT')return {available:false,...base,changes:[],files:[],diff:'',truncated:false,message:'Git is not available on PATH.'};
    throw new Error(message||'Could not inspect the Git repository.');
  }
  let repositoryRoot:string;
  try{repositoryRoot=await realpath(top);}catch{throw new Error('Git returned a repository path that is no longer available.');}
  if(!isWithin(root,repositoryRoot))return {available:false,...base,repositoryRoot,changes:[],files:[],diff:'',truncated:false,message:'The Git repository root is outside this task workspace; showing it could expose files outside the selected project.'};
  const status=await runGit(['-c','core.quotepath=false','status','--porcelain=v1','-z','--untracked-files=all','--no-renames'],root,MAX_STATUS_BYTES);
  const allChanges=parseStatus(status.stdout);
  const changes=allChanges.slice(0,MAX_CHANGES);
  let diff='';let truncated=status.truncated||allChanges.length>MAX_CHANGES;const files:WorkspaceGitFile[]=changes.map(change=>({...change,additions:null,deletions:null,binary:false}));
  const head=await runGit(['rev-parse','--verify','HEAD'],root,8192).catch(()=>null);
  if(head){
    const [tracked,numstat]=await Promise.all([
      runGit(['-c','core.quotepath=false','diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--unified=3','HEAD','--'],root,MAX_DIFF_BYTES),
      runGit(['-c','core.quotepath=false','diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--numstat','-z','HEAD','--'],root,MAX_STATUS_BYTES),
    ]);
    diff=tracked.stdout;truncated ||= tracked.truncated||numstat.truncated;
    const stats=parseNumstat(numstat.stdout),parsed=splitTrackedPatches(diff,files);truncated ||= parsed.unmatched;
    for(const file of files){const stat=stats.get(file.path);const patch=parsed.patches.get(file.path);if(stat){Object.assign(file,stat);}if(patch)Object.assign(file,{patch});else if(file.kind==='tracked')file.omittedReason='No textual patch is available for this change.';}
  }else{
    for(const file of files)if(file.kind==='tracked')file.omittedReason='This repository has no committed HEAD to compare against.';
  }
  const untracked=await untrackedPatches(root,files,Math.max(0,MAX_DIFF_BYTES-Buffer.byteLength(diff)));
  for(const file of untracked.files){const index=files.findIndex(change=>change.path===file.path&&change.kind==='untracked');if(index>=0)Object.assign(files[index],file);}
  diff+=untracked.files.map(file=>file.patch||'').join('');truncated ||= untracked.truncated||Buffer.byteLength(diff)>=MAX_DIFF_BYTES;
  const branch=await runGit(['branch','--show-current'],root,4096).catch(()=>({stdout:'',stderr:'',truncated:false}));
  return {available:true,...base,repositoryRoot,branch:branch.stdout.trim()||undefined,headRevision:head?.stdout.trim()||undefined,changes,files,diff,truncated,message:allChanges.length?'':'The working tree is clean.'};
}
