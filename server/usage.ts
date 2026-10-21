import type { PassAllowanceWindow, PassRoleUsage, PassTokenUsage, PassUsageGroup, TaskPass } from './state.js';

type Role='orchestrator'|'worker';
export type AllowanceSnapshot={accountId:string|null;sampledAt:string;fiveHour:{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}|null;weekly:{usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}|null};
export function normalizeAllowanceSnapshot(response:unknown):AllowanceSnapshot|null {
  if(!response||typeof response!=='object')return null;
  const payload=response as Record<string,any>;
  const keyedCodex=payload.rateLimitsByLimitId?.codex;
  const record=keyedCodex||(payload.rateLimits?.limitId==='codex'?payload.rateLimits:null);
  if(!record||typeof record!=='object'||(keyedCodex?record.limitId!==null&&record.limitId!=='codex':record.limitId!=='codex'))return null;
  const window=(value:any,expected:number)=>value&&typeof value.usedPercent==='number'&&Number.isFinite(value.usedPercent)&&value.usedPercent>=0&&value.usedPercent<=100&&value.windowDurationMins===expected?{usedPercent:value.usedPercent,windowDurationMins:value.windowDurationMins,resetsAt:typeof value.resetsAt==='number'?value.resetsAt:null}:null;
  const fiveHour=window(record.primary,300)||window(record.secondary,300);
  const weekly=window(record.primary,10080)||window(record.secondary,10080);
  return fiveHour||weekly?{accountId:typeof payload.accountId==='string'?payload.accountId:null,sampledAt:new Date().toISOString(),fiveHour,weekly}:null;
}
function windowDelta(before:AllowanceSnapshot['fiveHour'],after:AllowanceSnapshot['fiveHour']):number|null {
  if(!before||!after||before.windowDurationMins!==after.windowDurationMins||before.resetsAt===null||after.resetsAt===null||before.resetsAt!==after.resetsAt)return null;
  const delta=after.usedPercent-before.usedPercent;
  return delta>=0?Math.round(delta*10000)/10000:null;
}
export function applyAllowanceDelta(pass:TaskPass,role:Role,threadId:string,before:AllowanceSnapshot|null,after:AllowanceSnapshot|null){
  if(roleThread(pass,role)!==threadId)return false;
  if(!before||!after||before.accountId!==after.accountId)return false;
  const value=ensureRoleUsage(pass,role,threadId);
  const fiveHourPercent=windowDelta(before?.fiveHour||null,after?.fiveHour||null);
  const weeklyPercent=windowDelta(before?.weekly||null,after?.weekly||null);
  if(fiveHourPercent===null&&weeklyPercent===null)return false;
  const prior=value.allowance;
  const sampleWindow=(key:'fiveHour'|'weekly',delta:number|null,old:PassAllowanceWindow|undefined):PassAllowanceWindow|undefined=>{
    const start=before[key],end=after[key];if(delta===null||!start||!end||start.windowDurationMins===null||start.resetsAt===null||end.windowDurationMins===null||end.resetsAt===null)return old;
    return {sampleCount:(old?.sampleCount||0)+1,firstSampledAt:old?.firstSampledAt||before.sampledAt,lastSampledAt:after.sampledAt,windowDurationMins:start.windowDurationMins,resetsAt:old?.resetsAt??start.resetsAt,boundariesChanged:(old?.boundariesChanged||false)||old!==undefined&&old.resetsAt!==start.resetsAt};
  };
  const addPercent=(a:number|null|undefined,b:number|null)=>b===null?a===null?null:a??null:Math.round(((a||0)+b)*10000)/10000;
  value.allowance={fiveHourPercent:addPercent(prior?.fiveHourPercent,fiveHourPercent),weeklyPercent:addPercent(prior?.weeklyPercent,weeklyPercent),fiveHourWindow:sampleWindow('fiveHour',fiveHourPercent,prior?.fiveHourWindow),weeklyWindow:sampleWindow('weekly',weeklyPercent,prior?.weeklyWindow)};
  value.updatedAt=new Date().toISOString();return true;
}

function nonNegativeInteger(value:unknown):number|null {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function micros(value:unknown):string|null {
  if(typeof value!=='string'&&typeof value!=='number'&&typeof value!=='bigint')return null;
  const text=String(value);
  return /^\d+$/.test(text)?text:null;
}
function roleThread(pass:TaskPass,role:Role){return role==='orchestrator'?pass.orchestratorThreadId:pass.workerThreadId;}
function ensureRoleUsage(pass:TaskPass,role:Role,threadId:string):PassRoleUsage {
  const existing=pass.usage?.[role];
  const value=existing?.threadId===threadId?existing:{threadId,tokenStatus:'pending' as const,creditStatus:'pending' as const};
  pass.usage={...pass.usage,[role]:value};
  return value;
}

export function applyThreadTokenUsage(pass:TaskPass,role:Role,threadId:string,tokenUsage:unknown){
  if(roleThread(pass,role)!==threadId||!tokenUsage||typeof tokenUsage!=='object')return false;
  const record=tokenUsage as {total?:Record<string,unknown>;modelContextWindow?:unknown};
  if(!record.total||typeof record.total!=='object')return false;
  const total=record.total;
  const totalTokens=nonNegativeInteger(total.totalTokens);
  const inputTokens=nonNegativeInteger(total.inputTokens);
  const outputTokens=nonNegativeInteger(total.outputTokens);
  if(totalTokens===null||inputTokens===null||outputTokens===null)return false;
  const tokens:PassTokenUsage={
    totalTokens,inputTokens,outputTokens,
    cachedInputTokens:nonNegativeInteger(total.cachedInputTokens),
    cacheWriteInputTokens:nonNegativeInteger(total.cacheWriteInputTokens),
    reasoningOutputTokens:nonNegativeInteger(total.reasoningOutputTokens),
    modelContextWindow:nonNegativeInteger(record.modelContextWindow),source:'thread'
  };
  const value=ensureRoleUsage(pass,role,threadId);
  value.tokenStatus='available';value.tokens=tokens;value.updatedAt=new Date().toISOString();
  return true;
}

function normalizeGroup(value:unknown):PassUsageGroup|null {
  if(!value||typeof value!=='object')return null;
  const row=value as Record<string,unknown>;
  const estimatedCreditsMicros=micros(row.estimatedUsageCreditsMicros);
  if(estimatedCreditsMicros===null)return null;
  const nullableMicros=(input:unknown)=>input===null?null:micros(input);
  return {
    model:typeof row.model==='string'?row.model:null,
    reasoningEffort:typeof row.reasoningEffort==='string'?row.reasoningEffort:null,
    speed:typeof row.speed==='string'?row.speed:null,
    estimatedCreditsMicros,
    netNewInputTokens:nullableMicros(row.netNewInputTokens),
    cachedInputTokens:nullableMicros(row.cachedInputTokens),
    inputTokens:nullableMicros(row.inputTokens),
    outputTokens:nullableMicros(row.outputTokens),
    totalTokens:nullableMicros(row.totalTokens)
  };
}
function sumGroupValues(groups:PassUsageGroup[],key:'cachedInputTokens'|'inputTokens'|'outputTokens'|'totalTokens'){
  if(!groups.length||groups.some(group=>group[key]===null))return null;
  const total=groups.reduce((sum,group)=>sum+BigInt(group[key]!),0n);
  return total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):null;
}
function tokenEstimateFromGroups(groups:PassUsageGroup[]):PassTokenUsage|undefined {
  const inputTokens=sumGroupValues(groups,'inputTokens');
  const outputTokens=sumGroupValues(groups,'outputTokens');
  const totalTokens=sumGroupValues(groups,'totalTokens')??(inputTokens!==null&&outputTokens!==null?inputTokens+outputTokens:null);
  if(inputTokens===null||outputTokens===null||totalTokens===null)return;
  return {totalTokens,inputTokens,cachedInputTokens:sumGroupValues(groups,'cachedInputTokens'),cacheWriteInputTokens:null,outputTokens,reasoningOutputTokens:null,modelContextWindow:null,source:'thread-estimate'};
}

export function applyThreadEstimatedUsage(pass:TaskPass,role:Role,threadId:string,threadUsage:unknown){
  if(roleThread(pass,role)!==threadId||!threadUsage||typeof threadUsage!=='object')return false;
  const row=threadUsage as Record<string,unknown>;
  if(row.threadId!==threadId)return false;
  const estimatedCreditsMicros=micros(row.estimatedUsageCreditsMicros);
  if(estimatedCreditsMicros===null)return false;
  const groups=Array.isArray(row.groups)?row.groups.map(normalizeGroup).filter((x):x is PassUsageGroup=>x!==null):[];
  const value=ensureRoleUsage(pass,role,threadId);
  value.creditStatus='available';
  value.estimateSource='codex-app-server-thread-usage';
  value.estimatedCreditsMicros=estimatedCreditsMicros;
  value.estimatedUsdMicros=row.estimatedUsageUsdMicros===null?null:micros(row.estimatedUsageUsdMicros);
  value.groups=groups;
  if(!value.tokens){const estimate=tokenEstimateFromGroups(groups);if(estimate){value.tokens=estimate;value.tokenStatus='available';}}
  value.updatedAt=new Date().toISOString();
  return true;
}

export function beginThreadUsageRead(pass:TaskPass,role:Role,threadId:string){
  if(roleThread(pass,role)!==threadId)return false;
  const value=ensureRoleUsage(pass,role,threadId);
  if(value.creditStatus!=='available')value.creditStatus='pending';
  if(value.tokenStatus!=='available')value.tokenStatus='pending';
  return true;
}

export function markThreadTokenUsageUnavailable(pass:TaskPass,role:Role,threadId:string){
  if(roleThread(pass,role)!==threadId)return false;
  const value=ensureRoleUsage(pass,role,threadId);
  if(value.tokenStatus==='available')return false;
  value.tokenStatus='unavailable';value.updatedAt=new Date().toISOString();return true;
}

export function markThreadEstimatedUsageUnavailable(pass:TaskPass,role:Role,threadId:string){
  if(roleThread(pass,role)!==threadId)return false;
  const value=ensureRoleUsage(pass,role,threadId);
  if(value.creditStatus==='available')return false;
  value.creditStatus='unavailable';value.updatedAt=new Date().toISOString();return true;
}
