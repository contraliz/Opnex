import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDirectory } from './paths.js';

export function skillLibraryMcpServerConfig({taskId,role}:{taskId:string;role:'direct'|'simple'|'orchestrator'|'worker'}):Record<string,unknown>{
  const modulePath=fileURLToPath(import.meta.url),development=modulePath.endsWith('.ts');
  const gatewayPath=development?modulePath.replace(/skill-library-mcp-config\.ts$/,'skills-mcp-gateway.ts'):path.join(path.dirname(modulePath),'skills-mcp-gateway.js');
  return {command:process.execPath,args:development?['--import',import.meta.resolve('tsx'),gatewayPath]:[gatewayPath],cwd:path.resolve(path.dirname(modulePath),'..'),enabled:true,enabled_tools:['skills_list','skills_search','skills_load','skills_read_file','skills_save'],env:{PSEUDOHARNESS_DATA_DIR:stateDirectory(),PSEUDOHARNESS_SKILLS_TASK_ID:taskId,PSEUDOHARNESS_SKILLS_ROLE:role,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})}};
}
