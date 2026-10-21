import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDirectories, validateProjectDirectory } from './directories.js';
import { errorMessage } from './errors.js';
import { loadState, getState, mutate, getTask, subscribe, renameTaskInState, deleteTaskInState } from './state.js';
import { cancelTask, getRuntimeStatus, initialize, refreshConnections, resolveApproval, retryAgentMemCompletion, saveSettings, submitEscalationDecision, submitTask, shutdown } from './orchestrator.js';
import { approvalDecisionSchema, sessionTitleSchema, settingsSchema, userTaskSchema } from './contracts.js';

const app=express();const server=createServer(app);const port=Number(process.env.PORT||4174);const host='127.0.0.1';const version=createRequire(import.meta.url)('../package.json').version as string;
const nonce=randomBytes(24).toString('base64url');
const here=path.dirname(fileURLToPath(import.meta.url));
const production=process.env.NODE_ENV==='production';
app.disable('x-powered-by');app.use(express.json({limit:'128kb'}));
function isLoopbackHost(raw:string|undefined){if(!raw)return false;const v=raw.split(':')[0].replace(/^\[|\]$/g,'').toLowerCase();return ['127.0.0.1','localhost','::1'].includes(v);}
app.use((req,res,next)=>{if(!isLoopbackHost(req.headers.host)){res.status(403).json({error:'Loopback host required.'});return;}const origin=req.headers.origin;const allowed=!origin||origin==='http://127.0.0.1:5173'||origin==='http://localhost:5173'||origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`;if(!allowed){res.status(403).json({error:'Request origin rejected.'});return;}next();});
app.use('/api',(req,res,next)=>{if(!isLoopbackHost(req.headers.host)){res.status(403).json({error:'Loopback host required.'});return;}if(req.method!=='GET'&&req.method!=='HEAD'){
  const origin=req.headers.origin;const allowed=!origin||origin==='http://127.0.0.1:5173'||origin==='http://localhost:5173'||origin===`http://127.0.0.1:${port}`||origin===`http://localhost:${port}`;
  if(!allowed||req.get('x-pseudoharness-token')!==nonce){res.status(403).json({error:'Local request origin or session token rejected.'});return;}
}next();});
app.get('/api/bootstrap',async(_req,res)=>{await loadState();res.json({state:getState(),runtime:getRuntimeStatus(),csrf:nonce});});
app.get('/api/state',(_req,res)=>res.json({state:getState(),runtime:getRuntimeStatus()}));
app.get('/api/directories',async(req,res)=>{try{const requested=req.query.path;if(requested!==undefined&&typeof requested!=='string'||typeof requested==='string'&&requested.length>1024){res.status(400).json({error:'Enter one folder path of 1024 characters or fewer.'});return;}const roots=req.query.roots;const resolve=req.query.resolve;if(roots!==undefined&&roots!=='1'&&roots!=='true'||resolve!==undefined&&resolve!=='1'&&resolve!=='true'||roots!==undefined&&resolve!==undefined){res.status(400).json({error:'Invalid folder browser request.'});return;}if(resolve==='1'||resolve==='true'){if(typeof requested!=='string'||!requested.trim()){res.status(400).json({error:'Select a folder before continuing.'});return;}res.json(await validateProjectDirectory(requested));return;}res.json(await listDirectories(typeof requested==='string'?requested:undefined,roots==='1'||roots==='true'));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.get('/events',(_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();const send=(payload:unknown)=>res.write(`data: ${JSON.stringify(payload)}\n\n`);send({state:getState(),runtime:getRuntimeStatus()});const stop=subscribe(s=>send({state:s,runtime:getRuntimeStatus()}));const timer=setInterval(()=>send({type:'heartbeat'}),25000);res.on('close',()=>{stop();clearInterval(timer);});});
app.post('/api/tasks',async(req,res)=>{try{const body=userTaskSchema.parse(req.body);const task=await submitTask(body.message);res.status(201).json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/new',async(_req,res)=>{await mutate(s=>{s.activeTaskId=null;});res.json({ok:true});});
app.post('/api/tasks/:id/messages',async(req,res)=>{try{const {message}=userTaskSchema.parse(req.body);const task=await submitTask(message,req.params.id);res.json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/escalation',async(req,res)=>{try{const {message}=userTaskSchema.parse(req.body);const task=await submitEscalationDecision(req.params.id,message);res.json(task);}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/cancel',async(req,res)=>{try{res.json(await cancelTask(req.params.id));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/passes/:passId/agentmem/retry',async(req,res)=>{try{res.json(await retryAgentMemCompletion(req.params.id,req.params.passId));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/approval',async(req,res)=>{try{const body=approvalDecisionSchema.parse(req.body);res.json(await resolveApproval(req.params.id,body.requestId,body.decision));}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/tasks/:id/select',async(req,res)=>{const task=getTask(req.params.id);if(!task){res.status(404).json({error:'Task not found.'});return;}await mutate(s=>{s.activeTaskId=task.id;});res.json(task);});
app.post('/api/tasks/:id/rename',async(req,res)=>{try{const {title}=sessionTitleSchema.parse(req.body);let renamed;await mutate(s=>{renamed=renameTaskInState(s,req.params.id,title);});res.json(renamed);}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:400).json({error:message});}});
app.post('/api/tasks/:id/delete',async(req,res)=>{try{await mutate(s=>{deleteTaskInState(s,req.params.id);});res.json({ok:true,id:req.params.id});}catch(e){const message=errorMessage(e);res.status(message==='Session not found.'?404:message.startsWith('Stop or finish')||message.startsWith('Wait for AgentMem')?409:400).json({error:message});}});
app.post('/api/settings',async(req,res)=>{try{const settings=settingsSchema.parse(req.body);res.json({runtime:await saveSettings(settings)});}catch(e){res.status(400).json({error:errorMessage(e)});}});
app.post('/api/runtime/refresh',async(_req,res)=>res.json({runtime:await refreshConnections()}));
app.get('/api/health',(_req,res)=>res.json({ok:true,host,version}));
app.use('/api',(req,res)=>res.status(404).json({error:`Unknown API endpoint: ${req.method} ${req.path}.`}));
if(production) app.use(express.static(path.resolve(here,'../dist'),{fallthrough:true}));
app.use((req,res)=>{if(production)res.sendFile(path.resolve(here,'../dist/index.html'));else res.status(404).send('Open the Vite development server on port 5173.');});
await loadState();server.listen(port,host,()=>{console.log(`Pseudoharness local backend listening on http://${host}:${port}`);void initialize();});
process.on('SIGINT',()=>{shutdown();server.close(()=>process.exit(0));});process.on('SIGTERM',()=>{shutdown();server.close(()=>process.exit(0));});
