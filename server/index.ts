import express from 'express';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChildDirectory, listDirectories, validateProjectDirectory } from './directories.js';
import { errorMessage } from './errors.js';
import { loadState, getState, mutate, getTask, subscribe, renameTaskInState, deleteTaskInState, moveTaskProjectInState, noteTaskInteractionInState, saveProjectInState, selectProjectInState, pauseActiveTasksForKernelShutdown } from './state.js';
import { readWorkspaceGitSnapshot } from './git.js';
import { cancelTask, getRuntimeStatus, initialize, pauseQualityLoop, refreshConnections, resolveApproval, resumeQualityLoop, saveSettings, submitEscalationDecision, submitTask, acceptQualityFindings, shutdown } from './orchestrator.js';
import { approvalDecisionSchema, sessionTitleSchema, settingsSchema, userTaskSchema } from './contracts.js';
import { readGitHubWorkspace } from './github.js';
import { readGitHubMetadata, readGitWorkspace } from './git-workspace.js';
import { GitHubAuthService } from './github-auth.js';
import { archiveSkill, createSkill, getSkill, importSkillPackage, listSkills, updateSkill } from './skill-library.js';
import { searchConfiguredSkills } from './worker-staging.js';
import { z } from 'zod';
import { acquireStateDirectoryOwner, StateDirectoryInUseError, type StateDirectoryOwner } from './state-owner.js';
import { createKernelInstanceRecord, KERNEL_PROTOCOL_VERSION, removeKernelInstanceIfOwned, type KernelInstanceRecord, writeKernelInstance } from './kernel-instance.js';
import { assertTaskCanResumeInProject, sameProjectRoot } from './project-identity.js';
const app=express();const server=createServer(app);const port=Number(process.env.PORT||4174);let boundPort=port;const host='127.0.0.1';const version=createRequire(import.meta.url)('../package.json').version as string;
const githubAuth=new GitHubAuthService();
const nonce=randomBytes(24).toString('base64url');
const here=path.dirname(fileURLToPath(import.meta.url));
const production=process.env.NODE_ENV==='production';
const startupSecret=process.env.OPNEX_STARTUP_SECRET??process.env.PSEUDOHARNESS_STARTUP_SECRET;
const kernelStartupSecret=startupSecret||randomBytes(32).toString('hex');
let stateLoadError:string|undefined;
let stateOwnershipError:string|undefined;
let stateOwnershipCode:string|undefined;
let stateOwner:StateDirectoryOwner|undefined;
let kernelInstance:KernelInstanceRecord|undefined;
let runtimeInitialization:Promise<void>|undefined;
let shuttingDown=false;
let shutdownRequested=false;
const eventStreams=new Set<{response:express.Response;unsubscribe:()=>void;heartbeat:NodeJS.Timeout}>();
function initializeRuntime(){if(process.env.NODE_ENV==='test')return runtimeInitialization??=Promise.resolve();return runtimeInitialization??=initialize();}
app.disable('x-powered-by');app.use(express.json({limit:'17mb'}));
function isLoopbackHost(raw:string|undefined){if(!raw)return false;const v=raw.split(':')[0].replace(/^\[|\]$/g,'').toLowerCase();return ['127.0.0.1','localhost','::1'].includes(v);}
function requestedProject(req:express.Request){const id=req.query.projectId;if(typeof id!=="string"||!id)throw new Error("Choose a project before opening its workspace.");const project=getState().projects.find(row=>row.id===id);if(!project)throw new Error("Project not found.");if(project.needsLocation)throw new Error("Choose a current working directory for this project first.");return project;}
function projectForTask(taskId:string){const task=getTask(taskId);if(!task)throw new Error("Session not found.");if(!task.projectId)throw new Error("This is unclassified history. Choose a project and start a new session to work.");const project=getState().projects.find(row=>row.id===task.projectId);if(!project||project.needsLocation)throw new Error("This session’s project directory needs to be restored before workspace access.");assertTaskCanResumeInProject(task,project);return {task,project};}
app.use((req,res,next)=>{if(!isLoopbackHost(req.headers.host)){res.status(403).json({error:'Loopback host required.'});return;}const origin=req.headers.origin;const allowed=!origin||origin==='http://127.0.0.1:5173'||origin==='http://localhost:5173'||origin===`http://127.0.0.1:${boundPort}`||origin===`http://localhost:${boundPort}`;if(!allowed){res.status(403).json({error:'Request origin rejected.'});return;}const versionHeader=req.get('x-pseudoharness-protocol-version');const versionedPath=req.originalUrl.split('?')[0].startsWith('/api/v1/');const eventQuery=versionedPath&&req.method==='GET'?req.query.protocol:undefined;const suppliedVersion=versionHeader??(typeof eventQuery==='string'?eventQuery:undefined);if((versionedPath&&suppliedVersion!==String(KERNEL_PROTOCOL_VERSION))||(suppliedVersion!==undefined&&suppliedVersion!==String(KERNEL_PROTOCOL_VERSION))){res.status(426).json({error:'The client and Opnex kernel use different protocol versions. Reload with a matching Opnex client.',code:'PROTOCOL_VERSION_MISMATCH',supportedProtocolVersion:KERNEL_PROTOCOL_VERSION});return;}if(shuttingDown||shutdownRequested){res.setHeader('Connection','close');res.status(503).json({error:'Opnex kernel is shutting down.',code:'KERNEL_SHUTTING_DOWN'});return;}next();});
const versionedControlPaths=new Set(['/api/v1/info','/api/v1/snapshot','/api/v1/events','/api/v1/kernel/shutdown']);
app.use((req,_res,next)=>{const originalPath=req.originalUrl.split('?')[0];if(originalPath.startsWith('/api/v1/')&&!versionedControlPaths.has(originalPath))req.url=req.url.replace(/^\/api\/v1(?=\/|$)/,'/api');next();});
app.use('/api',(req,res,next)=>{if(!isLoopbackHost(req.headers.host)){res.status(403).json({error:'Loopback host required.'});return;}if(req.method!=='GET'&&req.method!=='HEAD'){
  const origin=req.headers.origin;const allowed=!origin||origin==='http://127.0.0.1:5173'||origin==='http://localhost:5173'||origin===`http://127.0.0.1:${boundPort}`||origin===`http://localhost:${boundPort}`;
  if(!allowed||req.get('x-pseudoharness-token')!==nonce){res.status(403).json({error:'Local request origin or session token rejected.'});return;}
}if(stateOwnershipError&&req.path!=='/health'){res.status(503).json({error:stateOwnershipError,code:stateOwnershipCode});return;}next();});
app.get('/api/bootstrap',async(_req,res)=>{try{await loadState();stateLoadError=undefined;void initializeRuntime();res.json({state:getState(),runtime:getRuntimeStatus(),csrf:nonce});}catch(e){stateLoadError=errorMessage(e);res.status(503).json({error:stateLoadError,code:'STATE_UNAVAILABLE'});}});
app.get('/api/state',async(_req,res)=>{try{await loadState();stateLoadError=undefined;void initializeRuntime();res.json({state:getState(),runtime:getRuntimeStatus()});}catch(e){stateLoadError=errorMessage(e);res.status(503).json({error:stateLoadError,code:'STATE_UNAVAILABLE'});}});
function kernelSnapshot(csrf?:string){const state=getState();return {protocolVersion:KERNEL_PROTOCOL_VERSION,kernelInstanceId:kernelInstance?.instanceId||'',cursor:state.revision,state,runtime:getRuntimeStatus(),...(csrf?{csrf}:{})};}
app.get('/api/v1/info',(_req,res)=>res.json({protocol:'pseudoharness.kernel',protocolVersion:KERNEL_PROTOCOL_VERSION,kernelInstanceId:kernelInstance?.instanceId||'',stateRevision:getState().revision,host,port:boundPort}));
app.get('/api/v1/snapshot',async(_req,res)=>{try{await loadState();stateLoadError=undefined;void initializeRuntime();res.setHeader('X-Pseudoharness-Protocol-Version',String(KERNEL_PROTOCOL_VERSION));res.json(kernelSnapshot(nonce));}catch(e){stateLoadError=errorMessage(e);res.status(503).json({error:stateLoadError,code:'STATE_UNAVAILABLE'});}});
const projectSchema=z.object({id:z.string().uuid(),name:z.string().trim().min(1).max(80),projectRoot:z.string().trim().min(1).max(1024),pinned:z.boolean().default(false)}).strict();
app.post('/api/projects',async(req,res)=>{try{const body=projectSchema.parse(req.body);const {resolveProjectDirectory}=await import('./directories.js');const projectRoot=await resolveProjectDirectory(body.projectRoot);const duplicate=getState().projects.find(row=>sameProjectRoot(row.projectRoot,projectRoot));if(duplicate&&duplicate.id!==body.id){res.json({project:duplicate,duplicate:true});return;}let project:any;await mutate(state=>{project=saveProjectInState(state,{...body,projectRoot,needsLocation:false});if(!state.selectedProjectId)state.selectedProjectId=project.id;if(!state.expandedProjectIds.includes(project.id))state.expandedProjectIds.push(project.id);});res.json({project,duplicate:false});}catch(e){const message=errorMessage(e);res.status(message.startsWith('Finish or stop')?409:400).json({error:message});}});
app.post('/api/projects/select',async(req,res)=>{try{const body=z.object({projectId:z.string().uuid().nullable()}).strict().parse(req.body);await mutate(state=>{selectProjectInState(state,body.projectId);});res.json({ok:true,projectId:body.projectId});}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/projects/:id/expanded',async(req,res)=>{try{const body=z.object({expanded:z.boolean()}).strict().parse(req.body);const id=req.params.id;if(id!=='unclassified'&&!z.string().uuid().safeParse(id).success)throw new Error('Project not found.');await mutate(state=>{if(id!=='unclassified'&&!state.projects.some(project=>project.id===id))throw new Error('Project not found.');state.expandedProjectIds=body.expanded?[...new Set([...state.expandedProjectIds,id])]:state.expandedProjectIds.filter(value=>value!==id);});res.json({ok:true});}catch(e){const message=errorMessage(e);res.status(message==='Project not found.'?404:400).json({error:message});}});
app.post('/api/projects/:id/pin',async(req,res)=>{try{const body=z.object({pinned:z.boolean()}).strict().parse(req.body);let project:any;await mutate(state=>{const current=state.projects.find(row=>row.id===req.params.id);if(!current)throw new Error('Project not found.');project=saveProjectInState(state,{...current,pinned:body.pinned});});res.json(project);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/project',async(req,res)=>{try{const body=z.object({projectId:z.string().uuid().nullable()}).strict().parse(req.body);let task:any;await mutate(state=>{task=moveTaskProjectInState(state,req.params.id,body.projectId);const expandId=body.projectId||'unclassified';if(!state.expandedProjectIds.includes(expandId))state.expandedProjectIds.push(expandId);if(state.activeTaskId===task.id)selectProjectInState(state,body.projectId);});res.json(task);}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'||message==='Project not found.'?404:message.startsWith('Stop or finish')?409:400).json({error:message});}});
app.get('/api/skills',async(req,res)=>{try{const query=typeof req.query.q==='string'?req.query.q:'';const limit=typeof req.query.limit==='string'&&/^\d+$/.test(req.query.limit)?Number(req.query.limit):undefined;let projectRoot:string|undefined;if(req.query.source==='codex'&&typeof req.query.projectId==='string'){const project=getState().projects.find(row=>row.id===req.query.projectId);if(!project)throw new Error('Project not found.');if(project.needsLocation)throw new Error('Restore this project’s working directory before searching project skills.');projectRoot=project.projectRoot;}res.json({skills:req.query.source==='codex'?await searchConfiguredSkills(query,undefined,projectRoot):await listSkills(query,req.query.archived==='1',limit)});}catch(e){res.status(503).json({error:errorMessage(e)});}});
const skillInput=z.object({name:z.string().max(120),description:z.string().max(1000).default(''),instructions:z.string().max(256*1024),source:z.string().max(500).optional(),files:z.array(z.object({path:z.string().max(240),content:z.string().max(3*1024*1024)}).strict()).max(128).optional()}).strict();
app.post('/api/skills',async(req,res)=>{try{res.status(201).json({skill:await createSkill(skillInput.parse(req.body))});}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/skills/import',async(req,res)=>{try{const body=z.object({source:z.string().max(300).optional(),files:z.array(z.object({path:z.string().max(240),content:z.string().max(3*1024*1024)}).strict()).min(1).max(128)}).strict().parse(req.body);res.status(201).json({skill:await importSkillPackage(body.files,body.source)});}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.get('/api/skills/:id',async(req,res)=>{try{res.json({skill:await getSkill(req.params.id,req.query.archived==='1')});}catch(e){res.status(404).json({error:errorMessage(e)});}});
app.put('/api/skills/:id',async(req,res)=>{try{const body=z.object({name:z.string().max(120),description:z.string().max(1000).default(''),instructions:z.string().max(256*1024),source:z.string().max(500).optional(),files:z.array(z.object({path:z.string().max(240),content:z.string().max(3*1024*1024)}).strict()).max(128).optional(),expectedRevision:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(req.body);const {expectedRevision,...input}=body;res.json({skill:await updateSkill(req.params.id,input,expectedRevision)});}catch(e){const message=errorMessage(e);res.status(message==='Saved skill not found.'||message==='Saved skill not found or archived.'?404:400).json({error:message});}});
app.post('/api/skills/:id/archive',async(req,res)=>{try{const body=z.object({archived:z.boolean()}).strict().parse(req.body);res.json({skill:await archiveSkill(req.params.id,body.archived)});}catch(e){res.status(404).json({error:errorMessage(e)});}});
app.get('/api/tasks/:id/git',async(req,res)=>{try{const {project}=projectForTask(req.params.id);res.json(await readWorkspaceGitSnapshot(project.projectRoot));}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:409).json({error:message});}});
app.get('/api/git-workspace',async(req,res)=>{try{const project=requestedProject(req),offset=Number(req.query.offset||0),branchOffset=Number(req.query.branchOffset||0);res.json(await readGitWorkspace(project.projectRoot,offset,undefined,branchOffset));}catch(e){const message=errorMessage(e);res.status(message==='Project not found.'?404:400).json({error:message});}});
app.get('/api/git-workspace/github',async(req,res)=>{try{res.json(await readGitHubMetadata(requestedProject(req).projectRoot));}catch(e){const message=errorMessage(e);res.status(message==='Project not found.'?404:400).json({error:message});}});
app.post('/api/github/auth',async(req,res)=>{const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='action')||!['status','start','cancel'].includes(body.action)){res.status(400).json({error:'Choose a valid GitHub sign-in action.'});return;}try{res.json(body.action==='status'?await githubAuth.status():body.action==='start'?await githubAuth.start():await githubAuth.cancel());}catch(e){res.status(503).json({error:errorMessage(e)});}});
app.get('/api/tasks/:id/git-workspace',async(req,res)=>{try{const {project}=projectForTask(req.params.id),offset=Number(req.query.offset||0),branchOffset=Number(req.query.branchOffset||0);res.json(await readGitWorkspace(project.projectRoot,offset,undefined,branchOffset));}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:409).json({error:message});}});
app.get('/api/tasks/:id/git-workspace/github',async(req,res)=>{try{const {project}=projectForTask(req.params.id);res.json(await readGitHubMetadata(project.projectRoot));}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:409).json({error:message});}});
app.get('/api/tasks/:id/passes/:passId/git',async(req,res)=>{const task=getTask(req.params.id);if(!task){res.status(404).json({error:'Task not found.'});return;}const pass=task.passes?.find(row=>row.id===req.params.passId);if(!pass){res.status(404).json({error:'Pass not found.'});return;}res.json(pass.gitDiff||{status:'unavailable',message:'Codex did not report a tracked turn diff for this pass. Workspace changes are not used as a substitute.'});});
app.get('/api/tasks/:id/github',async(req,res)=>{try{const {task,project}=projectForTask(req.params.id);res.json({workspace:await readGitHubWorkspace(project.projectRoot),link:task.githubLink||null});}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:409).json({error:message});}});
app.get('/api/directories',async(req,res)=>{try{const requested=req.query.path;if(requested!==undefined&&typeof requested!=='string'||typeof requested==='string'&&requested.length>1024){res.status(400).json({error:'Enter one folder path of 1024 characters or fewer.'});return;}const roots=req.query.roots;const resolve=req.query.resolve;if(roots!==undefined&&roots!=='1'&&roots!=='true'||resolve!==undefined&&resolve!=='1'&&resolve!=='true'||roots!==undefined&&resolve!==undefined){res.status(400).json({error:'Invalid folder browser request.'});return;}if(resolve==='1'||resolve==='true'){if(typeof requested!=='string'||!requested.trim()){res.status(400).json({error:'Select a folder before continuing.'});return;}res.json(await validateProjectDirectory(requested));return;}res.json(await listDirectories(typeof requested==='string'?requested:undefined,roots==='1'||roots==='true'));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/directories',async(req,res)=>{try{const body=req.body;if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='parent'&&key!=='name')||typeof body.parent!=='string'||typeof body.name!=='string'){res.status(400).json({error:'Choose a parent folder and enter one folder name.'});return;}if(body.parent.length>1024){res.status(400).json({error:'The selected parent path is too long. Browse to the folder again.'});return;}res.status(201).json(await createChildDirectory(body.parent,body.name));}catch(e){res.status(400).json({error:errorMessage(e)});}});
function streamStateEvents(req:express.Request,res:express.Response){
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Pseudoharness-Protocol-Version',String(KERNEL_PROTOCOL_VERSION));res.flushHeaders();
  const requested=req.get('last-event-id')??(typeof req.query.after==='string'?req.query.after:undefined);
  const parsedRequested=requested===undefined?undefined:Number(requested);
  let lastSent=-1;
  let firstState=true;
  const sendState=(state=getState())=>{
    if(res.destroyed||res.writableEnded)return;
    if(state.revision<lastSent)return;
    const resync=firstState&&requested!==undefined&&(parsedRequested===undefined||!Number.isSafeInteger(parsedRequested)||parsedRequested!==state.revision);
    firstState=false;
    lastSent=state.revision;
    const payload={type:'snapshot',protocolVersion:KERNEL_PROTOCOL_VERSION,kernelInstanceId:kernelInstance?.instanceId||'',cursor:state.revision,resync,state,runtime:getRuntimeStatus()};
    res.write(`id: ${state.revision}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  if(stateOwnershipError)res.write(`data: ${JSON.stringify({type:'state-unavailable',error:stateOwnershipError})}\n\n`);
  else if(stateLoadError)res.write(`data: ${JSON.stringify({type:'state-unavailable',error:stateLoadError})}\n\n`);
  else sendState();
  const unsubscribe=stateLoadError||stateOwnershipError?()=>{}:subscribe(sendState);
  const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');},25000);
  const stream={response:res,unsubscribe,heartbeat};eventStreams.add(stream);
  res.on('close',()=>{unsubscribe();clearInterval(heartbeat);eventStreams.delete(stream);});
}
app.get('/events',streamStateEvents);
app.get('/api/v1/events',streamStateEvents);
app.post('/api/tasks',async(req,res)=>{try{const body=userTaskSchema.safeExtend({projectId:z.string().uuid()}).strict().parse(req.body);const task=await submitTask(body.message,undefined,body.attachments,body.skillIds,body.projectId,undefined,body.qaEnabled);res.status(201).json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/new',async(_req,res)=>{await mutate(s=>{s.activeTaskId=null;});res.json({ok:true});});
app.post('/api/tasks/:id/messages',async(req,res)=>{try{const body=userTaskSchema.parse(req.body);const task=await submitTask(body.message,req.params.id,body.attachments,body.skillIds,undefined,body.recruitmentWorkerId,body.qaEnabled);res.json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/escalation',async(req,res)=>{try{const body=userTaskSchema.parse(req.body);const task=await submitEscalationDecision(req.params.id,body.message,body.attachments,body.skillIds);res.json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/cancel',async(req,res)=>{try{res.json(await cancelTask(req.params.id));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/approval',async(req,res)=>{try{const body=approvalDecisionSchema.parse(req.body);res.json(await resolveApproval(req.params.id,body.requestId,body.decision,body.content));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/qa/accept',async(req,res)=>{try{const body=z.object({note:z.string().trim().max(1000).optional()}).strict().parse(req.body);res.json(await acceptQualityFindings(req.params.id,body.note));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/qa/pause',async(req,res)=>{try{z.object({}).strict().parse(req.body);res.json(await pauseQualityLoop(req.params.id));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/qa/resume',async(req,res)=>{try{z.object({}).strict().parse(req.body);res.json(await resumeQualityLoop(req.params.id));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/select',async(req,res)=>{try{let task:any;await mutate(s=>{task=s.tasks.find(row=>row.id===req.params.id);if(!task)throw new Error('Task not found.');s.activeTaskId=task.id;noteTaskInteractionInState(s,task.id);if(task.projectId){selectProjectInState(s,task.projectId);if(!s.expandedProjectIds.includes(task.projectId))s.expandedProjectIds.push(task.projectId);}else{s.selectedProjectId=null;if(!s.expandedProjectIds.includes('unclassified'))s.expandedProjectIds.push('unclassified');}});res.json(task);}catch(e){const message=errorMessage(e);res.status(message==='Task not found.'?404:400).json({error:message});}});
app.post('/api/tasks/:id/rename',async(req,res)=>{try{const {title}=sessionTitleSchema.parse(req.body);let renamed;await mutate(s=>{renamed=renameTaskInState(s,req.params.id,title);});res.json(renamed);}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:400).json({error:message});}});
app.post('/api/tasks/:id/delete',async(req,res)=>{try{await mutate(s=>{deleteTaskInState(s,req.params.id);});res.json({ok:true,id:req.params.id});}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:message.startsWith('Stop or finish')?409:400).json({error:message});}});
app.post('/api/settings',async(req,res)=>{try{const settings=settingsSchema.parse(req.body);res.json({runtime:await saveSettings(settings)});}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/runtime/refresh',async(_req,res)=>res.json({runtime:await refreshConnections()}));
app.post('/api/v1/kernel/shutdown',async(req,res)=>{
  if(req.get('x-pseudoharness-token')!==nonce){res.status(403).json({error:'Local request origin or session token rejected.'});return;}
  if(shutdownRequested){res.status(409).json({error:'The kernel is already stopping.',code:'KERNEL_SHUTTING_DOWN'});return;}
  try{
    z.object({confirm:z.literal('stop-kernel')}).strict().parse(req.body);
    shutdownRequested=true;
    let pausedTasks=0;
    const state=await mutate(current=>{pausedTasks=pauseActiveTasksForKernelShutdown(current);});
    res.status(202).json({status:'stopping',pausedTasks,cursor:state.revision,kernelInstanceId:kernelInstance?.instanceId||''});
    setTimeout(()=>void stopServer(),30).unref?.();
  }catch(error){
    shutdownRequested=false;
    const message=errorMessage(error);
    res.status(400).json({error:message});
  }
});
app.get('/api/health',(req,res)=>{const challenge=req.get('x-pseudoharness-startup-challenge')||'';const startupProof=/^[a-f0-9]{64}$/i.test(challenge)?createHmac('sha256',kernelStartupSecret).update(challenge).digest('hex'):undefined;res.json({ok:true,host,port:boundPort,version,protocolVersion:KERNEL_PROTOCOL_VERSION,kernelInstanceId:kernelInstance?.instanceId||'',stateReady:!stateLoadError&&!stateOwnershipError,...(stateLoadError||stateOwnershipError?{stateError:stateOwnershipError||stateLoadError}:{}),...(stateOwnershipError?{stateCode:stateOwnershipCode}:{}),...(startupProof?{startupProof}:{})});});
app.use('/api',(req,res)=>res.status(404).json({error:`Unknown API endpoint: ${req.method} ${req.path}.`}));
if(production) app.use(express.static(path.resolve(here,'../dist'),{fallthrough:true}));
app.use((req,res)=>{if(production)res.sendFile(path.resolve(here,'../dist/index.html'));else res.status(404).send('Open the Vite development server on port 5173.');});
try{stateOwner=acquireStateDirectoryOwner();}catch(error){stateLoadError=stateOwnershipError=errorMessage(error);stateOwnershipCode=error instanceof StateDirectoryInUseError?'STATE_DIRECTORY_IN_USE':'STATE_OWNER_UNAVAILABLE';}
if(stateOwner)try{await loadState();}catch(error){stateLoadError=errorMessage(error);}
server.listen(port,host,()=>{const address=server.address();if(address&&typeof address==='object')boundPort=address.port;if(stateOwner){kernelInstance=createKernelInstanceRecord({port:boundPort,startupSecret:kernelStartupSecret});void writeKernelInstance(kernelInstance).catch(()=>{console.error('Opnex kernel discovery is unavailable; the local service remains accessible at its configured address.');});}console.log(`Opnex headless kernel listening on http://${host}:${boundPort}`);if(stateOwnershipError)console.error(stateOwnershipError);if(!stateLoadError)void initializeRuntime();});
let shutdownTimer:NodeJS.Timeout|undefined;
function stopServer(){
  if(shuttingDown)return;
  shutdownRequested=true;shuttingDown=true;
  for(const stream of eventStreams){stream.unsubscribe();clearInterval(stream.heartbeat);if(!stream.response.destroyed&&!stream.response.writableEnded)stream.response.end();}
  eventStreams.clear();
  server.close(error=>{
    void (async()=>{
      if(shutdownTimer)clearTimeout(shutdownTimer);
      if(stateOwner)try{await mutate(state=>{pauseActiveTasksForKernelShutdown(state);});}catch(stateError){console.error('Opnex could not persist kernel shutdown state:',errorMessage(stateError));}
      // Persist the paused state before terminating owned provider processes so
      // their rejected in-flight requests cannot be mistaken for failed jobs.
      try{await shutdown();}catch(shutdownError){console.error('Opnex runtime shutdown failed:',errorMessage(shutdownError));}
      try{if(kernelInstance)await removeKernelInstanceIfOwned(kernelInstance.instanceId);}catch{console.error('Opnex kernel discovery record could not be removed.');}
      try{stateOwner?.release();}catch(releaseError){console.error('Could not release Opnex state ownership:',errorMessage(releaseError));}
      process.exit(error?1:0);
    })();
  });
  // Allow in-flight HTTP work to finish, then abort any stuck connections. The
  // state-owner lock stays held until server.close confirms all are gone.
  shutdownTimer=setTimeout(()=>server.closeAllConnections(),5000);
  shutdownTimer.unref();
}
process.on('SIGINT',stopServer);process.on('SIGTERM',stopServer);
