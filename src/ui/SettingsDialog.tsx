import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { api } from './api';
import { ChoicePopover } from './Composer';
import ModelPicker, { modelChoiceName } from './ModelPicker';
import type { ModelChoice } from './ModelPicker';
import type { AppState, ExecutionProfile, Runtime } from '../types';
import { codexMcpRoles, deepSeekMcpRoles, type McpServerRegistration } from '../../server/mcp-registration.js';
import { DirectoryPicker } from './DirectoryPicker';

type Settings=AppState['settings'];
type SettingsDialogProps={open:boolean;settings:Settings;models:Runtime['codex']['models'];runtime:Runtime|null;close:()=>void;saved:(settings:Settings)=>Promise<boolean>;reconnect:()=>Promise<void>};

function workerProfile(value:Settings):ExecutionProfile{return value.executionProfile||{provider:'codex',model:'gpt-6-luna',effort:'max'};}
function WorkerExecutionSettings({value,set,models,disabled}:{value:Settings;set:(value:Settings)=>void;models:Runtime['codex']['models'];disabled:boolean}){
  const profile=workerProfile(value),codex=models.find(model=>model.id==='gpt-6-luna'),codexEfforts=(codex?.efforts||[]).filter(effort=>['low','medium','high','xhigh','max','ultra'].includes(effort));
  const choices:ModelChoice[]=[
    {providerKey:'codex',provider:'Codex · OpenAI',id:'gpt-6-luna',name:modelChoiceName('gpt-6-luna',codex?.displayName),efforts:codexEfforts,available:!!codex&&codexEfforts.length>0,availabilityNote:codex&&codexEfforts.length?undefined:'GPT-6 Luna is not available in the local Codex model catalog.'},
    {providerKey:'deepseek',provider:'DeepSeek Harness · OpenCode Go',id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash',efforts:['max'],available:true,availabilityNote:'Runtime and authentication are checked before launch; no fallback is used.'},
  ];
  if(!choices.some(choice=>choice.providerKey===profile.provider&&choice.id===profile.model))choices.push({providerKey:profile.provider,provider:`Saved ${profile.provider} profile`,id:profile.model,name:profile.model,efforts:[profile.effort],available:false,availabilityNote:'This saved profile is not one of the currently configured worker choices.'});
  const active=choices.find(choice=>choice.providerKey===profile.provider&&choice.id===profile.model),efforts=active?.efforts||[];
  const updateProfile=(next:ExecutionProfile)=>set({...value,executionProfile:next,...(next.provider==='deepseek'?{deepseekProvider:'opencode-go',deepseekModel:next.model,deepseekReasoningEffort:next.effort}:{})});
  return <fieldset className="settings-help settings-provider-group"><legend>Worker execution profile</legend>
    <div className="settings-select-row"><span>Worker model</span><ModelPicker label="Worker model" providerKey={profile.provider} model={profile.model} effort={profile.effort} choices={choices} disabled={disabled} onChange={(choice,effort)=>updateProfile({provider:choice.providerKey as ExecutionProfile['provider'],model:choice.id,effort:effort as ExecutionProfile['effort']})}/></div>
    <div className="settings-select-row"><span>Worker effort</span><ChoicePopover label="Worker effort" caption="" value={profile.effort} disabled={disabled||!efforts.length} options={efforts.map(effort=>({value:effort,label:effort}))} onChange={effort=>updateProfile({...profile,effort:effort as ExecutionProfile['effort']})}/></div>
    <small>New passes use this model and effort for workers, integration, corrections, and simple implementation. Direct answers use the composer’s orchestrator selection. Existing passes keep their saved profile.</small>
    {profile.provider==='deepseek'&&<small>DeepSeek runs through OpenCode Go with V4.1 Flash. Opnex requests max effort and checks provider availability before launch; DSH may not report the effective effort.</small>}
  </fieldset>;
}

function DeepSeekConversationStorageSettings({value,set,runtime,disabled,pickerOpen,setPickerOpen,onBusyChange}:{value:Settings;set:(value:Settings)=>void;runtime:Runtime|null;disabled:boolean;pickerOpen:boolean;setPickerOpen:(open:boolean)=>void;onBusyChange:(busy:boolean)=>void}){
  const browseButton=useRef<HTMLButtonElement>(null),mode=value.deepseekConversationStorageMode||'isolated',paths=runtime?.deepseekConversationStorage;
  const defaultHome=paths?.defaultHome||'',nativeHome=paths?.nativeHome||'';
  const selectedHome=value.deepseekConversationStorageDirectory||defaultHome;
  return <fieldset className="settings-help settings-provider-group dsh-conversation-storage"><legend>DeepSeek conversation storage</legend>
    <label>Conversation folder<select aria-label="DeepSeek conversation storage" value={mode} disabled={disabled} onChange={event=>set({...value,deepseekConversationStorageMode:event.target.value as NonNullable<Settings['deepseekConversationStorageMode']>})}><option value="isolated">Use a separate conversation folder</option><option value="native">Use my DSH home</option></select></label>
    {mode==='isolated'?<>
      <label>Separate conversation folder<div className="project-root-control"><input value={selectedHome} readOnly aria-readonly="true" aria-label="Opnex DSH conversation folder" title={selectedHome||undefined} placeholder="Loading the Opnex default folder…" spellCheck={false}/><button ref={browseButton} type="button" className="project-root-browse" aria-label="Browse DSH conversation folder" aria-haspopup="dialog" aria-controls="project-root-folder-dialog" aria-expanded={pickerOpen} onClick={()=>setPickerOpen(true)} disabled={disabled||!defaultHome}><span>Browse</span></button></div><small>{value.deepseekConversationStorageDirectory?'New conversations use this folder.':'New conversations use the Opnex default folder.'} Existing sessions stay where they were created.</small></label>
      {pickerOpen&&<DirectoryPicker initialPath={selectedHome||nativeHome} onBusyChange={onBusyChange} onCancel={()=>{setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}} onSelect={directory=>{set({...value,deepseekConversationStorageDirectory:directory});setPickerOpen(false);requestAnimationFrame(()=>browseButton.current?.focus());}}/>}
    </>:<small>New conversations use your DSH home: <code>{nativeHome||'DSH_HOME (from the environment)'}</code>. Existing sessions stay where they were created.</small>}
    <small>This affects new conversations only. DSH’s profile, tools, permissions, and credentials remain in your normal DSH home.</small>
  </fieldset>;
}

const codexRoleLabels:Record<typeof codexMcpRoles[number],string>={router:'Router',direct:'Direct answer',simple:'Simple implementation',orchestrator:'Orchestrator',worker:'Worker',integrator:'Integrator',qa:'QA auditor'};
const deepSeekRoleLabels:Record<typeof deepSeekMcpRoles[number],string>={simple:'Simple implementation',worker:'Worker',integrator:'Integrator'};
export function McpServerSettings({value,set,disabled}:{value:Settings;set:(value:Settings)=>void;disabled:boolean}){
  const servers=value.mcpServers||[];
  const update=(index:number,patch:Partial<McpServerRegistration>)=>set({...value,mcpServers:servers.map((server,row)=>row===index?{...server,...patch}:server)});
  const add=()=>{
    let suffix=1,name=`server-${suffix}`;while(servers.some(server=>server.name===name)){suffix++;name=`server-${suffix}`;}
    set({...value,mcpServers:[...servers,{name,transport:'stdio',command:'npx',args:[],envVars:[],codexRoles:['direct','simple','orchestrator','worker','integrator'],deepseekRoles:[...deepSeekMcpRoles]}]});
  };
  const toggleRole=(server:McpServerRegistration,field:'codexRoles'|'deepseekRoles',role:string,checked:boolean)=>{
    const current=server[field] as readonly string[];const next=checked?[...current,role]:current.filter(item=>item!==role);return {[field]:next} as Partial<McpServerRegistration>;
  };
  return <fieldset className="mcp-server-settings"><legend>MCP servers</legend>
    <p className="mcp-server-intro">Register stdio or Streamable HTTP servers and choose which Opnex roles can use each one. Server names are prefixed with <code>opnex_</code>. Credentials are environment variable references; set their values before launching Opnex.</p>
    {servers.map((server,index)=><section className="mcp-server-card" key={index}>
      <div className="mcp-server-heading"><strong>MCP server {index+1}</strong><button type="button" className="text-button" onClick={()=>set({...value,mcpServers:servers.filter((_,row)=>row!==index)})} disabled={disabled}>Remove</button></div>
      <label>Server name<input disabled={disabled} value={server.name} maxLength={48} onChange={event=>update(index,{name:event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g,'-').replace(/^[^a-z]+/,'')})}/><small>Lowercase letters, numbers, hyphens and underscores; the runtime name gets an <code>opnex_</code> prefix.</small></label>
      <label>Transport<select disabled={disabled} value={server.transport||'stdio'} onChange={event=>update(index,{transport:event.target.value as McpServerRegistration['transport']})}><option value="stdio">Local stdio</option><option value="streamable-http">Streamable HTTP</option></select></label>
      {server.transport==='streamable-http'?<>
        <label>Streamable HTTP URL<input disabled={disabled} type="url" value={server.url||''} maxLength={2048} placeholder="https://mcp.example.com/mcp" onChange={event=>update(index,{url:event.target.value||undefined})}/><small>Use HTTPS for remote servers; credentials and query parameters are not allowed in the URL. Plain HTTP is accepted only for localhost, 127.0.0.1, or ::1.</small></label>
        <div className="mcp-http-headers"><strong>HTTP headers</strong>{(server.httpHeaders||[]).map((header,headerIndex)=><div className="mcp-http-header-row" key={headerIndex}>
          <label>Header name<input disabled={disabled} maxLength={128} value={header.name} onChange={event=>update(index,{httpHeaders:(server.httpHeaders||[]).map((row,current)=>current===headerIndex?{...row,name:event.target.value}:row)})}/></label>
          <label>Environment variable<input disabled={disabled} maxLength={128} value={header.envVar} placeholder="MCP_AUTHORIZATION" onChange={event=>update(index,{httpHeaders:(server.httpHeaders||[]).map((row,current)=>current===headerIndex?{...row,envVar:event.target.value}:row)})}/></label>
          <button type="button" className="text-button" aria-label={`Remove HTTP header ${headerIndex+1}`} disabled={disabled} onClick={()=>update(index,{httpHeaders:(server.httpHeaders||[]).filter((_,current)=>current!==headerIndex)})}>Remove</button>
        </div>)}
          <button type="button" className="text-button" disabled={disabled||(server.httpHeaders||[]).length>=32} onClick={()=>update(index,{httpHeaders:[...(server.httpHeaders||[]),{name:'',envVar:''}]})}>Add HTTP header</button>
          <small>Set each variable in the environment Opnex inherits; its value is never saved. For Authorization, include the Bearer prefix in the variable value if required.</small>
        </div>
      </>:<>
      <div className="mcp-server-fields">
        <label>Command<input disabled={disabled} value={server.command} maxLength={1024} placeholder="npx" onChange={event=>update(index,{command:event.target.value})}/></label>
        <label>Arguments<textarea disabled={disabled} rows={3} value={server.args.join('\n')} placeholder={'-y\n@company/example-mcp'} onChange={event=>update(index,{args:event.target.value?event.target.value.split(/\r?\n/):[]})}/><small>One argument per line. Arguments are passed as separate values without shell interpolation.</small></label>
        <label>Working directory<input disabled={disabled} value={server.cwd||''} maxLength={1024} placeholder="Defaults to the selected workspace" onChange={event=>update(index,{cwd:event.target.value||undefined})}/></label>
      </div>
      <label className="mcp-env-vars">Environment variables<textarea disabled={disabled} rows={2} value={server.envVars.join('\n')} placeholder="MCP_API_TOKEN" onChange={event=>update(index,{envVars:[...new Set(event.target.value.split(/\r?\n/).map(variable=>variable.trim().toUpperCase()).filter(Boolean))]})}/><small>One uppercase variable name per line. Set each value in the environment Opnex inherits before launching the app; secrets are never saved in Opnex settings.</small></label>
      </>}
      <div className="mcp-role-columns">
        <div><strong>Codex roles</strong><div className="mcp-role-list">{codexMcpRoles.map(role=><label className="mcp-role-checkbox" key={role}><input type="checkbox" checked={server.codexRoles.includes(role)} onChange={event=>update(index,toggleRole(server,'codexRoles',role,event.target.checked))} disabled={disabled}/>{codexRoleLabels[role]}</label>)}</div></div>
        <div><strong>DeepSeek Harness roles</strong><div className="mcp-role-list">{deepSeekMcpRoles.map(role=><label className="mcp-role-checkbox" key={role}><input type="checkbox" checked={server.deepseekRoles.includes(role)} onChange={event=>update(index,toggleRole(server,'deepseekRoles',role,event.target.checked))} disabled={disabled}/>{deepSeekRoleLabels[role]}</label>)}</div></div>
      </div>
    </section>)}
    <button type="button" className="secondary-btn mcp-add-server" onClick={add} disabled={disabled||servers.length>=20}>Add MCP server</button>
    <small>Opnex supports stdio and Streamable HTTP MCP servers for Codex and DeepSeek Harness. Interactive MCP OAuth setup is not available here; configure HTTP authentication through environment-backed headers. Direct router and QA access is off unless selected above. Selecting a role allows it to call every tool exposed by that server without a per-call prompt. Local server processes run as your OS user; Opnex workspace sandbox and write-root limits do not constrain them or remote server actions.</small>
  </fieldset>;
}

function SettingsDialog({open,settings,models,runtime,close,saved,reconnect}:SettingsDialogProps){
  const [value,set]=useState(settings),[saving,setSaving]=useState(false),[reconnecting,setReconnecting]=useState(false),[stoppingKernel,setStoppingKernel]=useState(false),[connectionError,setConnectionError]=useState(''),[directoryPickerOpen,setDirectoryPickerOpen]=useState(false),[directoryPickerBusy,setDirectoryPickerBusy]=useState(false);
  const first=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLElement>(null),restoreFocus=useRef<HTMLElement|null>(null),wasOpen=useRef(false);
  useLayoutEffect(()=>{if(open){if(!wasOpen.current)set(settings);restoreFocus.current=document.activeElement as HTMLElement;const firstField=dialog.current?.querySelector<HTMLButtonElement>('button[aria-label="Worker model"]:not(:disabled)')||dialog.current?.querySelector<HTMLInputElement>('input:not(:disabled)');(firstField||first.current)?.focus();}else{restoreFocus.current?.focus();restoreFocus.current=null;}wasOpen.current=open;},[open,settings]);
  useEffect(()=>{const onEscape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!saving&&!reconnecting&&!stoppingKernel&&!directoryPickerOpen)close();};window.addEventListener('keydown',onEscape);return()=>window.removeEventListener('keydown',onEscape);},[close,saving,reconnecting,stoppingKernel,directoryPickerOpen]);
  const trapDialogTab=(event:ReactKeyboardEvent<HTMLElement>)=>{if(event.key!=='Tab'||!open||directoryPickerOpen)return;const items=Array.from(dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')||[]).filter(item=>!item.closest('[hidden],[inert],[aria-hidden="true"]'));const firstItem=items[0],lastItem=items[items.length-1];if(!firstItem){event.preventDefault();first.current?.focus();return;}if(event.shiftKey&&document.activeElement===firstItem){event.preventDefault();lastItem.focus();}else if(!event.shiftKey&&document.activeElement===lastItem){event.preventDefault();firstItem.focus();}};
  const save=async()=>{if(saving||directoryPickerOpen||directoryPickerBusy)return;setSaving(true);try{if(await saved(value))close();}finally{setSaving(false);}};
  const reconnectNow=async()=>{if(reconnecting)return;setReconnecting(true);setConnectionError('');try{await api('/api/runtime/refresh',{});await reconnect();}catch(error){setConnectionError(error instanceof Error?error.message:'Could not reconnect to Codex.');}finally{setReconnecting(false);}};
  const stopKernel=async()=>{if(stoppingKernel||saving||reconnecting)return;if(!window.confirm('Stop the Opnex kernel? Active work will be paused, saved messages and receipts will remain available, and connected clients will disconnect.'))return;setStoppingKernel(true);setConnectionError('');try{await api('/api/v1/kernel/shutdown',{confirm:'stop-kernel'});close();await (window.opnexDesktop||window.pseudoharnessDesktop)?.quit?.();}catch(error){setConnectionError(error instanceof Error?error.message:'The kernel could not be stopped safely.');setStoppingKernel(false);}};
  return <div className="dialog-backdrop" data-open={open} aria-hidden={!open} inert={!open} onMouseDown={event=>event.target===event.currentTarget&&!saving&&!reconnecting&&!stoppingKernel&&close()}><section ref={dialog} className="settings-dialog" data-open={open} role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={trapDialogTab}>
    <header><div><h2 id="settings-title">Settings</h2><p>Application defaults</p></div><button ref={first} className="icon-btn" onClick={close} aria-label="Close settings" disabled={saving||reconnecting||stoppingKernel}><X size={16}/></button></header>
    <WorkerExecutionSettings value={value} set={set} models={models} disabled={saving||reconnecting||stoppingKernel||directoryPickerOpen}/>
    {workerProfile(value).provider==='deepseek'&&<DeepSeekConversationStorageSettings value={value} set={set} runtime={runtime} disabled={saving||reconnecting||stoppingKernel} pickerOpen={directoryPickerOpen} setPickerOpen={setDirectoryPickerOpen} onBusyChange={setDirectoryPickerBusy}/>}
    <div className="settings-select-row"><span>Approval policy</span><ChoicePopover label="Approval policy" caption="" value={value.approvalPolicy||'on-request'} disabled={saving||stoppingKernel} options={[{value:'on-request',label:'On request'},{value:'untrusted',label:'Untrusted commands'},{value:'never',label:'Never ask'},{value:'full-access',label:'Full access (auto approve)'}]} onChange={policy=>set({...value,approvalPolicy:policy as Settings['approvalPolicy']})}/></div>
    <small className="settings-help">Full access applies to hard-task Codex roles and writable DeepSeek Harness recruitment. No-write DeepSeek Harness assignments use the read-only preset. Router and direct-answer roles stay read-only; workspace selection controls the working directory.</small>
    <div className="settings-connection"><strong>Connections</strong><div><span className={`tiny-dot ${runtime?.codex.state==='connected'?'online':'offline'}`}/>Codex app-server <b>{runtime?.codex.state||'starting'}</b></div>{runtime?.codex.error&&<p>{runtime.codex.error}</p>}{connectionError&&<p role="alert">{connectionError}</p>}<button className="text-button" onClick={()=>void reconnectNow()} disabled={reconnecting||stoppingKernel}>{reconnecting?'Reconnecting…':'Reconnect Codex'} <ChevronRight size={13}/></button><button className="text-button" onClick={()=>void stopKernel()} disabled={saving||reconnecting||stoppingKernel}>{stoppingKernel?'Stopping kernel…':'Stop Opnex kernel'}</button><small>Closing the window only disconnects this client. Stopping the kernel pauses active work and disconnects all clients.</small></div>
    <footer><button className="secondary-btn" onClick={close} disabled={saving||reconnecting||stoppingKernel||directoryPickerOpen}>Cancel</button><button className="primary-btn" disabled={saving||reconnecting||stoppingKernel||directoryPickerOpen||directoryPickerBusy} onClick={()=>void save()}>{saving?'Saving…':'Save settings'}</button></footer>
  </section></div>;
}

const sameSettings=(a:Settings,b:Settings)=>a.orchestratorModel===b.orchestratorModel&&a.orchestratorEffort===b.orchestratorEffort&&a.approvalPolicy===b.approvalPolicy&&JSON.stringify(a.executionProfile)===JSON.stringify(b.executionProfile)&&a.deepseekProvider===b.deepseekProvider&&a.deepseekModel===b.deepseekModel&&a.deepseekReasoningEffort===b.deepseekReasoningEffort&&a.deepseekConversationStorageMode===b.deepseekConversationStorageMode&&a.deepseekConversationStorageDirectory===b.deepseekConversationStorageDirectory&&JSON.stringify(a.mcpServers||[])===JSON.stringify(b.mcpServers||[]);
const sameModels=(a:Runtime['codex']['models'],b:Runtime['codex']['models'])=>a.length===b.length&&a.every((model,index)=>{const other=b[index];return model.id===other.id&&model.displayName===other.displayName&&model.efforts.length===other.efforts.length&&model.efforts.every((effort,i)=>effort===other.efforts[i]);});
export default memo(SettingsDialog,(a,b)=>a.open===b.open&&sameSettings(a.settings,b.settings)&&sameModels(a.models,b.models)&&a.runtime?.codex.state===b.runtime?.codex.state&&a.runtime?.codex.error===b.runtime?.codex.error&&a.runtime?.deepseekConversationStorage?.defaultHome===b.runtime?.deepseekConversationStorage?.defaultHome&&a.runtime?.deepseekConversationStorage?.nativeHome===b.runtime?.deepseekConversationStorage?.nativeHome);
