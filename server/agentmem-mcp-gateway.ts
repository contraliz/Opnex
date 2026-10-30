import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport as StdioServer } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, InitializedNotificationSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AGENTMEM_MODEL_TOOLS, AGENTMEM_REPOSITORY_TOOLS, scopeAgentMemToolArgs, scopeAgentMemToolSchema } from './agentmem-mcp-scope.js';
import { sameProjectRoot } from './project-identity.js';
import { AgentMemTimeoutError, withAgentMemTimeout } from './agentmem-adapter-timeout.js';

const appEnv=(name:string)=>process.env[`OPNEX_AGENTMEM_${name}`]??process.env[`PSEUDOHARNESS_AGENTMEM_${name}`];
const projectId=appEnv('PROJECT_ID')||'';
const projectRoot=appEnv('PROJECT_ROOT')||'';
const configuredRepositoryId=appEnv('REPOSITORY_ID')||'';
const readOnlyAccess=appEnv('ACCESS')==='read-only';
const command=appEnv('COMMAND')||'';
const args=JSON.parse(appEnv('ARGS')||'[]') as string[];
const configuredEnvValue=JSON.parse(appEnv('CONFIG_ENV')||'{}') as unknown;
const statusSchema={type:'object',properties:{},additionalProperties:false};
const upstreamTimeoutMs=2500;
const cleanupTimeoutMs=500;

function resultText(value:any){return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};}
function unwrap(result:any){
  if(result.isError)throw new Error(result.content?.map((item:any)=>item.text||'').join('\n')||'AgentMem operation failed.');
  const text=result.content?.find((item:any)=>item.type==='text')?.text;
  if(text){try{const parsed=JSON.parse(text);if(parsed?.ok===false)throw new Error(parsed.error?.reason||'AgentMem operation failed.');return parsed;}catch(error){if(error instanceof Error&&error.message!=='Unexpected end of JSON input')throw error;}}
  return result.structuredContent||result;
}

async function main(){
  if(!projectId||!projectRoot||!command||!Array.isArray(args)||!args.every((value:unknown)=>typeof value==='string')||!configuredEnvValue||typeof configuredEnvValue!=='object'||Array.isArray(configuredEnvValue)||Object.entries(configuredEnvValue).some(([key,value])=>!key.trim()||typeof value!=='string'))throw new Error('The project-scoped AgentMem adapter configuration is incomplete.');
  const server=new Server({name:'opnex-agentmem',version:'1.0.0'},{capabilities:{tools:{listChanged:true}}});
  const serverTransport=new StdioServer();
  let client:Client|undefined,transport:StdioClientTransport|undefined,repositoryId=configuredRepositoryId;
  let ready=false,initialized=false,connecting:Promise<void>|undefined,lastAttempt=0,status='AgentMem is unavailable; continue project work without it.';
  const closeUpstream=async(targetClient=client,targetTransport=transport)=>{
    if(client===targetClient)ready=false;
    if(targetClient)try{await withAgentMemTimeout(targetClient.close(),cleanupTimeoutMs,'AgentMem client cleanup');}catch{}
    if(targetTransport)try{await withAgentMemTimeout(targetTransport.close(),cleanupTimeoutMs,'AgentMem transport cleanup');}catch{}
    if(client===targetClient)client=undefined;
    if(transport===targetTransport)transport=undefined;
  };
  const notifyToolsChanged=async()=>{if(initialized)try{await server.sendToolListChanged();}catch{}};
  server.setNotificationHandler(InitializedNotificationSchema,async()=>{initialized=true;await notifyToolsChanged();});
  const ensureUpstream=async()=>{
    if(ready)return;
    if(connecting){await connecting;return;}
    if(Date.now()-lastAttempt<5000)return;
    lastAttempt=Date.now();
    const attempt=(async()=>{
      const nextClient=new Client({name:'opnex-project-adapter',version:'1.0.0'});
      const nextTransport=new StdioClientTransport({command,args,env:{...process.env,...configuredEnvValue} as Record<string,string>,stderr:'ignore'});
      client=nextClient;transport=nextTransport;
      try{
        await withAgentMemTimeout(nextClient.connect(nextTransport),upstreamTimeoutMs,'AgentMem connection');
        const projectResponse=unwrap(await withAgentMemTimeout(nextClient.callTool({name:'projects',arguments:{action:'list'}}),upstreamTimeoutMs,'AgentMem project verification'));
        const projects=projectResponse.projects||projectResponse.items||projectResponse.data?.projects;
        if(!Array.isArray(projects))throw new Error('AgentMem project list was invalid.');
        const source=(row:any)=>row?.source_root||row?.root||row?.cwd;
        const selected=projects.filter((row:any)=>row?.id===projectId),rootMatches=projects.filter((row:any)=>typeof source(row)==='string'&&sameProjectRoot(source(row),projectRoot));
        if(selected.length!==1||typeof source(selected[0])!=='string'||!sameProjectRoot(source(selected[0]),projectRoot)||rootMatches.length!==1||rootMatches[0].id!==projectId)throw new Error('The saved AgentMem project binding no longer matches this directory.');
        try{
          const repositoryResponse=unwrap(await withAgentMemTimeout(nextClient.callTool({name:'repository_list',arguments:{project_id:projectId}}),upstreamTimeoutMs,'AgentMem repository verification'));
          const repositories=Array.isArray(repositoryResponse?.repositories)?repositoryResponse.repositories:[];
          const matching=repositories.find((row:any)=>typeof row?.repository_id==='string'&&typeof row?.root==='string'&&sameProjectRoot(row.root,projectRoot));
          repositoryId=matching?.repository_id||'';
          if(configuredRepositoryId&&repositoryId!==configuredRepositoryId)throw new Error('The saved AgentMem repository identity no longer matches this directory.');
          status=repositoryId?'Connected to the selected project and its exact repository index.':'Connected to the selected project; no exact repository index is registered.';
        }catch(error){
          if(configuredRepositoryId)throw error;
          repositoryId='';status='Connected to the selected project; the optional repository index is unavailable.';
        }
        ready=true;
        await notifyToolsChanged();
      }catch{
        status='AgentMem is unavailable or the selected project identity could not be verified.';
        await closeUpstream(nextClient,nextTransport);
      }
    })();
    connecting=attempt;try{await attempt;}finally{if(connecting===attempt)connecting=undefined;}
  };
  server.setRequestHandler(ListToolsRequestSchema,async request=>{
    if(!ready||!client){
      if(!connecting)void ensureUpstream();
      return {tools:[{name:'agentmem_status',description:`Optional project knowledge is unavailable. ${status} Normal project work can continue.`,inputSchema:statusSchema}]};
    }
    const activeClient=client,activeTransport=transport;
    try{
      const response=await withAgentMemTimeout(activeClient.listTools(request.params?.cursor?{cursor:request.params.cursor}:{}),upstreamTimeoutMs,'AgentMem tool catalog');
      const tools=response.tools.filter(tool=>AGENTMEM_MODEL_TOOLS.has(tool.name)&&tool.name!=='projects'&&tool.name!=='repository_register'&&(!AGENTMEM_REPOSITORY_TOOLS.has(tool.name)||!!repositoryId));
      return {...response,tools:tools.map(tool=>({...tool,inputSchema:scopeAgentMemToolSchema(tool.inputSchema,tool.name,readOnlyAccess)}))};
    }catch{
      status='The optional AgentMem tool catalog is unavailable.';
      await closeUpstream(activeClient,activeTransport);
      return {tools:[{name:'agentmem_status',description:`Optional project knowledge is unavailable. ${status} Normal project work can continue.`,inputSchema:statusSchema}]};
    }
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const name=request.params?.name||'';
    if(name==='agentmem_status'){await ensureUpstream();return resultText({available:ready,projectId,projectRoot,status});}
    await ensureUpstream();
    if(!ready||!client)throw new Error(`Optional AgentMem is unavailable: ${status} Continue project work without it.`);
    const scoped=scopeAgentMemToolArgs(name,request.params?.arguments||{},projectId,repositoryId,projectRoot,readOnlyAccess);
    const activeClient=client,activeTransport=transport;
    try{return await withAgentMemTimeout(activeClient.callTool({name,arguments:scoped}),upstreamTimeoutMs,`AgentMem ${name} tool`);}
    catch(error){if(error instanceof AgentMemTimeoutError){status=`The optional AgentMem ${name} operation timed out.`;await closeUpstream(activeClient,activeTransport);}throw error;}
  });
  await server.connect(serverTransport);
  void ensureUpstream();
  const close=async()=>{try{await server.close();}catch{}try{await client?.close();}catch{}try{await transport?.close();}catch{}};
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
}

void main().catch(error=>{process.stderr.write(`Opnex AgentMem project adapter: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
