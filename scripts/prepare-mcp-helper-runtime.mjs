import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NODE_RUNTIME_VERSION='24.22.1';
export const NODE_RUNTIME_SHA256={
  'win32-x64':'d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
  'darwin-x64':'65e450f90a6eaacd5000f611861c4ce65fadc87f813795dc4ed0c0e5f2fca2d4',
  'darwin-arm64':'654ba79de6155647e22321932b45f2a1ccb705976cc337c9b8e278beb085a628',
};

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const outputRoot=path.join(repositoryRoot,'node_modules','.cache','pseudoharness-mcp-runtime');

function run(command,args,cwd){return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,windowsHide:true,stdio:'ignore'});
  child.once('error',reject);child.once('close',(code,signal)=>code===0?resolve():reject(new Error(`${command} exited with ${signal||code}.`)));
});}

async function fetchArchive(file,destination){
  const url=`https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${file}`;
  const response=await fetch(url,{redirect:'follow'});
  if(!response.ok||new URL(response.url).hostname!=='nodejs.org')throw new Error(`Could not download the official Node.js runtime archive (${response.status}).`);
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>150*1024*1024)throw new Error('The official Node.js runtime archive exceeded its size limit.');
  const target=file.includes('-win-x64.')?'win32-x64':file.replace(`node-v${NODE_RUNTIME_VERSION}-`,'').replace('.tar.xz','');
  const expected=NODE_RUNTIME_SHA256[target];
  if(!expected)throw new Error(`No pinned checksum is recorded for ${file}.`);
  const actual=createHash('sha256').update(buffer).digest('hex');
  if(actual!==expected)throw new Error(`The Node.js runtime archive checksum did not match the pinned official value for ${file}.`);
  await writeFile(destination,buffer,{flag:'wx'});
}

async function stageTarget(target){
  const [platform,arch]=target.split('-');
  const extension=platform==='win32'?'.zip':'.tar.xz';
  const nodePlatform=platform==='win32'?'win-x64':`darwin-${arch}`;
  const archiveName=`node-v${NODE_RUNTIME_VERSION}-${nodePlatform}${extension}`;
  const archiveRoot=`node-v${NODE_RUNTIME_VERSION}-${nodePlatform}`;
  const temp=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-mcp-runtime-'));
  try{
    const archive=path.join(temp,archiveName);
    await fetchArchive(archiveName,archive);
    const output=path.join(outputRoot,target);
    await mkdir(output,{recursive:true});
    const binaryPath=platform==='win32'?`${archiveRoot}/node.exe`:`${archiveRoot}/bin/node`;
    await run('tar',['-xf',archive,'-C',temp,binaryPath,`${archiveRoot}/LICENSE`],temp);
    const extractedBinary=path.join(temp,binaryPath);
    const executable=path.join(output,platform==='win32'?'node.exe':'node');
    await copyFile(extractedBinary,executable);
    await copyFile(path.join(temp,archiveRoot,'LICENSE'),path.join(output,'LICENSE'));
    if(platform!=='win32')await chmod(executable,0o755);
    const binary=await stat(executable);if(!binary.isFile()||binary.size<10*1024*1024)throw new Error(`The staged Node runtime binary for ${target} is incomplete.`);
    let version='archive checksum and file layout verified';
    if(platform===process.platform&&arch===process.arch){
      version=await new Promise((resolve,reject)=>{
        const child=spawn(executable,['--version'],{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
        child.stdout.setEncoding('utf8').on('data',value=>stdout+=value);child.stderr.setEncoding('utf8').on('data',value=>stderr+=value);
        child.once('error',reject);child.once('close',code=>code===0?resolve(`${stdout}${stderr}`.trim()):reject(new Error(`Staged Node runtime failed its version check (${code}).`)));
      });
      if(version!==`v${NODE_RUNTIME_VERSION}`)throw new Error(`The staged Node runtime reported ${version}; expected v${NODE_RUNTIME_VERSION}.`);
    }
    return {target,version,sha256:NODE_RUNTIME_SHA256[target]};
  }finally{await rm(temp,{recursive:true,force:true});}
}

export async function prepareMcpHelperRuntime({platform=process.platform,arch=process.arch}={}){
  let targets;
  if(platform==='win32'&&arch==='x64')targets=['win32-x64'];
  else if(platform==='darwin'&&['x64','arm64'].includes(arch))targets=['darwin-x64','darwin-arm64'];
  else throw new Error(`No packaged MCP helper runtime is configured for ${platform}/${arch}.`);
  await mkdir(outputRoot,{recursive:true});
  const results=[];for(const target of targets)results.push(await stageTarget(target));
  return results;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const results=await prepareMcpHelperRuntime();for(const row of results)console.log(`Prepared Node.js ${row.version} for ${row.target} (${row.sha256}).`);}
  catch(error){console.error(error instanceof Error?error.message:'Could not prepare packaged MCP helper runtime.');process.exitCode=1;}
}
