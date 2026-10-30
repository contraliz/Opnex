export const AGENTMEM_MODEL_READ_TOOLS=new Set(['attach_project','retrieve_evidence','decisions','requirements','lessons','knowledge','repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','check_project_changes']);
export const AGENTMEM_MODEL_WRITE_TOOLS=new Set(['knowledge','decisions','requirements','lessons','update_project_brief','index_project','repository_resync']);
export const AGENTMEM_MODEL_TOOLS=new Set([...AGENTMEM_MODEL_READ_TOOLS,...AGENTMEM_MODEL_WRITE_TOOLS]);

const allowedActions:Record<string,string[]>={knowledge:['list','read','create','update','history'],decisions:['list','show','history','get','create'],requirements:['list','show','get','history','create','revise','fulfill'],lessons:['retrieve','propose','review']};
const readOnlyActions:Record<string,string[]>={knowledge:['list','read','history'],decisions:['list','show','history','get'],requirements:['list','show','get','history'],lessons:['retrieve']};
const identityKeys=new Set(['project_id','cwd','root','source_root','memory_root','project_ids','project_roots','repository_id','repository_root','worktree_id']);

export function scopeAgentMemToolSchema(schema:any,name?:string,readOnly=false){
  const properties={...schema?.properties};delete properties.project_id;delete properties.repository_id;delete properties.repository_root;delete properties.root;delete properties.cwd;delete properties.source_root;
  if(name&&allowedActions[name]&&properties.action)properties.action={...properties.action,enum:readOnly?(readOnlyActions[name]||[]):allowedActions[name]};
  const required=Array.isArray(schema?.required)?schema.required.filter((key:string)=>!identityKeys.has(key)):undefined;
  return {...schema,properties,...(required?{required}:{})};
}

function assertNoAlternateIdentity(value:unknown){
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const item of value)assertNoAlternateIdentity(item);return;}
  for(const [key,child] of Object.entries(value)){
    if(identityKeys.has(key))throw new Error('AgentMem calls are restricted to the selected project; alternate roots and project lists are not permitted.');
    if(key==='project_id'&&child!==undefined)throw new Error('AgentMem calls are restricted to the selected project.');
    assertNoAlternateIdentity(child);
  }
}

export function scopeAgentMemToolArgs(name:string,value:unknown,projectId:string,repositoryId:string,projectRoot='',readOnly=false){
  if(!AGENTMEM_MODEL_TOOLS.has(name))throw new Error('This AgentMem tool is unavailable in project-scoped sessions.');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('AgentMem tool arguments must be an object.');
  assertNoAlternateIdentity(value);
  const args={...(value as Record<string,unknown>)};
  const allowed=allowedActions[name]&&(readOnly?(readOnlyActions[name]||[]):allowedActions[name]);
  if(readOnly&&AGENTMEM_MODEL_WRITE_TOOLS.has(name)&&!allowed)throw new Error('AgentMem writes are unavailable in this read-only project role.');
  if(allowed&&(!allowed.includes(String(args.action))))throw new Error(`The AgentMem ${name} action must be one of: ${allowed.join(', ')}.`);
  if(args.force===true)throw new Error('AgentMem writes cannot bypass revision or conflict checks.');
  const scoped:Record<string,unknown>={...args,project_id:projectId};
  if(['repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','repository_resync'].includes(name))scoped.repository_id=repositoryId;
  return scoped;
}
