import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readKernelInstance, type KernelInstanceRecord } from '../server/kernel-instance.js';

const children:ChildProcess[]=[];
const temporaryDirectories:string[]=[];
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function temporaryDirectory(label:string){
  const root=await mkdtemp(path.join(os.tmpdir(),`pseudoharness-${label}-`));
  temporaryDirectories.push(root);return root;
}

function launchKernel(dataDirectory:string){
  let output='';
  const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{
    cwd:process.cwd(),
    env:{...process.env,NODE_ENV:'test',PORT:'0',PSEUDOHARNESS_DATA_DIR:dataDirectory,PSEUDOHARNESS_STARTUP_SECRET:randomBytes(32).toString('hex'),CODEX_HOME:path.join(dataDirectory,'codex-home')},
    stdio:['ignore','pipe','pipe'],windowsHide:true
  });
  child.stdout?.on('data',chunk=>{output+=String(chunk);});
  child.stderr?.on('data',chunk=>{output+=String(chunk);});
  children.push(child);
  return {child,getOutput:()=>output};
}

async function poll<T>(check:()=>Promise<T|undefined>,failure:()=>string,timeoutMs=10_000):Promise<T>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const result=await check();if(result!==undefined)return result;
    await wait(25);
  }
  throw new Error(failure());
}

async function startKernel(dataDirectory:string){
  const process=launchKernel(dataDirectory);
  const instance=await poll(async()=>await readKernelInstance(dataDirectory)||undefined,()=>process.getOutput()||'Headless kernel did not write its discovery record.') as KernelInstanceRecord;
  const health=await fetch(`http://${instance.host}:${instance.port}/api/health`);
  expect(health.ok).toBe(true);
  return {...process,instance,origin:`http://${instance.host}:${instance.port}`};
}

async function readFirstEvent(response:Response){
  if(!response.body)throw new Error('Event stream did not return a body.');
  const reader=response.body.getReader();let text='';
  while(!text.includes('\n\n')){
    const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value,{stream:true});
  }
  await reader.cancel().catch(()=>{});
  const id=Number(text.match(/^id: (\d+)$/m)?.[1]);
  const data=text.match(/^data: (.+)$/m)?.[1];
  if(!Number.isSafeInteger(id)||!data)throw new Error(`Malformed kernel event: ${text.slice(0,500)}`);
  return {id,payload:JSON.parse(data)};
}

async function stopChild(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited,wait(2500)]);
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,wait(1000)]);}
}

afterEach(async()=>{
  for(const child of children.splice(0))await stopChild(child);
  for(const directory of temporaryDirectories.splice(0))await rm(directory,{recursive:true,force:true});
});

describe('headless kernel HTTP boundary',()=>{
  it('launches without a window, reconnects by snapshot cursor, rejects stale clients, and preserves saved outcomes on shutdown',async()=>{
    const dataDirectory=await temporaryDirectory('profile-a');
    const at='2026-10-27T12:00:00.000Z';
    await writeFile(path.join(dataDirectory,'state.json'),JSON.stringify({
      version:3,
      settings:{projectRoot:'',agentmemProjectId:'',orchestratorModel:'gpt-6-sol',orchestratorEffort:'low',approvalPolicy:'on-request'},
      tasks:[
        {id:'saved-task',title:'Saved outcome',phase:'accepted',createdAt:at,updatedAt:at,userRoot:dataDirectory,agentmemProjectId:'',userMessages:['Keep this result'],messages:[{id:'saved-user',role:'user',text:'Keep this result',createdAt:at},{id:'saved-answer',role:'worker',text:'Persisted result from a completed task.',createdAt:at}],correctionCount:0,processedTurns:[]},
        {id:'interrupted-task',title:'Interrupted work',phase:'worker_running',createdAt:at,updatedAt:at,userRoot:dataDirectory,agentmemProjectId:'',userMessages:['Resume safely'],messages:[{id:'interrupted-user',role:'user',text:'Resume safely',createdAt:at},{id:'partial-worker',role:'worker',text:'Partial work before restart.',createdAt:at}],activeRole:'worker',activeTurnId:'turn-before-restart',correctionCount:0,processedTurns:[]},
        {id:'pending-intake',title:'Pending intake',phase:'intake',createdAt:at,updatedAt:at,userRoot:dataDirectory,agentmemProjectId:'',userMessages:['Start this task'],messages:[{id:'pending-intake-user',role:'user',text:'Start this task',createdAt:at}],correctionCount:0,processedTurns:[]},
        {id:'awaiting-user',title:'Awaiting user choice',phase:'escalated',createdAt:at,updatedAt:at,userRoot:dataDirectory,agentmemProjectId:'',userMessages:['Choose a path'],messages:[{id:'awaiting-user-message',role:'user',text:'Choose a path',createdAt:at}],correctionCount:0,processedTurns:[]}
      ],
      activeTaskId:'interrupted-task',projects:[],selectedProjectId:null,expandedProjectIds:['unclassified']
    }));

    const kernel=await startKernel(dataDirectory);
    const clientHeader={'x-pseudoharness-protocol-version':'1'};
    const initialResponse=await fetch(`${kernel.origin}/api/v1/snapshot`,{headers:clientHeader});
    expect(initialResponse.status).toBe(200);
    const initial=await initialResponse.json() as {protocolVersion:number;kernelInstanceId:string;cursor:number;csrf:string;state:{revision:number;tasks:{id:string;phase:string;messages:{text:string}[]}[]}};
    expect(initial).toMatchObject({protocolVersion:1,kernelInstanceId:kernel.instance.instanceId,cursor:0,state:{revision:0}});
    expect(initial.state.tasks.find(task=>task.id==='interrupted-task')?.phase).toBe('paused_after_restart');
    expect(initial.state.tasks.find(task=>task.id==='pending-intake')?.phase).toBe('paused_after_restart');
    expect(initial.state.tasks.find(task=>task.id==='awaiting-user')?.phase).toBe('escalated');
    expect(initial.state.tasks.find(task=>task.id==='saved-task')?.messages.at(-1)?.text).toBe('Persisted result from a completed task.');
    const recoveredOnDisk=JSON.parse(await readFile(path.join(dataDirectory,'state.json'),'utf8'));
    expect(recoveredOnDisk.tasks.find((task:any)=>task.id==='interrupted-task').phase).toBe('paused_after_restart');
    expect(recoveredOnDisk.tasks.find((task:any)=>task.id==='pending-intake').phase).toBe('paused_after_restart');
    expect(recoveredOnDisk.tasks.find((task:any)=>task.id==='awaiting-user').phase).toBe('escalated');

    const stale=await fetch(`${kernel.origin}/api/v1/snapshot`,{headers:{'x-pseudoharness-protocol-version':'99'}});
    expect(stale.status).toBe(426);expect((await stale.json()).code).toBe('PROTOCOL_VERSION_MISMATCH');
    const missingVersion=await fetch(`${kernel.origin}/api/v1/snapshot`);
    expect(missingVersion.status).toBe(426);
    const wrongOrigin=await fetch(`${kernel.origin}/api/v1/snapshot`,{headers:{...clientHeader,origin:'https://example.com'}});
    expect(wrongOrigin.status).toBe(403);
    const legacy=await fetch(`${kernel.origin}/api/bootstrap`);
    expect(legacy.status).toBe(200);

    const firstController=new AbortController();
    const firstEvents=await fetch(`${kernel.origin}/api/v1/events?protocol=1`,{headers:{...clientHeader,origin:'http://127.0.0.1:5173'},signal:firstController.signal});
    const firstEvent=await readFirstEvent(firstEvents);firstController.abort();
    expect(firstEvent.payload).toMatchObject({protocolVersion:1,kernelInstanceId:kernel.instance.instanceId,cursor:0,type:'snapshot'});

    const missingMutationVersion=await fetch(`${kernel.origin}/api/v1/projects/select`,{method:'POST',headers:{origin:kernel.origin,'content-type':'application/json','x-pseudoharness-token':initial.csrf},body:JSON.stringify({projectId:null})});
    expect(missingMutationVersion.status).toBe(426);
    const mutation=await fetch(`${kernel.origin}/api/v1/projects/select`,{method:'POST',headers:{...clientHeader,origin:kernel.origin,'content-type':'application/json','x-pseudoharness-token':initial.csrf},body:JSON.stringify({projectId:null})});
    expect(mutation.status).toBe(200);
    const resumedController=new AbortController();
    const resumedEvents=await fetch(`${kernel.origin}/api/v1/events?protocol=1`,{headers:{...clientHeader,origin:'http://127.0.0.1:5173','last-event-id':String(firstEvent.id)},signal:resumedController.signal});
    const resumedEvent=await readFirstEvent(resumedEvents);resumedController.abort();
    expect(resumedEvent.id).toBeGreaterThan(firstEvent.id);
    expect(resumedEvent.payload.cursor).toBe(resumedEvent.id);expect(resumedEvent.payload.resync).toBe(true);expect(resumedEvent.payload.state.tasks.some((task:{id:string})=>task.id==='saved-task')).toBe(true);

    const duplicate=launchKernel(dataDirectory);
    const duplicatePort=Number((await poll(async()=>Number(duplicate.getOutput().match(/headless kernel listening on http:\/\/127\.0\.0\.1:(\d+)/)?.[1])||undefined,duplicate.getOutput)).toString());
    const duplicateHealth=await fetch(`http://127.0.0.1:${duplicatePort}/api/health`);
    expect((await duplicateHealth.json()).stateCode).toBe('STATE_DIRECTORY_IN_USE');
    expect((await (await fetch(`${kernel.origin}/api/v1/snapshot`,{headers:clientHeader})).json()).state.tasks).toHaveLength(4);
    await stopChild(duplicate.child);

    const shutdown=await fetch(`${kernel.origin}/api/v1/kernel/shutdown`,{method:'POST',headers:{...clientHeader,origin:kernel.origin,'content-type':'application/json','x-pseudoharness-token':initial.csrf},body:JSON.stringify({confirm:'stop-kernel'})});
    expect(shutdown.status).toBe(202);
    await poll(async()=>kernel.child.exitCode===0?true:undefined,()=>kernel.getOutput()||'Kernel did not stop cleanly.');
    const persisted=JSON.parse(await readFile(path.join(dataDirectory,'state.json'),'utf8'));
    expect(persisted.tasks.find((task:any)=>task.id==='saved-task').messages.at(-1).text).toBe('Persisted result from a completed task.');
    expect(persisted.tasks.find((task:any)=>task.id==='interrupted-task').messages.at(-1).text).toBe('Partial work before restart.');
    expect(persisted.revision).toBeGreaterThan(0);
    expect(await readKernelInstance(dataDirectory)).toBeNull();

    const restarted=await startKernel(dataDirectory);
    const recovered=await (await fetch(`${restarted.origin}/api/v1/snapshot`,{headers:clientHeader})).json();
    expect(recovered.kernelInstanceId).not.toBe(kernel.instance.instanceId);
    expect(recovered.cursor).toBe(persisted.revision);
    expect(recovered.state.tasks.find((task:any)=>task.id==='saved-task').phase).toBe('accepted');
    expect(recovered.state.tasks.find((task:any)=>task.id==='interrupted-task').phase).toBe('paused_after_restart');
    const restartedSnapshot=await fetch(`${restarted.origin}/api/v1/kernel/shutdown`,{method:'POST',headers:{...clientHeader,origin:restarted.origin,'content-type':'application/json','x-pseudoharness-token':recovered.csrf},body:JSON.stringify({confirm:'stop-kernel'})});
    expect(restartedSnapshot.status).toBe(202);
    await poll(async()=>restarted.child.exitCode===0?true:undefined,()=>restarted.getOutput()||'Restarted kernel did not stop cleanly.');
  },30_000);

  it('runs isolated profiles independently while each state directory has one writable kernel',async()=>{
    const firstDirectory=await temporaryDirectory('profile-one');
    const secondDirectory=await temporaryDirectory('profile-two');
    const first=await startKernel(firstDirectory);
    const second=await startKernel(secondDirectory);
    expect(second.instance.instanceId).not.toBe(first.instance.instanceId);
    const firstInfo=await (await fetch(`${first.origin}/api/v1/info`,{headers:{'x-pseudoharness-protocol-version':'1'}})).json();
    const secondInfo=await (await fetch(`${second.origin}/api/v1/info`,{headers:{'x-pseudoharness-protocol-version':'1'}})).json();
    expect(firstInfo.kernelInstanceId).not.toBe(secondInfo.kernelInstanceId);
    for(const kernel of [first,second]){
      const snapshot=await (await fetch(`${kernel.origin}/api/v1/snapshot`,{headers:{'x-pseudoharness-protocol-version':'1'}})).json();
      const stopped=await fetch(`${kernel.origin}/api/v1/kernel/shutdown`,{method:'POST',headers:{'x-pseudoharness-protocol-version':'1',origin:kernel.origin,'content-type':'application/json','x-pseudoharness-token':snapshot.csrf},body:JSON.stringify({confirm:'stop-kernel'})});
      expect(stopped.status).toBe(202);
    }
    await Promise.all([first,second].map(kernel=>poll(async()=>kernel.child.exitCode===0?true:undefined,()=>kernel.getOutput()||'Isolated kernel did not stop cleanly.')));
  },30_000);
});
