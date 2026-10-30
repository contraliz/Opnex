import path from 'node:path';
import type { Project, Task } from './state.js';

export function projectPathKey(value:string,platform:NodeJS.Platform=process.platform):string|null{
  const input=value.trim();
  if(!input)return null;
  const windows=platform==='win32'||path.win32.isAbsolute(input);
  const paths=windows?path.win32:path.posix;
  if(!paths.isAbsolute(input))return null;
  const resolved=paths.normalize(paths.resolve(input));
  const root=paths.parse(resolved).root;
  const normalized=resolved===root?resolved:resolved.replace(/[\\/]+$/,'');
  return windows?normalized.replaceAll('\\','/').toLocaleLowerCase('en-US'):normalized;
}

export function sameProjectRoot(left:string,right:string,platform:NodeJS.Platform=process.platform){
  const a=projectPathKey(left,platform),b=projectPathKey(right,platform);
  return !!a&&!!b&&a===b;
}

export function assertTaskCanResumeInProject(task:Task,project:Project){
  if(task.requiresFreshSession)
    throw new Error('This historical session used an older project integration. Its history remains available; start a new session to continue work.');
  if(!task.userRoot||!sameProjectRoot(task.userRoot,project.projectRoot))
    throw new Error('This session was created for a different project directory. Start a new session in the selected project; its saved history and original project identity are preserved.');
}

const resumablePhases=new Set<Task['phase']>(['intake','routing','direct_running','simple_running','planning','worker_running','escalated','reviewing','needs_attention','paused_after_restart']);
export function projectHasActiveOrResumableTask(projectId:string,tasks:readonly Task[]){
  return tasks.some(task=>task.projectId===projectId&&(resumablePhases.has(task.phase)||!!task.activeRole||!!task.activeTurnId||!!task.approvalRequests?.length));
}

export function assertProjectIdentityChangeAllowed(current:Project,next:Project,tasks:readonly Task[]){
  const identityChanged=!sameProjectRoot(current.projectRoot,next.projectRoot);
  if(identityChanged&&projectHasActiveOrResumableTask(current.id,tasks))
    throw new Error('Finish or stop active and resumable sessions before changing this project directory.');
}
