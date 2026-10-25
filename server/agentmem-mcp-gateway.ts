import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport as StdioServer } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AGENTMEM_MODEL_TOOLS, scopeAgentMemToolArgs, scopeAgentMemToolSchema } from './agentmem-mcp-scope.js';
import path from 'node:path';

const projectId=process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ID||'';
const projectRoot=process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT||'';
let repositoryId=process.env.PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID||'';
const setupMode=(process.env.PSEUDOHARNESS_AGENTMEM_SETUP_MODE||'ready') as 'register'|'repository'|'ready';
const command=process.env.PSEUDOHARNESS_AGENTMEM_COMMAND||'';
const args=JSON.parse(process.env.PSEUDOHARNESS_AGENTMEM_ARGS||'[]') as string[];
const configuredEnvValue=JSON.parse(process.env.PSEUDOHARNESS_AGENTMEM_CONFIG_ENV||'{}') as unknown;
async function main(){
  if(!projectId||!projectRoot||!command||!Array.isArray(args)||!args.every((value:unknown)=>typeof value==='string')||!configuredEnvValue||typeof configuredEnvValue!=='object'||Array.isArray(configuredEnvValue)||Object.entries(configuredEnvValue).some(([key,value])=>!key.trim()||typeof value!=='string')||setupMode==='ready'&&!repositoryId)throw new Error('The selected AgentMem project/repository binding is incomplete.');
  const client=new Client({name:'pseudoharness-agentmem-scope',version:'1.0.0'});
  const childEnv={...process.env,...configuredEnvValue} as Record<string,string>;
  const clientTransport=new StdioClientTransport({command,args,env:childEnv,stderr:'ignore'});
  await client.connect(clientTransport);
  const server=new Server({name:'agentmem',version:'1.0.0'},{capabilities:{tools:{listChanged:false}}});
  const rootKey=(value:string)=>path.resolve(value).replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
  const unwrap=(result:any)=>{if(result.isError)throw new Error(result.content?.map((item:any)=>item.text||'').join('\n')||'AgentMem operation failed.');const text=result.content?.find((item:any)=>item.type==='text')?.text;if(text){try{const parsed=JSON.parse(text);if(parsed?.ok===false)throw new Error(parsed.error?.reason||'AgentMem operation failed.');return parsed;}catch(error){if(error instanceof Error&&error.message!=='Unexpected end of JSON input')throw error;}}return result.structuredContent||result;};
  const projects=async()=>{const value=unwrap(await client.callTool({name:'projects',arguments:{action:'list'}}));const rows=value.projects||value.items||[];if(!Array.isArray(rows))throw new Error('AgentMem project list is invalid.');return rows;};
  const repositoryRows=async()=>{const value=unwrap(await client.callTool({name:'repository_list',arguments:{project_id:projectId}}));const rows=value.repositories||[];if(!Array.isArray(rows))throw new Error('AgentMem repository list is invalid.');return rows;};
  const prepareRegistration=async()=>{
    const rows=await projects();const idMatch=rows.find((row:any)=>row?.id===projectId);const rootMatch=rows.find((row:any)=>typeof(row?.source_root||row?.root||row?.cwd)==='string'&&rootKey(row.source_root||row.root||row.cwd)===rootKey(projectRoot));
    if(idMatch)throw new Error('The selected AgentMem project ID is already registered. Select the existing matching project or choose a new ID; no existing KB was changed.');
    if(rootMatch)throw new Error(`This root is already registered as AgentMem project "${rootMatch.id}". Select that ID; no project was re-bound.`);
  };
  const registerRepository=async()=>{
    const projectRows=await projects();const selected=projectRows.find((row:any)=>row?.id===projectId);const selectedRoot=selected?.source_root||selected?.root||selected?.cwd;
    if(!selected||typeof selectedRoot!=='string'||rootKey(selectedRoot)!==rootKey(projectRoot))throw new Error('The selected project ID/root is not registered as configured; repository registration was blocked.');
    const repos=await repositoryRows();const match=repos.find((row:any)=>typeof row?.root==='string'&&rootKey(row.root)===rootKey(projectRoot));
    if(match){repositoryId=String(match.repository_id||'');if(!repositoryId)throw new Error('The matching repository registration has no identity.');return {repository_id:repositoryId,root:projectRoot,already_registered:true};}
    const value=unwrap(await client.callTool({name:'repository_register',arguments:{project_id:projectId,repository_root:projectRoot}}));
    const after=await repositoryRows();const created=after.find((row:any)=>typeof row?.root==='string'&&rootKey(row.root)===rootKey(projectRoot));
    if(!created||typeof created.repository_id!=='string')throw new Error('AgentMem did not confirm a repository index for the selected root.');repositoryId=created.repository_id;return value;
  };
  server.setRequestHandler(ListToolsRequestSchema,async request=>{
    const response=await client.listTools(request.params?.cursor?{cursor:request.params.cursor}:{});
    const setupTools=new Set(setupMode==='register'?['projects','repository_register']:setupMode==='repository'?['repository_register']:[]);
    return {...response,tools:response.tools.filter(tool=>AGENTMEM_MODEL_TOOLS.has(tool.name)&&(tool.name!=='projects'&&tool.name!=='repository_register'||setupTools.has(tool.name))).map(tool=>({...tool,inputSchema:scopeAgentMemToolSchema(tool.inputSchema,tool.name,setupMode),...(tool.name==='projects'?{description:'Initialize the AgentMem KB selected in Pseudoharness Settings. Only action=register is allowed; Pseudoharness supplies the exact selected project ID and root and rejects existing ID/root bindings.'}:{}),...(tool.name==='repository_register'?{description:'Register the repository index for the exact project root selected in Pseudoharness Settings. The project ID and root are supplied and cannot be changed.'}:{})}))};
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const name=request.params?.name||'';
    if(name==='projects'&&setupMode==='register')await prepareRegistration();
    const callArgs=scopeAgentMemToolArgs(name,request.params?.arguments||{},projectId,repositoryId,projectRoot,setupMode);
    if(name==='repository_register')return {content:[{type:'text',text:JSON.stringify(await registerRepository())}]};
    if(['repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','repository_resync'].includes(name)&&!repositoryId)throw new Error('Register the selected project repository index before using repository tools.');
    const result=await client.callTool({name,arguments:callArgs});
    if(name==='projects'&&setupMode==='register'){
      const value=unwrap(result);const returnedRoot=value.source_root||value.root||value.cwd;const returnedId=value.id||value.project_id;
      if(value.onboarding?.newly_registered!==true||returnedId!==projectId||typeof returnedRoot!=='string'||rootKey(returnedRoot)!==rootKey(projectRoot))throw new Error('AgentMem did not confirm a newly registered KB for the selected project ID/root.');
    }
    return result;
  });
  const serverTransport=new StdioServer();
  await server.connect(serverTransport);
  const close=async()=>{try{await server.close();}catch{}try{await client.close();}catch{}};
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
}

void main().catch(error=>{process.stderr.write(`Pseudoharness AgentMem MCP gateway: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
