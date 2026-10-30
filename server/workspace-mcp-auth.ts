import path from 'node:path';

export type WorkspaceMcpScope={taskId:string;passId:string;role:'simple'|'worker';sessionId:string};

export function authorizedWorkspaceRoot(state:unknown,scope:WorkspaceMcpScope):string|undefined{
  if(!state||typeof state!=='object'||Array.isArray(state))return;
  const tasks=(state as {tasks?:unknown}).tasks;if(!Array.isArray(tasks))return;
  const task=tasks.find((row:any)=>row?.id===scope.taskId),pass=task?.passes?.find((row:any)=>row?.id===scope.passId);
  if(!task||!pass||task.currentPassId!==scope.passId||typeof task.userRoot!=='string'||!path.isAbsolute(task.userRoot))return;
  if(scope.role==='simple'){
    if(pass.executionProfile?.provider!=='deepseek'||task.phase!=='simple_running'||task.activeRole!=='simple'||task.simpleThreadId!==scope.sessionId||!task.activeTurnId)return;
    return task.userRoot;
  }
  if(pass.executionProfile?.provider==='deepseek'&&task.phase==='worker_running'&&task.workerStage==='execute'&&pass.workerStage==='execute'&&task.activeRole==='worker'&&task.workerThreadId===scope.sessionId&&task.activeTurnId)return task.userRoot;
  if(task.phase!=='worker_running'||!pass.recruitmentTeam?.sealed||pass.recruitmentTeam.passId!==scope.passId)return;
  const team=pass.recruitmentTeam;
  const worker=team.workers?.find((item:any)=>item.threadId===scope.sessionId&&item.status==='running'&&item.activeTurnId);
  const integration=team.integration?.threadId===scope.sessionId&&team.integration.status==='running'&&team.integration.activeTurnId?team.integration:undefined;
  const provider=worker?.executionProfile?.provider||worker?.deepSeekExecution&&'deepseek'||integration?.executionProfile?.provider||integration?.deepSeekExecution&&'deepseek';
  return provider==='deepseek'&&(worker||integration)?task.userRoot:undefined;
}
