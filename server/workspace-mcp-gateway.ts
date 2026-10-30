import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureWorkspaceRepository } from './workspace-git-init.js';
import { stateDirectory } from './paths.js';
import { authorizedWorkspaceGitInitRoot } from './workspace-mcp-auth.js';

const taskId=process.env.OPNEX_WORKSPACE_TASK_ID||'';
const passId=process.env.OPNEX_WORKSPACE_PASS_ID||'';
const role=process.env.OPNEX_WORKSPACE_ROLE||'';
const sessionId=process.env.OPNEX_WORKSPACE_SESSION_ID||'';
const inputSchema={type:'object',properties:{},additionalProperties:false};
const tool={name:'initialize_git_repository',description:'Initialize or inspect the Git repository for the current workspace root. The workspace root comes from the active Opnex pass; this tool accepts no directory argument and never creates commits or remotes.',inputSchema};

async function currentWorkspaceRoot(){
  try{
    const state=JSON.parse(await readFile(path.join(stateDirectory(),'state.json'),'utf8'));
    return await authorizedWorkspaceGitInitRoot(state,{taskId,passId,role:role as 'simple'|'worker',sessionId});
  }catch{return undefined;}
}

const server=new Server({name:'pseudoharness_workspace',version:'1.0.0'},{capabilities:{tools:{listChanged:false}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:await currentWorkspaceRoot()?[tool]:[]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{
    const root=await currentWorkspaceRoot();if(!root)throw new Error('The Git initialization tool is not scoped to the active workspace execution.');
    if(request.params.name!=='initialize_git_repository'||Object.keys(request.params.arguments||{}).length)throw new Error('The Git tool accepts no arguments; it always uses the active workspace root.');
    const result=await ensureWorkspaceRepository(root,undefined,async()=>!!await currentWorkspaceRoot());
    return {content:[{type:'text',text:JSON.stringify({created:result.created,workspaceRoot:result.workspaceRoot,repositoryRoot:result.repositoryRoot})}]};
  }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Workspace Git initialization failed.'}]};}
});
void server.connect(new StdioServerTransport()).catch(error=>{process.stderr.write(`Opnex workspace MCP: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
