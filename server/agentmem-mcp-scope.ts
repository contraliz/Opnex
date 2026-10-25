export const AGENTMEM_MODEL_READ_TOOLS=new Set(['attach_project','retrieve_evidence','decisions','requirements','lessons','knowledge','repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','check_project_changes']);
export const AGENTMEM_MODEL_WRITE_TOOLS=new Set(['knowledge','decisions','requirements','lessons','update_project_brief','index_project','repository_resync','projects','repository_register']);
export const AGENTMEM_MODEL_TOOLS=new Set([...AGENTMEM_MODEL_READ_TOOLS,...AGENTMEM_MODEL_WRITE_TOOLS]);

const allowedActions:Record<string,string[]>={knowledge:['list','read','create','update','history'],decisions:['list','show','history','get','create'],requirements:['list','show','get','history','create','revise','fulfill'],lessons:['retrieve','propose','review'],projects:['register']};
const identityKeys=new Set(['project_id','cwd','root','source_root','memory_root','project_ids','project_roots','repository_id','repository_root','worktree_id']);

export function scopeAgentMemToolSchema(schema:any,name?:string,setupMode:'register'|'repository'|'ready'='ready'){
  const properties={...schema?.properties};delete properties.project_id;delete properties.repository_id;delete properties.repository_root;delete properties.root;delete properties.cwd;delete properties.source_root;
  if(name&&allowedActions[name]&&properties.action)properties.action={...properties.action,enum:allowedActions[name]};
  if(name==='projects'&&setupMode!=='register')return {...schema,properties:{},required:[]};
  if(name==='repository_register'&&setupMode==='ready')return {...schema,properties:{},required:[]};
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

export function scopeAgentMemToolArgs(name:string,value:unknown,projectId:string,repositoryId:string,projectRoot='',setupMode:'register'|'repository'|'ready'='ready'){
  if(!AGENTMEM_MODEL_TOOLS.has(name))throw new Error('This AgentMem tool is unavailable in project-scoped sessions.');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('AgentMem tool arguments must be an object.');
  assertNoAlternateIdentity(value);
  const args={...(value as Record<string,unknown>)};
  const allowed=allowedActions[name];
  if(allowed&&(!allowed.includes(String(args.action))))throw new Error(`The AgentMem ${name} action must be one of: ${allowed.join(', ')}.`);
  if(args.force===true)throw new Error('AgentMem writes cannot bypass revision or conflict checks.');
  if(name==='projects'){
    if(setupMode!=='register'||args.action!=='register')throw new Error('AgentMem project registration is only available for the unregistered project selected in Settings.');
    return {action:'register',project_id:projectId,root:projectRoot,description:typeof args.description==='string'?args.description:''};
  }
  if(name==='repository_register'){
    if(setupMode==='ready')throw new Error('Repository registration is only available while setting up the selected project.');
    return {project_id:projectId,repository_root:projectRoot};
  }
  const scoped:Record<string,unknown>={...args,project_id:projectId};
  if(['repository_search','repository_retrieve','repository_status','repository_graph_status','repository_graph_query','repository_graph_path','repository_graph_impact','repository_graph_summary','repository_resync'].includes(name))scoped.repository_id=repositoryId;
  return scoped;
}
