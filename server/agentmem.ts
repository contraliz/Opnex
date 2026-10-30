import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { resolveMcpHelperLaunch } from './mcp-helper-runtime.js';
import { AGENTMEM_MODEL_READ_TOOLS, AGENTMEM_MODEL_TOOLS } from './agentmem-mcp-scope.js';
import { sameProjectRoot } from './project-identity.js';

export type AgentMemProject={id:string;name:string;description?:string;sourceRoot:string;memoryDirectory?:string};
type AgentMemCommand={command:string;args:string[];env:Record<string,string>};

function responseValue(result:any){
  if(result.isError)throw new Error(result.content?.map((item:any)=>item.text||'').join('\n')||'AgentMem operation failed.');
  const text=result.content?.find((item:any)=>item.type==='text')?.text;
  if(text){try{const parsed=JSON.parse(text);if(parsed?.ok===false)throw new Error(parsed.error?.reason||'AgentMem operation failed.');return parsed;}catch(error){if(error instanceof Error&&error.message!=='Unexpected end of JSON input')throw error;}}
  return result.structuredContent||result;
}

async function withTimeout<T>(promise:Promise<T>,milliseconds:number,label:string){
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out.`)),milliseconds);})]);}
  finally{if(timer)clearTimeout(timer);}
}

export class AgentMem {
  private client?:Client;
  private transport?:StdioClientTransport;
  private connecting?:Promise<void>;
  private command?:AgentMemCommand;

  async configure(){
    const codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
    let source:string;
    try{source=await readFile(path.join(codexHome,'config.toml'),'utf8');}
    catch(error){throw new Error('Could not read Codex config.toml: '+safeError(error));}
    let config:Record<string,unknown>;
    try{config=parseToml(source) as Record<string,unknown>;}
    catch(error){throw new Error('Could not parse Codex config.toml: '+safeError(error));}
    const servers=config.mcp_servers;
    const server=servers&&typeof servers==='object'&&!Array.isArray(servers)?(servers as Record<string,unknown>).agentmem:undefined;
    if(!server||typeof server!=='object'||Array.isArray(server))throw new Error('Codex config.toml must define [mcp_servers.agentmem] as a table.');
    const entry=server as Record<string,unknown>;
    if(typeof entry.command!=='string'||!entry.command.trim())throw new Error('Codex config.toml [mcp_servers.agentmem] requires a non-empty string command.');
    const args=entry.args===undefined?[]:entry.args;
    if(!Array.isArray(args)||!args.every(value=>typeof value==='string'))throw new Error('Codex config.toml [mcp_servers.agentmem].args must be an array of strings when provided.');
    const configuredEnv=entry.env===undefined?{}:entry.env;
    if(!configuredEnv||typeof configuredEnv!=='object'||Array.isArray(configuredEnv)||Object.entries(configuredEnv).some(([key,value])=>!key.trim()||typeof value!=='string'))throw new Error('Codex config.toml [mcp_servers.agentmem.env] must contain only named string values.');
    const env={...(configuredEnv as Record<string,string>)};
    for(const key of Object.keys(env))if(typeof process.env[key]==='string')env[key]=process.env[key]!;
    for(const key of ['AGENTMEM_DATA_DIR','AGENTMEM_MEMORY_ROOT'])if(typeof process.env[key]==='string')env[key]=process.env[key]!;
    this.command={command:entry.command.trim(),args:args as string[],env};
  }

  async modelMcpServerConfig(projectId:string,workspaceRoot:string,readOnly=false){
    if(!projectId||!workspaceRoot||!path.isAbsolute(workspaceRoot))throw new Error('Choose an AgentMem project and an absolute project directory before exposing project knowledge to a model.');
    if(!this.command)throw new Error('Configure the optional AgentMem MCP service before connecting it to this project.');
    const modulePath=fileURLToPath(import.meta.url),launch=resolveMcpHelperLaunch({modulePath,helperFile:modulePath.endsWith('.ts')?'agentmem-mcp-gateway.ts':'agentmem-mcp-gateway.js'});
    const values={PROJECT_ID:projectId,PROJECT_ROOT:path.resolve(workspaceRoot),REPOSITORY_ID:'',ACCESS:readOnly?'read-only':'read-write',COMMAND:this.command.command,ARGS:JSON.stringify(this.command.args),CONFIG_ENV:JSON.stringify(this.command.env)};
    const env=Object.fromEntries(Object.entries(values).flatMap(([key,value])=>[[`OPNEX_AGENTMEM_${key}`,value],[`PSEUDOHARNESS_AGENTMEM_${key}`,value]]));
    return {command:launch.command,args:launch.args,cwd:launch.cwd,enabled:true,enabled_tools:[...(readOnly?AGENTMEM_MODEL_READ_TOOLS:AGENTMEM_MODEL_TOOLS)],env};
  }

  async verifyProjectBinding(projectId:string,expectedRoot:string):Promise<AgentMemProject>{
    const projects=await this.listProjects(),byId=projects.find(project=>project.id===projectId),byRoot=projects.filter(project=>sameProjectRoot(project.sourceRoot,expectedRoot));
    if(!byId)throw new Error(`AgentMem project "${projectId}" is not registered.`);
    if(!sameProjectRoot(byId.sourceRoot,expectedRoot))throw new Error('AgentMem project root does not match the selected project directory.');
    if(byRoot.length>1)throw new Error('More than one AgentMem project is registered for this directory. Resolve that service conflict before connecting.');
    if(byRoot[0]&&byRoot[0].id!==projectId)throw new Error(`This directory is already registered as AgentMem project "${byRoot[0].id}". Opnex will not rebind it.`);
    return byId;
  }

  async createProjectBinding(projectId:string,expectedRoot:string,description=''){
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectId))throw new Error('The proposed AgentMem project ID is invalid.');
    const projects=await this.listProjects();
    if(projects.some(project=>project.id===projectId))throw new Error(`AgentMem project "${projectId}" already exists. Discover and select its exact directory binding instead.`);
    const sameRoot=projects.find(project=>sameProjectRoot(project.sourceRoot,expectedRoot));
    if(sameRoot)throw new Error(`This directory is already registered as AgentMem project "${sameRoot.id}". Select that existing project.`);
    await this.call('projects',{action:'register',project_id:projectId,root:path.resolve(expectedRoot),description});
    return this.verifyProjectBinding(projectId,expectedRoot);
  }

  async listProjects():Promise<AgentMemProject[]>{
    const response=await this.call('projects',{action:'list'});
    const rows=Array.isArray(response)?response:response?.projects||response?.items||response?.data?.projects;
    if(!Array.isArray(rows))throw new Error('AgentMem project list did not contain a projects array.');
    return rows.flatMap((row:any)=>{
      if(!row||typeof row.id!=='string'||!row.id.trim())return [];
      const sourceRoot=row.source_root||row.root||row.cwd;
      if(typeof sourceRoot!=='string'||!sourceRoot.trim())return [];
      const memoryRoot=row.memory_root||row.memoryRoot;
      return [{id:row.id,name:typeof row.name==='string'&&row.name.trim()?row.name:row.id,...(typeof row.description==='string'&&row.description?{description:row.description}:{}),sourceRoot,...(typeof memoryRoot==='string'&&memoryRoot.trim()?{memoryDirectory:path.basename(memoryRoot)}:{})}];
    }).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.id.localeCompare(b.id));
  }

  private async ensureConnected(){
    if(this.connecting){await this.connecting;return;}
    if(this.client&&this.transport)return;
    const operation=this.openConnection();this.connecting=operation;
    try{await operation;}finally{if(this.connecting===operation)this.connecting=undefined;}
  }

  private async openConnection(){
    if(!this.command)await this.configure();
    const config=this.command!;
    const client=new Client({name:'opnex-project-settings',version:'1.0.0'});
    const inherited=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
    const transport=new StdioClientTransport({command:config.command,args:config.args,env:{...inherited,...config.env},stderr:'ignore'});
    this.client=client;this.transport=transport;
    transport.onclose=()=>this.invalidate(client,transport);
    transport.onerror=()=>this.invalidate(client,transport);
    try{
      await withTimeout(client.connect(transport),5000,'AgentMem connection');
      if(this.client!==client)throw new Error('AgentMem connection closed during startup.');
    }catch(error){this.invalidate(client,transport);try{await transport.close();}catch{}throw error;}
  }

  private invalidate(client?:Client,transport?:StdioClientTransport){
    if(client&&this.client!==client||transport&&this.transport!==transport)return;
    this.client=undefined;this.transport=undefined;
    if(transport)void transport.close().catch(()=>{});
  }

  private async call(name:string,args:Record<string,unknown>){
    await this.ensureConnected();
    const client=this.client;if(!client)throw new Error('AgentMem connection is unavailable.');
    try{return responseValue(await withTimeout(client.callTool({name,arguments:args}),10000,`AgentMem ${name}`));}
    catch(error){if(/timed out|connection closed|transport closed|not connected|client is closed|process exited|broken pipe|\bEPIPE\b|\bECONNRESET\b/i.test(error instanceof Error?error.message:String(error)))this.invalidate(client,this.transport);throw error;}
  }

  close(){this.invalidate(this.client,this.transport);}
}

export function safeError(error:unknown){return (error instanceof Error?error.message:String(error)).replace(/(?:[A-Z]:\\[^\s]+|\/[^\s]+\.toml)/gi,'[local path]').slice(0,500);}
