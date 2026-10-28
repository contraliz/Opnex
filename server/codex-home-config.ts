import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, readFile, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

type CodexHomeFileOps={
  lstat:typeof lstat;
  realpath:typeof realpath;
  link:typeof link;
  symlink:typeof symlink;
  stat:typeof stat;
  readFile:typeof readFile;
  writeFile:typeof writeFile;
  rename:typeof rename;
  unlink:typeof unlink;
  randomId:()=>string;
};

const fileOps:CodexHomeFileOps={lstat,realpath,link,symlink,stat,readFile,writeFile,rename,unlink,randomId:randomUUID};
const profilePattern=/^[A-Za-z0-9_.-]+$/;
const isCode=(error:unknown,values:string[])=>!!error&&typeof error==='object'&&'code'in error&&values.includes(String((error as NodeJS.ErrnoException).code));
const samePath=(left:string,right:string)=>{
  if(process.platform!=='win32')return path.resolve(left)===path.resolve(right);
  const key=(value:string)=>{
    let resolved=path.win32.resolve(value);
    if(resolved.slice(0,8).toLowerCase()==='\\\\?\\unc\\')resolved=`\\\\${resolved.slice(8)}`;
    else if(resolved.slice(0,4)==='\\\\?\\')resolved=resolved.slice(4);
    return resolved.toLowerCase();
  };
  return key(left)===key(right);
};
const missing=async(ops:CodexHomeFileOps,filename:string,normalHome:string,agentHome:string)=>{
  const destination=path.join(agentHome,filename);
  let current:Stats|undefined;
  try{current=await ops.lstat(destination);}catch(error){if(!isCode(error,['ENOENT']))throw error;}
  if(!current)return 'missing' as const;
  if(current.isDirectory()||!current.isFile()&&!current.isSymbolicLink())throw new Error('Unexpected entry in the app-owned Codex home.');
  if(current.isSymbolicLink()){
    let target:string;
    try{target=await ops.realpath(destination);}catch{throw new Error('Unexpected symbolic link in the app-owned Codex home.');}
    let expected:string;
    try{expected=await ops.realpath(path.join(normalHome,filename));}catch{throw new Error('Unexpected symbolic link in the app-owned Codex home.');}
    if(!samePath(target,expected))throw new Error('Unexpected symbolic link in the app-owned Codex home.');
  }
  await ops.unlink(destination);
  return 'missing' as const;
};

const hasReparseDirectoryComponent=async(ops:CodexHomeFileOps,directory:string)=>{
  const parsed=path.parse(directory);
  let current=parsed.root;
  const components=directory.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for(const component of components){
    current=path.join(current,component);
    const entry=await ops.lstat(current);
    if(!entry.isDirectory()||entry.isSymbolicLink())return true;
  }
  return false;
};

async function replaceVerifiedTemp(temp:string,destination:string,agentHome:string,ops:CodexHomeFileOps){
  let existing:Stats|undefined;
  try{existing=await ops.lstat(destination);}catch(error){if(!isCode(error,['ENOENT']))throw error;}
  if(!existing){await ops.rename(temp,destination);return;}
  const backup=path.join(agentHome,`.pseudoharness-config-backup-${ops.randomId()}`);
  await ops.rename(destination,backup);
  try{await ops.rename(temp,destination);}catch(error){try{await ops.rename(backup,destination);}catch{}throw error;}
  await ops.unlink(backup);
}

/**
 * Expose only the normal Codex config and an explicitly selected profile config
 * to the app-owned instruction-filtered home. Same-volume hard links remain
 * preferred. On EXDEV, use a verified exact-file symlink where available; if
 * Windows disallows that, keep an atomically refreshed copy of only this file.
 */
export async function linkNormalCodexFile(
  normalHome:string,
  agentHome:string,
  filename:string,
  required:boolean,
  profileName?:string,
  overrides:Partial<CodexHomeFileOps>={},
):Promise<'hardlink'|'symlink'|'snapshot'|'missing'>{
  const allowed=filename==='config.toml'||!!profileName&&profilePattern.test(profileName)&&profileName!=='.'&&profileName!=='..'&&filename===`${profileName}.config.toml`;
  if(!allowed)throw new Error('Only the normal Codex config and the explicitly selected profile config may be exposed to the app-owned home.');
  const ops={...fileOps,...overrides} as CodexHomeFileOps;
  const normalRoot=path.resolve(normalHome),agentRoot=path.resolve(agentHome);
  const normalRootReal=await ops.realpath(normalRoot);
  const [normalStat,agentStat]=await Promise.all([ops.lstat(normalRoot),ops.lstat(agentRoot)]);
  if(!normalStat.isDirectory()||normalStat.isSymbolicLink()||!agentStat.isDirectory()||agentStat.isSymbolicLink()||await hasReparseDirectoryComponent(ops,agentRoot))throw new Error('The normal or app-owned Codex home is not a verified directory.');
  const source=path.join(normalRoot,filename),destination=path.join(agentRoot,filename);
  if(!samePath(path.dirname(destination),agentRoot)||!destination.toLowerCase().startsWith(`${agentRoot.toLowerCase()}${path.sep}`))throw new Error('The Codex config destination escaped its app-owned home.');
  let sourceStat:Stats;
  try{sourceStat=await ops.lstat(source);}catch(error){if(isCode(error,['ENOENT'])&&!required)return missing(ops,filename,normalRoot,agentRoot);throw error;}
  if(!sourceStat.isFile()||sourceStat.isSymbolicLink())throw new Error('The selected Codex config source must be a regular file.');
  const sourceReal=await ops.realpath(source);
  if(!samePath(path.dirname(sourceReal),normalRootReal)||path.basename(sourceReal)!==filename)throw new Error('The selected Codex config source resolved outside its trusted home.');

  let destinationStat:Stats|undefined;
  try{destinationStat=await ops.lstat(destination);}catch(error){if(!isCode(error,['ENOENT']))throw error;}
  if(destinationStat?.isDirectory()||destinationStat&&!destinationStat.isFile()&&!destinationStat.isSymbolicLink())throw new Error('Unexpected entry in the app-owned Codex home.');
  if(destinationStat?.isSymbolicLink()){
    let targetReal:string;
    try{targetReal=await ops.realpath(destination);}catch{throw new Error('Unexpected symbolic link in the app-owned Codex home.');}
    if(!samePath(targetReal,sourceReal))throw new Error('Unexpected symbolic link in the app-owned Codex home.');
    return 'symlink';
  }
  if(destinationStat?.isFile()){
    const [sourceCurrent,destinationCurrent]=await Promise.all([ops.stat(source),ops.stat(destination)]);
    if(sourceCurrent.dev===destinationCurrent.dev&&sourceCurrent.ino===destinationCurrent.ino)return 'hardlink';
  }

  const temp=path.join(agentRoot,`.pseudoharness-config-${ops.randomId()}`);
  try{
    try{
      await ops.link(source,temp);
      const [sourceCurrent,tempCurrent]=await Promise.all([ops.stat(source),ops.stat(temp)]);
      const currentSourceType=await ops.lstat(source);
      if(currentSourceType.isSymbolicLink()||!currentSourceType.isFile()||!samePath(await ops.realpath(source),sourceReal)||sourceCurrent.dev!==tempCurrent.dev||sourceCurrent.ino!==tempCurrent.ino)throw new Error('The temporary Codex config hard link did not match the trusted source file.');
      await replaceVerifiedTemp(temp,destination,agentRoot,ops);
      return 'hardlink';
    }catch(error){
      try{await ops.unlink(temp);}catch{}
      if(!isCode(error,['EXDEV']))throw error;
    }

    try{
      await ops.symlink(source,temp,'file');
      if(!samePath(await ops.realpath(temp),sourceReal))throw new Error('The temporary Codex config symlink did not resolve to the trusted source file.');
      await replaceVerifiedTemp(temp,destination,agentRoot,ops);
      return 'symlink';
    }catch(error){
      try{await ops.unlink(temp);}catch{}
      if(!isCode(error,['EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS']))throw error;
    }

    const sourceBytes=await ops.readFile(source),sourceHash=createHash('sha256').update(sourceBytes).digest('hex');
    const sourceAfter=await ops.lstat(source),sourceRealAfter=await ops.realpath(source),sourceBytesAgain=await ops.readFile(source);
    if(sourceAfter.isSymbolicLink()||!sourceAfter.isFile()||!samePath(sourceRealAfter,sourceReal)||createHash('sha256').update(sourceBytesAgain).digest('hex')!==sourceHash)throw new Error('The selected Codex config changed while its app-owned snapshot was being refreshed.');
    if(destinationStat?.isFile()){
      const currentBytes=await ops.readFile(destination);
      if(createHash('sha256').update(currentBytes).digest('hex')===sourceHash)return 'snapshot';
    }
    await ops.writeFile(temp,sourceBytes,{flag:'wx',mode:0o600});
    const stagedHash=createHash('sha256').update(await ops.readFile(temp)).digest('hex');
    if(stagedHash!==sourceHash)throw new Error('The staged Codex config snapshot did not match its trusted source.');
    const sourceAtCommit=await ops.lstat(source),sourceRealAtCommit=await ops.realpath(source),sourceBytesAtCommit=await ops.readFile(source);
    if(sourceAtCommit.isSymbolicLink()||!sourceAtCommit.isFile()||!samePath(sourceRealAtCommit,sourceReal)||createHash('sha256').update(sourceBytesAtCommit).digest('hex')!==sourceHash)throw new Error('The selected Codex config changed while its app-owned snapshot was being refreshed.');
    await replaceVerifiedTemp(temp,destination,agentRoot,ops);
    return 'snapshot';
  }finally{try{await ops.unlink(temp);}catch{}}
}
