import type { Project } from '../types';

export function workspaceOptionLabel(workspace:Project,workspaces:Project[]){
  const label=(row:Project)=>row.projectRoot.split(/[\\/]+/).filter(Boolean).at(-1)||row.name;
  const name=label(workspace);
  const collision=workspaces.filter(row=>label(row).toLocaleLowerCase()===name.toLocaleLowerCase());
  if(collision.length<2)return name;
  const parts=workspace.projectRoot.split(/[\\/]+/).filter(Boolean),parent=parts.at(-2);
  const parentCollides=collision.some(row=>row.id!==workspace.id&&row.projectRoot.split(/[\\/]+/).filter(Boolean).at(-2)?.toLocaleLowerCase()===parent?.toLocaleLowerCase());
  return `${name} · ${!parent||parentCollides?workspace.projectRoot:parent}`;
}
