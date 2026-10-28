import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
  if(path.basename(root).toLowerCase()==='resources'&&entries.some(entry=>entry.name==='pseudoharness-node'&&entry.isDirectory()))return root;
  for(const entry of entries){if(entry.isDirectory()){const found=await findPackagedResources(path.join(root,entry.name),depth+1);if(found)return found;}}
}
const packagedResources=process.env.PSEUDOHARNESS_PACKAGED_RESOURCES||await findPackagedResources(path.join(repositoryRoot,'desktop-release'));
if(!packagedResources)throw new Error('No packaged app Resources folder with the bundled helper runtime was found.');
const resourcesPath=path.resolve(packagedResources);
process.env.PSEUDOHARNESS_PACKAGED_APP='1';process.env.PSEUDOHARNESS_RESOURCES_PATH=resourcesPath;
const temp=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-mcp-package-smoke-'));
const data=path.join(temp,'app-data'),taskId='packaged-smoke-task',passId='packaged-smoke-pass';
await mkdir(data,{recursive:true});await writeFile(path.join(data,'state.json'),JSON.stringify({tasks:[{id:taskId,currentPassId:passId}]}));process.env.PSEUDOHARNESS_DATA_DIR=data;
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
  const target=`${process.platform}-${process.arch}`,packagedNode=path.join(resourcesPath,'pseudoharness-node',target,process.platform==='win32'?'node.exe':'node');
  if(config.command!==packagedNode)throw new Error(`The packaged skills server did not resolve to the staged ${target} Node executable.`);
  const {client}=await connect(config);
  try{
    const tools=await client.listTools();
    const blocked=await client.callTool({name:'skills_save',arguments:{name:'Unauthorized packaged task skill',description:'Must be rejected',instructions:'This task agent cannot save this body.'}});
    const [search,list,loaded,afterSave,taskSaves]=await Promise.all([
      client.callTool({name:'skills_search',arguments:{query:'Temporary isolated packaging'}}),
      client.callTool({name:'skills_list',arguments:{query:'Packaged runtime'}}),
      client.callTool({name:'skills_load',arguments:{skill_id:skill.id}}),
      getSkill(skill.id),
      recordedSkillSaves(taskId,passId),
    ]);
    const searchText=JSON.stringify(search),listText=JSON.stringify(list),loadText=JSON.stringify(loaded),blockedText=blocked.content?.map(block=>block.text||'').join('\n')||'';
    const expected=['skills_list','skills_search','skills_load','skills_read_file'];
    const unauthorizedSaveRejected=blocked.isError===true&&blockedText.includes('Task agents cannot write the shared saved-skills library')&&!tools.tools.some(tool=>tool.name==='skills_save')&&afterSave.revision===skill.revision&&taskSaves.length===0;
    const verified=expected.every(name=>tools.tools.some(tool=>tool.name===name))&&searchText.includes(skill.id)&&listText.includes(skill.revision)&&loadText.includes(skill.revision)&&loadText.includes('This synthetic body exists only inside this temporary smoke-test profile.')&&unauthorizedSaveRejected;
    console.log(JSON.stringify({helper:'skills',command:config.command,tools:tools.tools.map(tool=>tool.name),revision:skill.revision,searchPassed:searchText.includes(skill.id),listPassed:listText.includes(skill.revision),loadPassed:loadText.includes('This synthetic body exists only inside this temporary smoke-test profile.'),unauthorizedSaveRejected,verified}));
    if(!verified)failures++;
  }finally{await client.close();}

  const modulePath=path.join(repositoryRoot,'dist-server','agentmem.js');
  const launch=resolveMcpHelperLaunch({modulePath,helperFile:'agentmem-mcp-gateway.js',platform:process.platform,arch:process.arch,packaged:true,resourcesPath});
  const fixture=path.join(repositoryRoot,'tests','fixtures','agentmem-mcp-runtime-fixture.mjs');
  const agentmemEnv={PSEUDOHARNESS_AGENTMEM_PROJECT_ID:'isolated-project',PSEUDOHARNESS_AGENTMEM_PROJECT_ROOT:repositoryRoot,PSEUDOHARNESS_AGENTMEM_REPOSITORY_ID:'isolated-repository',PSEUDOHARNESS_AGENTMEM_COMMAND:process.execPath,PSEUDOHARNESS_AGENTMEM_ARGS:JSON.stringify([fixture]),PSEUDOHARNESS_AGENTMEM_DATA_DIR:data};
  const {client:agentmem}=await connect(launch,agentmemEnv);
  try{
    const tools=await agentmem.listTools(),result=await agentmem.callTool({name:'repository_search',arguments:{query:'runtime helper'}});
    const returned=JSON.parse(result.content.find(block=>block.type==='text').text);
    const verified=tools.tools.some(tool=>tool.name==='repository_search')&&returned.project_id==='isolated-project'&&returned.repository_id==='isolated-repository'&&returned.query==='runtime helper';
    console.log(JSON.stringify({helper:'project-index-gateway',command:launch.command,tools:tools.tools.map(tool=>tool.name),scopedReadReturned:returned,verified}));
    if(!verified)failures++;
  }finally{await agentmem.close();}
}catch(error){console.error(error);failures++;}
finally{closeSkillLibrary();await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
if(failures)process.exitCode=1;
