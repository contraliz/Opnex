import type { ToolCallLog, ToolCallRecord } from '../types.js';

export function toolCallLogTitle(log?:ToolCallLog){return log?`Tool calls · ${log.total}`:'Tool calls · coverage unavailable';}
const stamp=(value:string)=>{const date=new Date(value);return Number.isNaN(date.valueOf())?'':new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'}).format(date);};
const duration=(call:ToolCallRecord)=>{const start=Date.parse(call.startedAt||call.firstSeenAt),end=Date.parse(call.finishedAt||call.lastSeenAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '';const ms=end-start;return ms<1000?`${ms}ms`:ms<60000?`${(ms/1000).toFixed(1)}s`:`${Math.floor(ms/60000)}m ${Math.round(ms%60000/1000)}s`;};
const roleName=(call:ToolCallRecord)=>({orchestrator:'Orchestrator',worker:'Worker',integrator:'Integrator',qa:'QA',simple:'Simple',direct:'Direct',router:'Router'} as Record<string,string>)[call.agentRole||'']||call.agentRole||'Agent';
const statusLabel=(call:ToolCallRecord)=>call.status;

export function ToolCallLogView({log,issueCount=0,missingMessage='This record has no tool-call coverage data. Complete invocation coverage is unavailable.'}:{log?:ToolCallLog;issueCount?:number;missingMessage?:string}){
  if(!log)return <div className="tool-call-coverage-unknown" role="status">{missingMessage}</div>;
  const rows=[...log.calls].sort((a,b)=>Date.parse(a.firstSeenAt)-Date.parse(b.firstSeenAt));
  return <div className="tool-call-log" aria-label="Observed tool calls">
    <div className="tool-call-summary" aria-label={`${log.total} tool calls observed`}><span>{log.statusCounts.started} running</span><span>{log.statusCounts.completed} completed</span><span>{log.statusCounts.failed} failed</span><span>{log.statusCounts.interrupted} interrupted</span></div>
    {issueCount>0&&<p className="tool-call-coverage-warning" role="status">{issueCount} tool events could not be counted because the provider omitted or returned an unsupported invocation ID.</p>}
    {log.omittedCount>0&&<p className="tool-call-omitted-note">Showing the latest {rows.length.toLocaleString()} tool-call details. {log.omittedCount.toLocaleString()} older detail rows are omitted; the total still includes them.</p>}
    {!rows.length?<p className="tool-call-empty">No tool calls were observed during this run.</p>:<ol className="tool-call-rows">{rows.map(call=><li key={call.key} className={`tool-call-row ${call.status}`}>
      <details className="tool-call-entry">
        <summary>
          <span className={`tool-call-status-dot ${call.status}`} role="img" aria-label={statusLabel(call)} />
          <span className="tool-call-name">{call.name}</span>
          <span className="tool-call-agent">{roleName(call)}</span>
          <span className="tool-call-time">{duration(call)||stamp(call.firstSeenAt)}</span>
          <span className="tool-call-chevron" aria-hidden="true" />
        </summary>
        <div className="tool-call-detail">
          <dl>
            <div><dt>Agent</dt><dd>{roleName(call)}</dd></div>
            <div><dt>Status</dt><dd>{call.status}{duration(call)?` · ${duration(call)}`:''}</dd></div>
            <div><dt>Provider</dt><dd>{call.identity.provider}</dd></div>
            <div><dt>Call</dt><dd><code>{call.identity.callId}</code></dd></div>
            <div><dt>Thread</dt><dd><code>{call.identity.threadId}</code></dd></div>
            <div><dt>Turn</dt><dd><code>{call.identity.turnId}</code></dd></div>
            <div><dt>Started</dt><dd>{stamp(call.startedAt||call.firstSeenAt)||'Unknown'}</dd></div>
            <div><dt>Finished</dt><dd>{call.finishedAt?stamp(call.finishedAt):'Not reported'}</dd></div>
            <div><dt>Sources</dt><dd>{call.sources.map(source=>source==='model'?'agent':'app').join(' + ')||'Not reported'}</dd></div>
          </dl>
          {call.summary&&<p className="tool-call-detail-summary">{call.summary}</p>}
        </div>
      </details>
    </li>)}</ol>}
  </div>;
}
