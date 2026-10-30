import { describe, expect, it } from 'vitest';
import { workspaceOptionLabel } from '../src/ui/workspace-label.js';
import type { Project } from '../src/types.js';

const workspace=(id:string,projectRoot:string,name=projectRoot.split(/[\\/]+/).filter(Boolean).at(-1)||'')=>({id,name,projectRoot,needsLocation:false,pinned:false,createdAt:'2026-10-30T00:00:00Z',updatedAt:'2026-10-30T00:00:00Z'} satisfies Project);

describe('workspace labels',()=>{
  it('adds the parent folder when workspace folder names collide',()=>{
    const rows=[workspace('one','C:/work/client/Opnex'),workspace('two','D:/archive/opnex')];
    expect(rows.map(row=>workspaceOptionLabel(row,rows))).toEqual(['Opnex · client','opnex · archive']);
  });
  it('uses the full root when both the workspace and parent names collide',()=>{
    const rows=[workspace('one','C:/source/apps/demo'),workspace('two','D:/source/apps/demo')];
    expect(rows.map(row=>workspaceOptionLabel(row,rows))).toEqual(rows.map(row=>`demo · ${row.projectRoot}`));
  });
  it('leaves a unique workspace name compact',()=>{
    const rows=[workspace('one','C:/work/Opnex')];
    expect(workspaceOptionLabel(rows[0]!,rows)).toBe('Opnex');
  });
  it('derives the visible name from the root even when an older saved display name is stale',()=>{
    const rows=[workspace('one','C:/work/client/shared','Former name'),workspace('two','D:/archive/app/shared','Another former name')];
    expect(rows.map(row=>workspaceOptionLabel(row,rows))).toEqual(['shared · client','shared · app']);
  });
});
