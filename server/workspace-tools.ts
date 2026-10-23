import type { Task, TaskPass } from './state.js';

export type WorkspaceToolTarget={taskId:string;passId:string};
export const workerWorkspaceTool=[{namespace:'pseudoharness',name:'workspace',description:'Open or inspect the current task’s Browser or GitHub workspace. This only changes the user-visible task workspace and returns minimal status; it cannot read website contents or perform remote writes.',inputSchema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['open_browser','open_github','open_pull_request','dock_browser','dock_github','undock','inspect_github']},url:{type:'string',maxLength:2048}},required:['action']}}];

export function authorizesWorkerWorkspaceTool(task:Task|undefined,pass:TaskPass|undefined,target:WorkspaceToolTarget|undefined,threadId:string){
  return !!task&&!!pass&&!!target&&task.id===target.taskId&&task.currentPassId===target.passId&&pass.id===target.passId&&task.phase==='worker_running'&&task.workerStage==='execute'&&pass.workerStage==='execute'&&task.workerThreadId===threadId;
}

export function normalizeAgentWorkspaceUrl(input:unknown){
  if(typeof input!=='string'||input.length>2048)throw new Error('Provide a credential-free HTTP or HTTPS URL.');
  let url:URL;try{url=new URL(input);}catch{throw new Error('Provide a complete HTTP or HTTPS URL.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||[...url.searchParams.keys()].some(key=>/(token|auth|key|secret|code|session|signature|credential|jwt)/i.test(key)))throw new Error('Workspace URLs must use HTTP or HTTPS and must not contain credentials or authentication parameters.');
  return url.toString();
}

export function workspaceToolRequiresDesktop(action:unknown){return action!=='inspect_github';}
