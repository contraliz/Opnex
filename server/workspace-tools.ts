import type { Task, TaskPass } from './state.js';
import { assignmentAuthorizesWorkspaceRootWrite, simpleRouteWriteRoots } from './policy.js';

export type WorkspaceToolTarget={taskId:string;passId:string};
export const workerWorkspaceTool=[{namespace:'pseudoharness',name:'workspace',description:'Open or inspect the current task’s Browser or GitHub workspace, or initialize Git in the active workspace root. Git initialization accepts no path and never creates commits or remotes.',inputSchema:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['open_browser','open_github','open_pull_request','dock_browser','dock_github','undock','inspect_github','initialize_git_repository']},url:{type:'string',maxLength:2048}},required:['action']}}];

export function authorizesWorkerWorkspaceTool(task:Task|undefined,pass:TaskPass|undefined,target:WorkspaceToolTarget|undefined,threadId:string){
  if(!task||!pass||!target||task.id!==target.taskId||task.currentPassId!==target.passId||pass.id!==target.passId||!['worker_running','simple_running'].includes(task.phase))return false;
  if(pass.executionProfile?.provider==='codex'&&((task.activeRole==='simple'&&task.phase==='simple_running'&&task.simpleThreadId===threadId)||(task.activeRole==='worker'&&task.phase==='worker_running'&&task.workerThreadId===threadId)))return true;
  if(task.workerThreadId===threadId&&task.workerStage==='execute'&&pass.workerStage==='execute')return true;
  const team=pass.recruitmentTeam;if(!team?.sealed||team.passId!==pass.id)return false;
  const worker=team.workers.find(row=>row.threadId===threadId);
  if(worker)return worker.workerStage==='execute'&&['running','complete'].includes(worker.status);
  return team.integration.threadId===threadId&&team.integration.workerStage==='execute'&&['running','complete'].includes(team.integration.status);
}

export async function authorizesWorkspaceRepositoryInitialization(task:Task|undefined,pass:TaskPass|undefined,target:WorkspaceToolTarget|undefined,threadId:string){
  if(!task||!pass||!target||!authorizesWorkerWorkspaceTool(task,pass,target,threadId))return false;
  const team=pass.recruitmentTeam;
  if(team?.workers.some(row=>row.threadId===threadId)||team?.integration.threadId===threadId)return false;
  if(task.activeRole==='simple'){
    const roots=await simpleRouteWriteRoots(pass.userInputs||[],task.userRoot);
    return !!roots?.some(root=>assignmentAuthorizesWorkspaceRootWrite({write_scope:[root]},task.userRoot));
  }
  const assignment=pass.assignment||task.assignment;
  return !!assignment&&assignmentAuthorizesWorkspaceRootWrite(assignment,task.userRoot);
}

export function normalizeAgentWorkspaceUrl(input:unknown){
  if(typeof input!=='string'||input.length>2048)throw new Error('Provide a credential-free HTTP or HTTPS URL.');
  let url:URL;try{url=new URL(input);}catch{throw new Error('Provide a complete HTTP or HTTPS URL.');}
  const credentialKey=/(token|auth|key|secret|code|session|signature|credential|jwt)/i;
  const hasCredentialParameter=(value:string)=>value.includes('=')&&[...new URLSearchParams(value.replace(/^\?/,'')).keys()].some(key=>credentialKey.test(key));
  const fragment=url.hash.slice(1);
  let decodedFragment=fragment;try{decodedFragment=decodeURIComponent(fragment.replaceAll('+',' '));}catch{/* Keep checking the browser's original fragment if it is not valid encoded text. */}
  // Check the whole fragment (OAuth implicit-flow parameters) and the portion
  // after a hash-route query marker, while allowing ordinary anchors/routes.
  const hashQuery=fragment.includes('?')?fragment.slice(fragment.indexOf('?')+1):'';
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||hasCredentialParameter(url.search)||hasCredentialParameter(fragment)||hasCredentialParameter(decodedFragment)||hashQuery&&hasCredentialParameter(hashQuery))throw new Error('Workspace URLs must use HTTP or HTTPS and must not contain credentials or authentication parameters.');
  return url.toString();
}

export function workspaceToolRequiresDesktop(action:unknown){return !['inspect_github','initialize_git_repository'].includes(String(action));}
