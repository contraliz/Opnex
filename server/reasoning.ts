import type { AgentMemAuditCall, LiveActivity, ReasoningSummary, ReasoningTurn, Task, WorkflowRole } from './state.js';

const MAX_SECTIONS=40;
const MAX_SECTION_CHARS=12000;
const MAX_ACTIVITY=120;
const MAX_ACTIVITY_CHARS=12000;

function roleForThread(task:Task,threadId:unknown):ReasoningTurn['role']|undefined {
  if(typeof threadId!=='string')return;
  if(threadId===task.directThreadId)return 'direct';
  if(threadId===task.simpleThreadId)return 'simple';
  if(threadId===task.orchestratorThreadId)return 'orchestrator';
  if(threadId===task.workerThreadId)return 'worker';
}

function activePassId(task:Task){return task.currentPassId;}

export function beginReasoningTurn(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string,requestedModel=task.activeModelId||'unknown',requestedEffort=task.activeEffort||'unknown',provider?:string){
  if(!turnId||roleForThread(task,threadId)!==role||task.phase==='cancelled')return false;
  const now=new Date().toISOString();const turns=task.reasoningTurns||[];
  const previous=turns.find(x=>x.threadId===threadId&&x.turnId===turnId);
  if(previous){previous.status='streaming';previous.requestedModel=requestedModel;previous.requestedEffort=requestedEffort;if(provider)previous.provider=provider;previous.startedAt??=now;}
  else task.reasoningTurns=[...turns.slice(-(MAX_SECTIONS-1)),{role,threadId,turnId,requestedModel,requestedEffort,...(provider?{provider}:{}),startedAt:now,status:'streaming'}];
  task.updatedAt=now;
  return true;
}

function matchingTurn(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string){
  const row=task.reasoningTurns?.find(x=>x.role===role&&x.threadId===threadId&&x.turnId===turnId);
  if(row)return row;
  beginReasoningTurn(task,role,threadId,turnId);
  return task.reasoningTurns?.find(x=>x.role===role&&x.threadId===threadId&&x.turnId===turnId);
}

function upsertSection(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string,itemId:string,summaryIndex:number,text:string,mode:'delta'|'final'|'boundary'){
  const turn=matchingTurn(task,role,threadId,turnId);
  if(!turn||turn.status!=='streaming'||!itemId||!Number.isInteger(summaryIndex)||summaryIndex<0)return false;
  const rows=task.reasoningSummaries||[];
  const section=rows.find(x=>x.role===role&&x.threadId===threadId&&x.turnId===turnId&&x.itemId===itemId&&x.summaryIndex===summaryIndex);
  if(mode==='boundary'){
      if(!section){const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:'',passId:activePassId(task),provider:turn.provider,requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel,updatedAt:new Date().toISOString()};task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];}
  }else if(mode==='final'){
    const bounded=text.slice(0,MAX_SECTION_CHARS);
    if(section){section.text=bounded;section.updatedAt=new Date().toISOString();}
    else{const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:bounded,passId:activePassId(task),provider:turn.provider,requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel,updatedAt:new Date().toISOString()};task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];}
  }else if(text){
    if(section){const remaining=MAX_SECTION_CHARS-section.text.length;if(remaining>0)section.text+=text.slice(0,remaining);section.updatedAt=new Date().toISOString();}
    else{const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:text.slice(0,MAX_SECTION_CHARS),passId:activePassId(task),provider:turn.provider,requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel,updatedAt:new Date().toISOString()};task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];}
  }
  task.updatedAt=new Date().toISOString();return true;
}

function bounded(value:unknown){return typeof value==='string'?value.slice(0,MAX_ACTIVITY_CHARS):undefined;}
function toolTitle(item:any){
  switch(item?.type){
    case 'commandExecution':return bounded(item.command)||'Running command';
    case 'fileChange':return 'Updating files';
    case 'mcpToolCall':return [item.serverName??item.server,item.toolName??item.tool].filter(x=>typeof x==='string'&&x).join(' · ')||'Calling tool';
    case 'webSearchCall':return item.query?`Searching the web for ${bounded(item.query)}`:'Searching the web';
    case 'dynamicToolCall':return bounded(item.toolName)||bounded(item.tool)||bounded(item.name)||'Calling tool';
    case 'collabAgentToolCall':return bounded(item.toolName)||bounded(item.tool)||'Delegating work';
    default:return 'Tool activity';
  }
}
function toolDetail(item:any){
  const parts:string[]=[];
  for(const key of ['cwd','serverName','server','toolName','tool','query','url','filePath'])if(typeof item?.[key]==='string'&&item[key])parts.push(`${key}: ${item[key]}`);
  if(Array.isArray(item?.changes))for(const change of item.changes.slice(0,40)){if(typeof change?.path==='string')parts.push(`${change.kind||'changed'} ${change.path}`);}
  return bounded(parts.join('\n'));
}
function finalStatus(item:any,defaultStatus:LiveActivity['status']):LiveActivity['status']{
  if(item?.status==='failed'||item?.status==='declined'||item?.status==='error'||item?.exitCode!==undefined&&item.exitCode!==null&&item.exitCode!==0)return 'failed';
  return defaultStatus;
}
function itemOutput(item:any){
  const candidate=item?.aggregatedOutput??item?.output??item?.result?.content?.map?.((part:any)=>part?.text).filter(Boolean).join('\n')??item?.error?.message;
  return bounded(typeof candidate==='string'?candidate:undefined);
}
function agentMemResultSummary(item:any){
  const candidate=item?.result?.structuredContent??item?.structuredContent??item?.aggregatedOutput??item?.output??item?.result?.content?.map?.((part:any)=>part?.text).filter(Boolean).join('\n');
  if(typeof candidate!=='string'&&(!candidate||typeof candidate!=='object'))return 'Tool completed; response content omitted.';
  let value:any=candidate;
  if(typeof candidate==='string'){try{value=JSON.parse(candidate);}catch{return 'Tool completed; response content omitted.';}}
  const counts:string[]=[];const references:string[]=[];const seen=new Set<any>();
  const visit=(node:any,depth:number)=>{if(depth>5||!node||typeof node!=='object'||seen.has(node))return;seen.add(node);
    if(Array.isArray(node)){if(node.length&&node.every((row:any)=>row&&typeof row==='object'))for(const row of node){for(const key of ['id','source_ref','citation','path'])if(typeof row[key]==='string'&&row[key].length<240)references.push(row[key]);visit(row,depth+1);}return;}
    for(const key of ['items','results','decisions','requirements','lessons','evidence','matches','pages','repositories','files'])if(Array.isArray(node[key]))counts.push(`${key}=${node[key].length}`);
    for(const child of Object.values(node))if(child&&typeof child==='object')visit(child,depth+1);
  };visit(value,0);
  const summary=[...new Set(counts)].slice(0,8);const refs=[...new Set(references)].slice(0,8);if(refs.length)summary.push(`refs=${refs.join(', ')}`);
  return (summary.join(' · ')||'Tool completed; response content omitted.').slice(0,650);
}
export function recordAgentMemModelCall(task:Task,role:WorkflowRole,threadId:string,turnId:string,item:any,status:'running'|'completed'|'failed'|'interrupted'){
  const server=String(item?.serverName??item?.server??'').toLowerCase();if(!server.includes('agentmem')||typeof item?.id!=='string')return false;
  const pass=task.passes?.find(row=>row.id===task.currentPassId);if(!pass)return false;const audit=pass.agentmemAudit??(pass.agentmemAudit={recorded:true,coverage:'from_first_recorded_call',selectedProjectId:task.agentmemProjectId||null,workspaceRoot:task.userRoot,identityStatus:task.agentmemProjectId?'unverified':'unknown',modelMcpStatus:'unknown',contexts:[],calls:[]});if(!audit.recorded)return false;
  let args:any=item.arguments??item.input;if(typeof args==='string'){try{args=JSON.parse(args)}catch{args=undefined;}}
  const method=String(item.toolName??item.tool??'AgentMem tool').slice(0,100);const calledProject=typeof args?.project_id==='string'?args.project_id:audit.selectedProjectId||undefined;const binding=audit.repositories?.find(row=>row.threadId===threadId);const key=`model:${threadId}:${turnId}:${item.id}`;const now=new Date().toISOString();
  const repositoryMethods=new Set(['repository_search','repository_retrieve','repository_status','repository_resync','repository_list','repository_register','repository_graph_query','repository_graph_status','repository_graph_summary','repository_graph_path','repository_graph_impact']);
  const service:AgentMemAuditCall['service']=repositoryMethods.has(method)?'repository_index':'knowledge';
  const writeMethod=method==='update_project_brief'||method==='index_project'||method==='repository_resync'||method==='repository_register'||method==='projects'&&args?.action==='register';
  const writeAction=method==='knowledge'&&['create','update'].includes(String(args?.action))||method==='decisions'&&args?.action==='create'||method==='requirements'&&['create','revise','fulfill'].includes(String(args?.action))||method==='lessons'&&['propose','review'].includes(String(args?.action));
  const readOnlyMethod=['attach_project','retrieve_evidence','decisions','requirements','lessons','knowledge','repository_search','repository_retrieve','repository_status','repository_graph_query','repository_graph_status','repository_graph_summary','repository_graph_path','repository_graph_impact','check_project_changes'].includes(method);
  const operation:AgentMemAuditCall['operation']=writeMethod||writeAction?'write':readOnlyMethod?'read':'unknown';
  const repositoryId=service==='repository_index'?binding?.repositoryId||audit.verifiedRepositoryId:undefined;
  const resultSummary=status==='completed'?agentMemResultSummary(item):undefined;
  const providerEventSequence=Number.isSafeInteger(item.eventSequence)&&item.eventSequence>=0?item.eventSequence:undefined;
  const record={id:key,source:'model' as const,role,method,status,startedAt:now,updatedAt:now,threadId,turnId,...(providerEventSequence!==undefined?{providerEventSequence}:{}),service,operation,...(calledProject?{projectId:calledProject}:{}),...(repositoryId?{repositoryId}:{}),...(resultSummary?{resultSummary}:{})};
  const index=audit.calls.findIndex(row=>row.id===key);if(index>=0){const previous=audit.calls[index];audit.calls[index]={...previous,...record,startedAt:previous.startedAt};}else audit.calls.push(record);
  audit.modelMcpStatus='observed';if(calledProject&&audit.selectedProjectId&&calledProject!==audit.selectedProjectId||typeof args?.repository_id==='string'&&repositoryId&&args.repository_id!==repositoryId)audit.identityStatus='mismatch';
  return true;
}
function activityFor(task:Task,role:LiveActivity['role'],threadId:string,turnId:string,itemId:string){
  return (task.liveActivity||[]).find(item=>item.role===role&&item.threadId===threadId&&item.turnId===turnId&&item.itemId===itemId);
}
function upsertActivity(task:Task,role:LiveActivity['role'],threadId:string,turnId:string,itemId:string,kind:LiveActivity['kind'],itemType:string,title:string,patch:Partial<LiveActivity>={}){
  const turn=matchingTurn(task,role,threadId,turnId);if(!turn||turn.status!=='streaming'||!itemId)return false;
  const now=new Date().toISOString();const rows=task.liveActivity||[];const existing=activityFor(task,role,threadId,turnId,itemId);
  if(existing){Object.assign(existing,patch,{title,updatedAt:now});}
  else{const next:LiveActivity={role,threadId,turnId,itemId,kind,itemType,title,status:'running',startedAt:now,updatedAt:now,passId:activePassId(task),...patch};task.liveActivity=[...rows.slice(-(MAX_ACTIVITY-1)),next];}
  task.updatedAt=now;return true;
}
const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','webSearchCall','dynamicToolCall','collabAgentToolCall']);
function applyCompletedItem(task:Task,threadId:string,turnId:string,item:any){
  if(!item||typeof item!=='object'||typeof item.id!=='string')return false;
  const role=roleForThread(task,threadId);if(!role||task.activeRole!==role||(task.activeTurnId&&task.activeTurnId!==turnId))return false;
  if(item.type==='reasoning'){
    let changed=false;const summaries=Array.isArray(item.summary)?item.summary.filter((part:unknown)=>typeof part==='string'):[];
    summaries.forEach((part:string,index:number)=>{if(part)changed=upsertSection(task,role,threadId,turnId,item.id,index,part,'final')||changed;});return changed;
  }
  if(item.type==='agentMessage'){
    if(item.phase!=='commentary')return false;
    const text=Array.isArray(item.content)?item.content.map((part:any)=>typeof part==='string'?part:part?.text).filter((part:any)=>typeof part==='string').join(''):'';
    if(!text)return false;
    return upsertActivity(task,role,threadId,turnId,item.id,'commentary','agentMessage','', {text:bounded(text),status:'completed'});
  }
  if(!toolTypes.has(item.type))return false;
  const state=finalStatus(item,'completed');const output=itemOutput(item);
  const detail=toolDetail(item);
  return upsertActivity(task,role,threadId,turnId,item.id,'tool',item.type,toolTitle(item),{...(detail?{detail}:{}),...(output?{output}:{}),status:state});
}

function finishTurn(task:Task,threadId:unknown,turn:any){
  if(threadId===task.routerThreadId){if(task.phase==='cancelled'||task.activeRole!=='router'||!turn||task.activeTurnId&&task.activeTurnId!==turn.id)return false;let changed=false;for(const item of Array.isArray(turn.items)?turn.items:[])if(item?.type==='mcpToolCall'&&String(item.serverName??item.server??'').toLowerCase().includes('agentmem'))changed=recordAgentMemModelCall(task,'router',threadId as string,turn.id,item,finalStatus(item,'completed')==='failed'?'failed':'completed')||changed;const status=turn.status==='interrupted'?'interrupted':turn.status==='failed'?'failed':'completed';const audit=task.passes?.find(pass=>pass.id===task.currentPassId)?.agentmemAudit;for(const call of audit?.calls||[])if(call.source==='model'&&call.threadId===threadId&&call.turnId===turn.id&&call.status==='running'){call.status=status;call.updatedAt=new Date().toISOString();changed=true;}return changed;}
  const role=roleForThread(task,threadId);if(task.phase==='cancelled'||!role||!turn||task.activeRole!==role||(task.activeTurnId&&task.activeTurnId!==turn.id))return false;
  let changed=false;
  for(const item of Array.isArray(turn.items)?turn.items:[])changed=applyCompletedItem(task,threadId as string,turn.id,item)||changed;
  const row=task.reasoningTurns?.find(x=>x.threadId===threadId&&x.turnId===turn.id&&x.role===role);
  if(row){row.status=turn.status==='interrupted'?'interrupted':turn.status==='failed'?'failed':'completed';changed=true;}
  for(const item of task.liveActivity||[])if(item.threadId===threadId&&item.turnId===turn.id&&item.status==='running')item.status=turn.status==='interrupted'?'interrupted':turn.status==='failed'?'failed':'completed';
  const audit=task.passes?.find(pass=>pass.id===task.currentPassId)?.agentmemAudit;for(const call of audit?.calls||[])if(call.source==='model'&&call.threadId===threadId&&call.turnId===turn.id&&call.status==='running'){call.status=turn.status==='interrupted'?'interrupted':turn.status==='failed'?'failed':'completed';call.updatedAt=new Date().toISOString();}
  task.updatedAt=new Date().toISOString();return changed;
}

/** Persist only provider-exposed readable summaries, commentary and tool lifecycle data. Raw reasoning channels are intentionally ignored. */
export function applyCodexReasoningNotification(task:Task,method:string,params:any) {
  if(method==='turn/completed')return finishTurn(task,params?.threadId,params?.turn);
  const threadId=params?.threadId;const turnId=params?.turnId;const itemId=params?.itemId;
  if(threadId===task.routerThreadId){if(task.phase==='cancelled'||task.activeRole!=='router'||typeof turnId!=='string'||!turnId||task.activeTurnId&&task.activeTurnId!==turnId)return false;const item=params?.item;if(item?.type==='mcpToolCall'&&String(item.serverName??item.server??'').toLowerCase().includes('agentmem')){if(method==='item/started')return recordAgentMemModelCall(task,'router',threadId,turnId,item,'running');if(method==='item/completed')return recordAgentMemModelCall(task,'router',threadId,turnId,item,finalStatus(item,'completed')==='failed'?'failed':'completed');}return false;}
  const role=roleForThread(task,threadId);
  if(!role||task.phase==='cancelled'||task.activeRole!==role||typeof turnId!=='string'||!turnId)return false;
  if(task.activeTurnId&&turnId!==task.activeTurnId)return false;
  if(method==='model/rerouted'){
    const row=matchingTurn(task,role,threadId,turnId);if(!row||typeof params.toModel!=='string'||!params.toModel)return false;
    row.effectiveModel=params.toModel;for(const section of task.reasoningSummaries||[])if(section.threadId===threadId&&section.turnId===turnId)section.effectiveModel=params.toModel;
    task.updatedAt=new Date().toISOString();return true;
  }
  if(method==='item/reasoning/summaryTextDelta'){
    if(typeof params.summaryIndex!=='number'||typeof params.delta!=='string')return false;
    return upsertSection(task,role,threadId,turnId,itemId,params.summaryIndex,params.delta,'delta');
  }
  if(method==='item/reasoning/summaryPartAdded'){
    if(typeof params.summaryIndex!=='number')return false;
    return upsertSection(task,role,threadId,turnId,itemId,params.summaryIndex,'','boundary');
  }
  if(method==='item/started'){
    const item=params.item;if(!item||typeof item.id!=='string')return false;
    if(item.type==='reasoning')return matchingTurn(task,role,threadId,turnId)!==undefined;
    if(item.type==='agentMessage'&&item.phase==='commentary')return upsertActivity(task,role,threadId,turnId,item.id,'commentary','agentMessage','');
    if(item.type==='mcpToolCall'&&String(item.serverName??item.server??'').toLowerCase().includes('agentmem')){const recorded=recordAgentMemModelCall(task,role,threadId,turnId,item,'running');const shown=upsertActivity(task,role,threadId,turnId,item.id,'tool',item.type,toolTitle(item),{status:'running'});return recorded||shown;}
    if(!toolTypes.has(item.type))return false;
    const detail=toolDetail(item);
    return upsertActivity(task,role,threadId,turnId,item.id,'tool',item.type,toolTitle(item),detail?{detail}:{});
  }
  if(method==='item/agentMessage/delta'){
    if(typeof itemId!=='string'||typeof params.delta!=='string')return false;
    const activity=activityFor(task,role,threadId,turnId,itemId);if(!activity||activity.kind!=='commentary')return false;
    activity.text=(activity.text||'')+params.delta;activity.text=activity.text.slice(0,MAX_ACTIVITY_CHARS);activity.updatedAt=new Date().toISOString();task.updatedAt=activity.updatedAt;return true;
  }
  if(method==='item/commandExecution/outputDelta'){
    if(typeof itemId!=='string'||typeof params.delta!=='string')return false;
    const activity=activityFor(task,role,threadId,turnId,itemId);if(!activity||activity.kind!=='tool')return false;
    activity.output=((activity.output||'')+params.delta).slice(0,MAX_ACTIVITY_CHARS);activity.updatedAt=new Date().toISOString();task.updatedAt=activity.updatedAt;return true;
  }
  if(method==='item/completed'){
    const item=params.item;
    if(item?.type==='mcpToolCall'&&String(item.serverName??item.server??'').toLowerCase().includes('agentmem')){
      const status=finalStatus(item,'completed')==='failed'?'failed':'completed';const changed=recordAgentMemModelCall(task,role,threadId,turnId,item,status);
      // Audit only tool metadata. Never persist model MCP arguments, output, or error payloads.
      const shown=applyCompletedItem(task,threadId,turnId,{...item,aggregatedOutput:undefined,output:undefined,result:undefined,error:undefined});return changed||shown;
    }
    return applyCompletedItem(task,threadId,turnId,item);
  }
  return false;
}
