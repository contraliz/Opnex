import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readlink } from 'node:fs/promises';
import path from 'node:path';
import { readWorkspaceGitInventory } from './git.js';

const MAX_FILE_HASH_BYTES=256*1024*1024;
const MAX_TOTAL_HASH_BYTES=1024*1024*1024;

export type TurnSourceFingerprint={
  available:boolean;
  workspaceRoot:string;
  repositoryRoot?:string;
  branch?:string;
  headRevision?:string;
  capturedAt:string;
  signatures:Record<string,string>;
  reason?:string;
};

export type TurnSourceChangeResult={
  status:'verified'|'unavailable';
  workspaceRoot:string;
  baselineCapturedAt:string;
  completedAt:string;
  changedPaths:string[];
  repositoryRevisionChanged:boolean;
  reason?:string;
};

function within(root:string,candidate:string){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));}
function hash(value:string){return createHash('sha256').update(value).digest('hex');}
async function streamHash(filePath:string,total:{bytes:number}){
  return await new Promise<string>((resolve,reject)=>{const digest=createHash('sha256');const stream=createReadStream(filePath);stream.on('data',(chunk:Buffer)=>{total.bytes+=chunk.length;if(total.bytes>MAX_TOTAL_HASH_BYTES){stream.destroy(new Error('The total workspace content hash exceeds the audit safety limit.'));return;}digest.update(chunk);});stream.on('error',reject);stream.on('end',()=>resolve(digest.digest('hex')));});
}
async function signature(filePath:string,status:string,kind:'tracked'|'untracked',workspaceRoot:string,total:{bytes:number}){
  const base={status,kind};
  if(status.includes('D'))return hash(JSON.stringify({...base,deleted:true}));
  const candidate=path.resolve(workspaceRoot,filePath);
  if(!within(workspaceRoot,candidate))throw new Error('A changed path resolves outside the selected workspace.');
  const metadata=await lstat(candidate);
  if(metadata.isSymbolicLink())return hash(JSON.stringify({...base,linkTarget:await readlink(candidate)}));
  if(metadata.isFile()){
    if(metadata.size>MAX_FILE_HASH_BYTES)throw new Error(`A changed file exceeds the ${MAX_FILE_HASH_BYTES/(1024*1024)} MB content-hash limit.`);
    const resolved=await realpath(candidate);
    if(!within(workspaceRoot,resolved))throw new Error('A changed file resolves outside the selected workspace.');
    return hash(JSON.stringify({...base,contentHash:await streamHash(resolved,total)}));
  }
  if(metadata.isDirectory())return hash(JSON.stringify({...base,directory:true}));
  throw new Error('A changed path is not a regular file, directory, or symbolic link.');
}

export async function captureTurnSourceFingerprint(workspaceRoot:string):Promise<TurnSourceFingerprint>{
  const snapshot=await readWorkspaceGitInventory(workspaceRoot);
  const base={workspaceRoot:snapshot.workspaceRoot,capturedAt:snapshot.capturedAt,signatures:{} as Record<string,string>,...(snapshot.repositoryRoot?{repositoryRoot:snapshot.repositoryRoot}:{}),...(snapshot.headRevision?{headRevision:snapshot.headRevision}:{})};
  if(!snapshot.available)return {...base,available:false,reason:snapshot.message||'The selected workspace could not be compared.'};
  try{
    const total={bytes:0};
    for(const file of snapshot.changes)base.signatures[file.path]=await signature(file.path,file.status,file.kind,snapshot.workspaceRoot,total);
    return {...base,available:true};
  }catch(error){return {...base,available:false,reason:error instanceof Error?error.message:'A safe workspace fingerprint could not be created.'};}
}

export function compareTurnSourceFingerprints(before:TurnSourceFingerprint,after:TurnSourceFingerprint):TurnSourceChangeResult{
  const completedAt=after.capturedAt;
  if(!before.available||!after.available||path.resolve(before.workspaceRoot).toLowerCase()!==path.resolve(after.workspaceRoot).toLowerCase())return {status:'unavailable',workspaceRoot:before.workspaceRoot,baselineCapturedAt:before.capturedAt,completedAt,changedPaths:[],repositoryRevisionChanged:false,reason:before.reason||after.reason||'The source snapshots do not cover the same verified workspace.'};
  const names=new Set([...Object.keys(before.signatures),...Object.keys(after.signatures)]);
  const changedPaths=[...names].filter(name=>before.signatures[name]!==after.signatures[name]).sort();
  const repositoryRevisionChanged=!!before.headRevision&&!!after.headRevision&&before.headRevision!==after.headRevision;
  if((before.headRevision||after.headRevision)&&(!before.headRevision||!after.headRevision))return {status:'unavailable',workspaceRoot:before.workspaceRoot,baselineCapturedAt:before.capturedAt,completedAt,changedPaths,repositoryRevisionChanged:false,reason:'The repository revision could not be compared across the execution turn.'};
  return {status:'verified',workspaceRoot:before.workspaceRoot,baselineCapturedAt:before.capturedAt,completedAt,changedPaths,repositoryRevisionChanged};
}
