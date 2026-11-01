import { AlertCircle, Check, Square } from 'lucide-react';
import type { ToolCallLog } from '../types.js';

export function toolCallLogTitle(log?:ToolCallLog){return log?`Tool calls · ${log.total}`:'Tool calls · coverage unavailable';}
function toolCallStamp(value:string){const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date);}

export function ToolCallLogView({log,issueCount=0,missingMessage='This record has no tool-call coverage data. Complete invocation coverage is unavailable.'}:{log?:ToolCallLog;issueCount?:number;missingMessage?:string}){
  if(!log)return <div className="tool-call-coverage-unknown" role="status">{missingMessage}</div>;
  const rows=[...log.calls].sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt));
  return <div className="tool-call-log" aria-label="Observed tool calls">
    <div className="tool-call-summary" aria-label={`${log.total} tool calls observed`}><span>{log.statusCounts.started} running</span><span>{log.statusCounts.completed} completed</span><span>{log.statusCounts.failed} failed</span><span>{log.statusCounts.interrupted} interrupted</span></div>
    {issueCount>0&&<p className="tool-call-coverage-warning" role="status">{issueCount} tool events could not be counted because the provider omitted or returned an unsupported invocation ID.</p>}
    {log.omittedCount>0&&<p className="tool-call-omitted-note">Showing the latest {rows.length.toLocaleString()} tool-call details. {log.omittedCount.toLocaleString()} older detail rows are omitted; the total still includes them.</p>}
    {!rows.length?<p className="tool-call-empty">No tool calls were observed during this run.</p>:<ol className="tool-call-rows">{rows.map(call=><li key={call.key} className={`tool-call-row ${call.status}`}><span className="tool-call-state" aria-label={call.status}>{call.status==='started'?<span className="activity-spinner"/>:call.status==='failed'?<AlertCircle size={13}/>:call.status==='completed'?<Check size={13}/>:<Square size={11}/>}</span><div className="tool-call-copy"><strong>{call.name}</strong><span>{call.identity.provider} · {call.agentRole||'agent'} · {call.sources.map(source=>source==='model'?'agent':'app').join(' + ')} · {toolCallStamp(call.firstSeenAt)}</span>{call.summary&&<small>{call.summary}</small>}</div></li>)}</ol>}
  </div>;
}
