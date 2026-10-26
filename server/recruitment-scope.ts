import path from 'node:path';
import type { Assignment } from './contracts.js';
import { assignmentWriteRoots } from './policy.js';

export function rebaseRecruitmentAssignment(assignment:Assignment,canonicalRoot:string,worktreeRoot:string):Assignment{
  const canonical=path.resolve(canonicalRoot),workspace=path.resolve(worktreeRoot);
  const mapPath=(value:string)=>{
    if(!path.isAbsolute(value))return value;
    const resolved=path.resolve(value),relative=path.relative(canonical,resolved);
    if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw new Error(`Assignment scope escapes the selected project root: ${value}`);
    return path.join(workspace,relative);
  };
  const writeRoots=assignmentWriteRoots(assignment,canonical);
  const writeScope=assignment.write_scope.length?writeRoots.map(root=>path.join(workspace,path.relative(canonical,root))):[];
  for(const item of assignment.read_scope)if(path.isAbsolute(item))mapPath(item);
  return {...structuredClone(assignment),read_scope:assignment.read_scope.map(mapPath),write_scope:writeScope};
}
