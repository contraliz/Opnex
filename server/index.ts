import express from 'express';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, getState, mutate, getTask, subscribe } from './state.js';
import { cancelTask, getRuntimeStatus, initialize, refreshConnections, resolveApproval, retryAgentMemCompletion, saveSettings, submitEscalationDecision, submitTask, shutdown } from './orchestrator.js';
import { approvalDecisionSchema, settingsSchema, userTaskSchema } from './contracts.js';

const app=express();const server=createServer(app);const port=Number(process.env.PORT||4174);const host='127.0.0.1';
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
app.get('/events',(_req,res)=>{res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();const send=(payload:unknown)=>res.write(`data: ${JSON.stringify(payload)}\n\n`);send({state:getState(),runtime:getRuntimeStatus()});const stop=subscribe(s=>send({state:s,runtime:getRuntimeStatus()}));const timer=setInterval(()=>send({type:'heartbeat'}),25000);res.on('close',()=>{stop();clearInterval(timer);});});
app.post('/api/tasks',async(req,res)=>{try{const body=userTaskSchema.parse(req.body);const task=await submitTask(body.message);res.status(201).json(task);}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/new',async(_req,res)=>{await mutate(s=>{s.activeTaskId=null;});res.json({ok:true});});
app.post('/api/tasks/:id/messages',async(req,res)=>{try{const {message}=userTaskSchema.parse(req.body);const task=await submitTask(message,req.params.id);res.json(task);}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/:id/escalation',async(req,res)=>{try{const {message}=userTaskSchema.parse(req.body);const task=await submitEscalationDecision(req.params.id,message);res.json(task);}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/:id/cancel',async(req,res)=>{try{res.json(await cancelTask(req.params.id));}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/:id/passes/:passId/agentmem/retry',async(req,res)=>{try{res.json(await retryAgentMemCompletion(req.params.id,req.params.passId));}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/:id/approval',async(req,res)=>{try{const body=approvalDecisionSchema.parse(req.body);res.json(await resolveApproval(req.params.id,body.requestId,body.decision));}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/tasks/:id/select',async(req,res)=>{const task=getTask(req.params.id);if(!task){res.status(404).json({error:'Task not found.'});return;}await mutate(s=>{s.activeTaskId=task.id;});res.json(task);});
app.post('/api/settings',async(req,res)=>{try{const settings=settingsSchema.parse(req.body);res.json({runtime:await saveSettings(settings)});}catch(e){res.status(400).json({error:error(e)});}});
app.post('/api/runtime/refresh',async(_req,res)=>res.json({runtime:await refreshConnections()}));
app.get('/api/health',(_req,res)=>res.json({ok:true,host,version:'0.1.0'}));
if(production) app.use(express.static(path.resolve(here,'../dist'),{fallthrough:true}));
app.use((req,res)=>{if(production)res.sendFile(path.resolve(here,'../dist/index.html'));else res.status(404).send('Open the Vite development server on port 5173.');});
function error(e:unknown){return (e instanceof Error?e.message:String(e)).slice(0,1000);}
await loadState();server.listen(port,host,()=>{console.log(`Pseudoharness local backend listening on http://${host}:${port}`);void initialize();});
process.on('SIGINT',()=>{shutdown();server.close(()=>process.exit(0));});process.on('SIGTERM',()=>{shutdown();server.close(()=>process.exit(0));});
