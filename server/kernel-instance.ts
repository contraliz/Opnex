import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDirectory } from './paths.js';

export const KERNEL_PROTOCOL_VERSION=1 as const;
export const KERNEL_INSTANCE_FILE='kernel-instance.json';

export type KernelInstanceRecord={
  version:1;
  protocolVersion:typeof KERNEL_PROTOCOL_VERSION;
  instanceId:string;
  host:'127.0.0.1';
  port:number;
  pid:number;
  startedAt:string;
  startupSecret:string;
};

export function kernelInstancePath(directory=stateDirectory()){
  return path.join(directory,KERNEL_INSTANCE_FILE);
}

export function createKernelInstanceRecord(input:{port:number;startupSecret:string;directory?:string}):KernelInstanceRecord{
  if(!Number.isInteger(input.port)||input.port<1||input.port>65535)throw new Error('The kernel did not bind a valid local port.');
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(input.startupSecret))throw new Error('The kernel startup credential is invalid.');
  return {version:1,protocolVersion:KERNEL_PROTOCOL_VERSION,instanceId:randomUUID(),host:'127.0.0.1',port:input.port,pid:process.pid,startedAt:new Date().toISOString(),startupSecret:input.startupSecret};
}

export async function writeKernelInstance(record:KernelInstanceRecord,directory=stateDirectory()){
  await mkdir(directory,{recursive:true,mode:0o700});
  const target=kernelInstancePath(directory);
  const temporary=`${target}.${randomUUID()}.tmp`;
  try{
    await writeFile(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});
    await rename(temporary,target);
  }catch(error){
    await rm(temporary,{force:true}).catch(()=>{});
    throw error;
  }
}

export async function readKernelInstance(directory=stateDirectory()):Promise<KernelInstanceRecord|null>{
  let raw:string;
  try{raw=await readFile(kernelInstancePath(directory),'utf8');}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  let value:unknown;
  try{value=JSON.parse(raw);}
  catch{return null;}
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const row=value as Record<string,unknown>;
  if(row.version!==1||row.protocolVersion!==KERNEL_PROTOCOL_VERSION||typeof row.instanceId!=='string'||row.instanceId.length>64||row.host!=='127.0.0.1'||!Number.isInteger(row.port)||Number(row.port)<1||Number(row.port)>65535||!Number.isInteger(row.pid)||Number(row.pid)<1||typeof row.startedAt!=='string'||!Number.isFinite(Date.parse(row.startedAt))||typeof row.startupSecret!=='string'||! /^[A-Za-z0-9_-]{32,128}$/.test(row.startupSecret))return null;
  return row as KernelInstanceRecord;
}

export async function removeKernelInstanceIfOwned(instanceId:string,directory=stateDirectory()){
  const record=await readKernelInstance(directory);
  if(!record||record.instanceId!==instanceId)return false;
  await rm(kernelInstancePath(directory),{force:true});
  return true;
}
