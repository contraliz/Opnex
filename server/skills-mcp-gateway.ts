import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createSkill, loadSkillForAgent, readSkillFile, searchSkillDescriptions, updateSkill } from './skill-library.js';
import { stateDirectory } from './paths.js';

const taskId=process.env.PSEUDOHARNESS_SKILLS_TASK_ID||'';
const role=process.env.PSEUDOHARNESS_SKILLS_ROLE||'';
async function currentPassId(){try{const state=JSON.parse(await readFile(path.join(stateDirectory(),'state.json'),'utf8'));const task=state.tasks?.find((item:any)=>item.id===taskId);return typeof task?.currentPassId==='string'?task.currentPassId:'';}catch{return '';}}
const server=new Server({name:'pseudoharness_skills',version:'1.0.0'},{capabilities:{tools:{listChanged:false}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:'skills_list',description:'List saved application skills by name, with a short description and immutable revision. Bodies are not included.',inputSchema:{type:'object',properties:{query:{type:'string',maxLength:200}},additionalProperties:false}},
  {name:'skills_search',description:'Search saved application skill names and descriptions. Returns concise matches and immutable revisions, without skill instructions.',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200},limit:{type:'integer',minimum:1,maximum:20}},required:['query'],additionalProperties:false}},
  {name:'skills_load',description:'Load the full instructions for one saved application skill by ID. Use only when relevant to this task; the result records the exact immutable revision and source for this pass.',inputSchema:{type:'object',properties:{skill_id:{type:'string',minLength:1,maxLength:100}},required:['skill_id'],additionalProperties:false}},
  {name:'skills_read_file',description:'Read one supporting file named by a loaded skill, pinned to that skill revision. Returns text when readable plus base64 bytes. It never runs the file.',inputSchema:{type:'object',properties:{skill_id:{type:'string',minLength:1,maxLength:100},revision:{type:'string',pattern:'^[a-f0-9]{64}$'},path:{type:'string',maxLength:240}},required:['skill_id','revision','path'],additionalProperties:false}},
  {name:'skills_save',description:'Save a new skill or update an existing skill in the shared application library. Saving never executes skill instructions or supporting files. Updates require the exact expected_revision from a prior load to prevent overwriting newer edits.',inputSchema:{type:'object',properties:{skill_id:{type:'string',minLength:1,maxLength:100},expected_revision:{type:'string',pattern:'^[a-f0-9]{64}$'},name:{type:'string',minLength:1,maxLength:120},description:{type:'string',maxLength:1000},instructions:{type:'string',minLength:1,maxLength:262144}},required:['name','description','instructions'],additionalProperties:false}},
]}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try{
    const passId=await currentPassId();if(!taskId||!passId||!['direct','simple','orchestrator','worker'].includes(role))throw new Error('The skills tool is not scoped to a current execution pass.');
    const args=request.params.arguments||{};
    if(request.params.name==='skills_list')return {content:[{type:'text',text:JSON.stringify(await searchSkillDescriptions(typeof args.query==='string'?args.query:'',20))}]};
    if(request.params.name==='skills_search')return {content:[{type:'text',text:JSON.stringify(await searchSkillDescriptions(String(args.query||''),Number(args.limit||10)))}]};
    if(request.params.name==='skills_load'){
      const raw=String(args.skill_id||'');const id=raw.startsWith('library:')?raw.slice(8):raw;
      const skill=await loadSkillForAgent(id,taskId,passId,role);
      return {content:[{type:'text',text:JSON.stringify({id:`library:${id}`,revision:skill.revision,name:skill.name,description:skill.description,source:skill.source,instructions:skill.instructions,files:skill.files,loaded_at:new Date().toISOString()})}]};
    }
    if(request.params.name==='skills_read_file'){const raw=String(args.skill_id||'');const id=raw.startsWith('library:')?raw.slice(8):raw;return {content:[{type:'text',text:JSON.stringify(await readSkillFile(id,String(args.revision||''),String(args.path||'')))}]};}
    if(request.params.name==='skills_save'){
      const skillId=typeof args.skill_id==='string'?args.skill_id.replace(/^library:/,''):'';
      let skill;
      if(skillId){if(typeof args.expected_revision!=='string')throw new Error('Updating a saved skill requires the revision returned by skills_load.');skill=await updateSkill(skillId,{name:args.name,description:args.description,instructions:args.instructions},args.expected_revision,{taskId,passId,role});}
      else skill=await createSkill({name:args.name,description:args.description,instructions:args.instructions,source:`Saved by Pseudoharness ${role} agent`},{taskId,passId,role});
      return {content:[{type:'text',text:JSON.stringify({id:`library:${skill.id}`,revision:skill.revision,name:skill.name,description:skill.description,source:skill.source,saved_at:new Date().toISOString()})}]};
    }
    throw new Error('Choose a supported skills tool.');
  }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Error?error.message:'The saved skill request failed.'}]};}
});
void server.connect(new StdioServerTransport()).catch(error=>{process.stderr.write(`Pseudoharness skills MCP: ${error instanceof Error?error.message:'startup failed'}\n`);process.exitCode=1;});
