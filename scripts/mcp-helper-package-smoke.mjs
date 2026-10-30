import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSkillLibrary, createSkill, getSkill, recordedSkillSaves } from '../dist-server/skill-library.js';
import { resolveMcpHelperLaunch } from '../dist-server/mcp-helper-runtime.js';
import { skillLibraryMcpServerConfig } from '../dist-server/skill-library-mcp-config.js';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function findPackagedResources(root,depth=0){
  if(depth>6)return undefined;
  let entries;try{entries=await readdir(root,{withFileTypes:true});}catch{return undefined;}
  if(path.basename(root).toLowerCase()==='resources'&&entries.some(entry=>['opnex-node','pseudoharness-node'].includes(entry.name)&&entry.isDirectory()))return root;
  for(const entry of entries){if(entry.isDirectory()){const found=await findPackagedResources(path.join(root,entry.name),depth+1);if(found)return found;}}
}
const packagedResources=process.env.OPNEX_PACKAGED_RESOURCES||process.env.PSEUDOHARNESS_PACKAGED_RESOURCES||await findPackagedResources(path.join(repositoryRoot,'desktop-release'));
if(!packagedResources)throw new Error('No packaged app Resources folder with the bundled helper runtime was found.');
const resourcesPath=path.resolve(packagedResources);
process.env.OPNEX_PACKAGED_APP='1';process.env.PSEUDOHARNESS_PACKAGED_APP='1';process.env.OPNEX_RESOURCES_PATH=resourcesPath;process.env.PSEUDOHARNESS_RESOURCES_PATH=resourcesPath;
const temp=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-mcp-package-smoke-'));
const data=path.join(temp,'app-data'),taskId='packaged-smoke-task',passId='packaged-smoke-pass';
await mkdir(data,{recursive:true});await writeFile(path.join(data,'state.json'),JSON.stringify({tasks:[{id:taskId,currentPassId:passId,phase:'direct_running',activeRole:'direct',activeTurnId:'packaged-smoke-turn',passes:[{id:passId,phase:'direct_running',activeRole:'direct',activeTurnId:'packaged-smoke-turn'}]}]}));process.env.OPNEX_DATA_DIR=data;process.env.PSEUDOHARNESS_DATA_DIR=data;
const inheritedEnv=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','HOME'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));

async function connect(config,extraEnv={}){
  if('ELECTRON_RUN_AS_NODE' in {...config.env,...extraEnv})throw new Error('Packaged helpers must not depend on Electron RunAsNode.');
  const transport=new StdioClientTransport({command:config.command,args:config.args,cwd:config.cwd,env:{...inheritedEnv,...config.env,...extraEnv},stderr:'pipe'});
  transport.stderr?.on('data',chunk=>process.stderr.write(`packaged helper: ${chunk}`));
  const client=new Client({name:'pseudoharness-packaged-helper-smoke',version:'1'});
  await client.connect(transport);return {client,transport};
}

let failures=0;
try{
  const skill=await createSkill({name:'Packaged runtime smoke skill',description:'Temporary isolated packaging check',instructions:'This synthetic body exists only inside this temporary smoke-test profile.',source:'Packaged smoke fixture'});
  const config=skillLibraryMcpServerConfig({taskId,role:'direct'});
  const target=`${process.platform}-${process.arch}`,runtimeRoot=['opnex-node','pseudoharness-node'].map(name=>path.join(resourcesPath,name,target,process.platform==='win32'?'node.exe':'node')).find(file=>existsSync(file));
  if(!runtimeRoot)throw new Error(`No Opnex helper runtime was found for ${target}.`);
  const packagedNode=runtimeRoot;
  if(config.command!==packagedNode)throw new Error(`The packaged skills server did not resolve to the staged ${target} Node executable.`);
  const {client}=await connect(config);
  try{
    const tools=await client.listTools();
    const saved=await client.callTool({name:'skills_save',arguments:{skill_id:skill.id,expected_revision:skill.revision,name:skill.name,description:'Temporary isolated packaging updated by the active task',instructions:'This revision was saved through the task-scoped helper.'}});
    const stale=await client.callTool({name:'skills_save',arguments:{skill_id:skill.id,expected_revision:skill.revision,name:skill.name,description:'Stale packaged overwrite',instructions:'This stale revision must not replace the saved one.'}});
    const [search,list,loaded,afterSave,taskSaves]=await Promise.all([
      client.callTool({name:'skills_search',arguments:{query:'Temporary isolated packaging'}}),
      client.callTool({name:'skills_list',arguments:{query:'Packaged runtime'}}),
      client.callTool({name:'skills_load',arguments:{skill_id:skill.id}}),
      getSkill(skill.id),
      recordedSkillSaves(taskId,passId),
    ]);
    const searchText=JSON.stringify(search),listText=JSON.stringify(list),loadText=JSON.stringify(loaded),staleText=stale.content?.map(block=>block.text||'').join('\n')||'';
    const expected=['skills_list','skills_search','skills_load','skills_read_file','skills_save'];
    const savePassed=saved.isError!==true&&afterSave.revision!==skill.revision&&JSON.stringify(saved).includes(afterSave.revision)&&taskSaves.some(row=>row.skillId===skill.id&&row.revision===afterSave.revision&&row.role==='direct'&&row.action==='update');
    const staleRejected=stale.isError===true&&staleText.includes('changed since it was loaded')&&afterSave.revision!==skill.revision;
    const verified=expected.every(name=>tools.tools.some(tool=>tool.name===name))&&searchText.includes(skill.id)&&listText.includes(afterSave.revision)&&loadText.includes(afterSave.revision)&&loadText.includes('This revision was saved through the task-scoped helper.')&&savePassed&&staleRejected;
    console.log(JSON.stringify({helper:'skills',command:config.command,tools:tools.tools.map(tool=>tool.name),revision:afterSave.revision,searchPassed:searchText.includes(skill.id),listPassed:listText.includes(afterSave.revision),loadPassed:loadText.includes('This revision was saved through the task-scoped helper.'),savePassed,staleRejected,verified}));
    if(!verified)failures++;
  }finally{await client.close();}

  const modulePath=path.join(repositoryRoot,'dist-server','agentmem.js');
  const launch=resolveMcpHelperLaunch({modulePath,helperFile:'agentmem-mcp-gateway.js',platform:process.platform,arch:process.arch,packaged:true,resourcesPath});
  const fixture=path.join(repositoryRoot,'tests','fixtures','agentmem-mcp-runtime-fixture.mjs');
  const agentmemEnv={PSEUDOHARNESS_AGENTMEM_PROJECT_ID:'isolated-project',PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT:repositoryRoot,PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID:'isolated-repository',PSEUDOHARNESS_AGENTMEM_COMMAND:process.execPath,PSEUDOHARNESS_AGENTMEM_ARGS:JSON.stringify([fixture]),PSEUDOHARNESS_AGENTMEM_DATA_DIR:data};
  const {client:agentmem}=await connect(launch,agentmemEnv);
  try{
    const statusResult=await agentmem.callTool({name:'agentmem_status',arguments:{}}),status=JSON.parse(statusResult.content.find(block=>block.type==='text').text);
    if(status.available!==true||status.projectId!=='isolated-project'||status.projectRoot!==repositoryRoot)throw new Error(`The packaged AgentMem gateway did not verify its selected project identity: ${JSON.stringify(status)}`);
    const tools=await agentmem.listTools(),result=await agentmem.callTool({name:'repository_search',arguments:{query:'runtime helper'}});
    const returned=JSON.parse(result.content.find(block=>block.type==='text').text);
    const verified=status.available===true&&tools.tools.some(tool=>tool.name==='repository_search')&&returned.project_id==='isolated-project'&&returned.repository_id==='isolated-repository'&&returned.query==='runtime helper';
    console.log(JSON.stringify({helper:'project-index-gateway',command:launch.command,identityVerified:status.available,tools:tools.tools.map(tool=>tool.name),scopedReadReturned:returned,verified}));
    if(!verified)failures++;
  }finally{await agentmem.close();}
}catch(error){console.error(error);failures++;}
finally{closeSkillLibrary();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
if(failures)process.exitCode=1;
