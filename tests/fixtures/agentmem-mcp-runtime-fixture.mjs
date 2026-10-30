import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server=new Server({name:'isolated-agentmem-fixture',version:'1'},{capabilities:{tools:{listChanged:false}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'repository_search',description:'Temporary read-only package fixture',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  const {name,arguments:args}=request.params;
  if(name==='projects'&&args.action==='list')return {content:[{type:'text',text:JSON.stringify({projects:[{id:process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ID,source_root:process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT}]})}]};
  if(name==='repository_list')return {content:[{type:'text',text:JSON.stringify({repositories:[{repository_id:process.env.PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID,root:process.env.PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT}]})}]};
  return {content:[{type:'text',text:JSON.stringify(args)}]};
});
await server.connect(new StdioServerTransport());
