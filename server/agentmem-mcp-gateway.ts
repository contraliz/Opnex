import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport as StdioServer } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AGENTMEM_MODEL_TOOLS, scopeAgentMemToolArgs, scopeAgentMemToolSchema } from './agentmem-mcp-scope.js';

const projectId=process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ID||'';
const projectRoot=process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT||'';
const repositoryId=process.env.PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID||'';
const command=process.env.PSEUDOHARNESS_AGENTMEM_COMMAND||'';
const args=JSON.parse(process.env.PSEUDOHARNESS_AGENTMEM_ARGS||'[]') as string[];
async function main(){
  if(!projectId||!projectRoot||!repositoryId||!command||!Array.isArray(args))throw new Error('The selected AgentMem project/repository binding is incomplete.');
  const client=new Client({name:'pseudoharness-agentmem-scope',version:'1.0.0'});
  const childEnv={...process.env,AGENTMEM_DATA_DIR:process.env.PSEUDOHARNESS_AGENTMEM_DATA_DIR||process.env.AGENTMEM_DATA_DIR||''} as Record<string,string>;
  const clientTransport=new StdioClientTransport({command,args,env:childEnv,stderr:'ignore'});
  await client.connect(clientTransport);
  const server=new Server({name:'agentmem',version:'1.0.0'},{capabilities:{tools:{listChanged:false}}});
  server.setRequestHandler(ListToolsRequestSchema,async request=>{
    const response=await client.listTools(request.params?.cursor?{cursor:request.params.cursor}:{});
    return {...response,tools:response.tools.filter(tool=>AGENTMEM_MODEL_TOOLS.has(tool.name)).map(tool=>({...tool,inputSchema:scopeAgentMemToolSchema(tool.inputSchema,tool.name)}))};
  });
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const name=request.params?.name||'';
    const callArgs=scopeAgentMemToolArgs(name,request.params?.arguments||{},projectId,repositoryId);
    return client.callTool({name,arguments:callArgs});
  });
  const serverTransport=new StdioServer();
  await server.connect(serverTransport);
  const close=async()=>{try{await server.close();}catch{}try{await client.close();}catch{}};
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
}

void main().catch(error=>{process.stderr.write(`Pseudoharness AgentMem MCP gateway: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
