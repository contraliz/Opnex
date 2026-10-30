import { createHash } from 'node:crypto';
import path from 'node:path';
import { AgentMem, type AgentMemProject } from './agentmem.js';
import { projectPathKey, sameProjectRoot } from './project-identity.js';

export function proposedAgentMemProjectId(root:string){
  const key=projectPathKey(root);
  if(!key)throw new Error('Choose a valid absolute project directory first.');
  const paths=path.win32.isAbsolute(root)?path.win32:path;
  const base=paths.basename(root.replace(/[\\/]+$/,'')).normalize('NFKD').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,24)||'project';
  return `agentmem-${base}-${createHash('sha256').update(key).digest('hex').slice(0,16)}`;
}

export async function withAgentMemProjectSettings<T>(run:(adapter:AgentMem)=>Promise<T>){
  const adapter=new AgentMem();
  try{await adapter.configure();return await run(adapter);}
  finally{adapter.close();}
}

export async function projectScopedAgentMemMcpConfig(projectId:string,root:string,readOnly=false){
  if(!projectId||!root)return undefined;
  return withAgentMemProjectSettings(adapter=>adapter.modelMcpServerConfig(projectId,root,readOnly));
}

export async function discoverProjectBinding(adapter:AgentMem,root:string){
  const projects=await adapter.listProjects();
  const exact=projects.filter(project=>sameProjectRoot(project.sourceRoot,root));
  return {project:exact.length===1?exact[0]:undefined,conflict:exact.length>1,proposedId:proposedAgentMemProjectId(root)};
}

export async function verifyProjectBinding(adapter:AgentMem,id:string,root:string):Promise<AgentMemProject>{
  return adapter.verifyProjectBinding(id,root);
}
