import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server=new Server({name:'isolated-agentmem-fixture',version:'1'},{capabilities:{tools:{listChanged:false}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'repository_search',description:'Temporary read-only package fixture',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:'text',text:JSON.stringify(request.params.arguments)}]}));
await server.connect(new StdioServerTransport());
