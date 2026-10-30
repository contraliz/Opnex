import { fileURLToPath } from 'node:url';
import { stateDirectory } from './paths.js';
import { resolveMcpHelperLaunch } from './mcp-helper-runtime.js';

export function workspaceMcpServerConfig({taskId,passId,role,sessionId}:{taskId:string;passId:string;role:'simple'|'worker';sessionId:string}):Record<string,unknown>{
  const modulePath=fileURLToPath(import.meta.url),launch=resolveMcpHelperLaunch({modulePath,helperFile:modulePath.endsWith('.ts')?'workspace-mcp-gateway.ts':'workspace-mcp-gateway.js'});
  const dataDirectory=stateDirectory();
  return {command:launch.command,args:launch.args,cwd:launch.cwd,enabled:true,enabled_tools:['initialize_git_repository'],env:{OPNEX_DATA_DIR:dataDirectory,PSEUDOHARNESS_DATA_DIR:dataDirectory,OPNEX_WORKSPACE_TASK_ID:taskId,OPNEX_WORKSPACE_PASS_ID:passId,OPNEX_WORKSPACE_ROLE:role,OPNEX_WORKSPACE_SESSION_ID:sessionId}};
}
