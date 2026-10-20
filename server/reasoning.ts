import type { ReasoningRawContent, ReasoningSummary, ReasoningTurn, Task } from './state.js';

const MAX_SECTIONS=40;
const MAX_SECTION_CHARS=12000;
const MAX_RAW_CONTENT_PARTS=40;
const MAX_RAW_CONTENT_CHARS=12000;

function roleForThread(task:Task,threadId:unknown):ReasoningTurn['role']|undefined {
  if(typeof threadId!=='string')return;
  if(threadId===task.orchestratorThreadId)return 'orchestrator';
  if(threadId===task.workerThreadId)return 'worker';
}

function activePassId(task:Task){return task.currentPassId;}

export function beginReasoningTurn(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string,requestedModel=task.activeModelId||'unknown',requestedEffort=task.activeEffort||'unknown'){
  if(!turnId||roleForThread(task,threadId)!==role||task.phase==='cancelled')return false;
  const now=new Date().toISOString();const turns=task.reasoningTurns||[];
  const previous=turns.find(x=>x.threadId===threadId&&x.turnId===turnId);
  if(previous){previous.status='streaming';previous.requestedModel=requestedModel;previous.requestedEffort=requestedEffort;previous.startedAt??=now;}
  else task.reasoningTurns=[...turns.slice(-(MAX_SECTIONS-1)),{role,threadId,turnId,requestedModel,requestedEffort,startedAt:now,status:'streaming'}];
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
    if(!section){
      const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:'',passId:activePassId(task),requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel};
      task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];
    }
  }else if(mode==='final'){
    const bounded=text.slice(0,MAX_SECTION_CHARS);
    if(section)section.text=bounded;
    else{
      const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:bounded,passId:activePassId(task),requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel};
      task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];
    }
  }else if(text){
    if(section){const remaining=MAX_SECTION_CHARS-section.text.length;if(remaining>0)section.text+=text.slice(0,remaining);}
    else{
      const next:ReasoningSummary={role,threadId,turnId,itemId,summaryIndex,text:text.slice(0,MAX_SECTION_CHARS),passId:activePassId(task),requestedModel:turn.requestedModel,requestedEffort:turn.requestedEffort,effectiveModel:turn.effectiveModel};
      task.reasoningSummaries=[...rows.slice(-(MAX_SECTIONS-1)),next];
    }
  }
  task.updatedAt=new Date().toISOString();
  return true;
}

function applyFinalReasoningItem(task:Task,threadId:unknown,turnId:unknown,item:unknown){
  if(!item||typeof item!=='object')return false;
  const value=item as any;
  if(value.type!=='reasoning'||typeof value.id!=='string')return false;
  const role=roleForThread(task,threadId);
  if(!role||typeof turnId!=='string'||task.activeRole!==role||(task.activeTurnId&&task.activeTurnId!==turnId))return false;
  const summaries=Array.isArray(value.summary)?value.summary.filter((part:unknown)=>typeof part==='string'):[];
  let accepted=false;
  summaries.forEach((part:string,index:number)=>{if(part)accepted=upsertSection(task,role,threadId as string,turnId,value.id,index,part,'final')||accepted;});
  if(Array.isArray(value.content))accepted=replaceRawContentItem(task,role,threadId as string,turnId,value.id,value.content)||accepted;
  return accepted;
}

function replaceRawContentItem(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string,itemId:string,content:unknown[]){
  const turn=matchingTurn(task,role,threadId,turnId);
  if(!turn||turn.status!=='streaming')return false;
  const rows=task.reasoningRawContent||[];
  const existing=rows.filter(x=>x.role===role&&x.threadId===threadId&&x.turnId===turnId&&x.itemId===itemId);
  const remaining=rows.filter(x=>!(x.role===role&&x.threadId===threadId&&x.turnId===turnId&&x.itemId===itemId));
  const replacement:ReasoningRawContent[]=content.flatMap((part,index)=>typeof part==='string'&&part? [{role,threadId,turnId,itemId,contentIndex:index,text:part.slice(0,MAX_RAW_CONTENT_CHARS),passId:activePassId(task)}]:[]);
  const changed=existing.length!==replacement.length||replacement.some(next=>existing.find(x=>x.contentIndex===next.contentIndex)?.text!==next.text);
  if(changed){task.reasoningRawContent=[...remaining,...replacement].slice(-MAX_RAW_CONTENT_PARTS);task.updatedAt=new Date().toISOString();}
  return changed;
}

function upsertRawContent(task:Task,role:ReasoningTurn['role'],threadId:string,turnId:string,itemId:string,contentIndex:number,text:string){
  const turn=matchingTurn(task,role,threadId,turnId);
  if(!turn||turn.status!=='streaming'||!itemId||!Number.isInteger(contentIndex)||contentIndex<0||!text)return false;
  const rows=task.reasoningRawContent||[];
  const section=rows.find(x=>x.role===role&&x.threadId===threadId&&x.turnId===turnId&&x.itemId===itemId&&x.contentIndex===contentIndex);
  if(section){const remaining=MAX_RAW_CONTENT_CHARS-section.text.length;if(remaining<=0)return false;section.text+=text.slice(0,remaining);}
  else{
    const next:ReasoningRawContent={role,threadId,turnId,itemId,contentIndex,text:text.slice(0,MAX_RAW_CONTENT_CHARS),passId:activePassId(task)};
    task.reasoningRawContent=[...rows.slice(-(MAX_RAW_CONTENT_PARTS-1)),next];
  }
  task.updatedAt=new Date().toISOString();
  return true;
}

function applyFinalTurn(task:Task,params:any){
  const threadId=params?.threadId;const turn=params?.turn;const role=roleForThread(task,threadId);
  if(task.phase==='cancelled'||!role||!turn||task.activeRole!==role||(task.activeTurnId&&task.activeTurnId!==turn.id))return false;
  let changed=false;
  for(const item of Array.isArray(turn.items)?turn.items:[])changed=applyFinalReasoningItem(task,threadId,turn.id,item)||changed;
  const row=task.reasoningTurns?.find(x=>x.threadId===threadId&&x.turnId===turn.id&&x.role===role);
  if(row){
    row.status=turn.status==='interrupted'?'interrupted':turn.status==='failed'?'failed':'completed';
    task.updatedAt=new Date().toISOString();changed=true;
  }
  return changed;
}

/** Store only Codex's readable summary and text-delta channels; opaque raw Responses items are ignored. */
export function applyCodexReasoningNotification(task:Task,method:string,params:any) {
  if(method==='turn/completed')return applyFinalTurn(task,params);
  const threadId=params?.threadId;const turnId=params?.turnId;const itemId=params?.itemId;
  const role=roleForThread(task,threadId);
  if(!role||task.phase==='cancelled'||task.activeRole!==role||typeof turnId!=='string'||!turnId)return false;
  if(task.activeTurnId&&turnId!==task.activeTurnId)return false;
  if(method==='model/rerouted'){
    const row=matchingTurn(task,role,threadId,turnId);
    if(!row||typeof params.toModel!=='string'||!params.toModel)return false;
    row.effectiveModel=params.toModel;
    for(const section of task.reasoningSummaries||[])if(section.threadId===threadId&&section.turnId===turnId)section.effectiveModel=params.toModel;
    task.updatedAt=new Date().toISOString();return true;
  }
  if(method==='item/completed')return applyFinalReasoningItem(task,threadId,turnId,params.item);
  if(!itemId||typeof itemId!=='string')return false;
  if(method==='item/reasoning/summaryTextDelta'){
    if(typeof params.summaryIndex!=='number'||typeof params.delta!=='string')return false;
    return upsertSection(task,role,threadId,turnId,itemId,params.summaryIndex,params.delta,'delta');
  }
  if(method==='item/reasoning/summaryPartAdded'){
    if(typeof params.summaryIndex!=='number')return false;
    return upsertSection(task,role,threadId,turnId,itemId,params.summaryIndex,'','boundary');
  }
  if(method==='item/reasoning/textDelta'){
    if(typeof params.contentIndex!=='number'||typeof params.delta!=='string')return false;
    return upsertRawContent(task,role,threadId,turnId,itemId,params.contentIndex,params.delta);
  }
  return false;
}
