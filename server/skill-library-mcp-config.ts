import { fileURLToPath } from 'node:url';
import { stateDirectory } from './paths.js';
import { resolveMcpHelperLaunch } from './mcp-helper-runtime.js';

export function skillLibraryMcpServerConfig({taskId,role}:{taskId:string;role:'direct'|'simple'|'orchestrator'|'worker'}):Record<string,unknown>{
  const modulePath=fileURLToPath(import.meta.url),launch=resolveMcpHelperLaunch({modulePath,helperFile:modulePath.endsWith('.ts')?'skills-mcp-gateway.ts':'skills-mcp-gateway.js'});
  return {command:launch.command,args:launch.args,cwd:launch.cwd,enabled:true,enabled_tools:['skills_list','skills_search','skills_load','skills_read_file'],env:{PSEUDOHARNESS_DATA_DIR:stateDirectory(),PSEUDOHARNESS_SKILLS_TASK_ID:taskId,PSEUDOHARNESS_SKILLS_ROLE:role}};
}
