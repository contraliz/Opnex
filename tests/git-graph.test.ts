import { describe, expect, it } from 'vitest';
import { layoutCommitGraph } from '../src/ui/git-graph.js';

describe('commit graph layout',()=>{
  it('draws every merge parent on distinct lanes and lets both paths converge',()=>{
    const layout=layoutCommitGraph([
      {hash:'merge',parents:['main','feature']},
      {hash:'main',parents:['base']},
      {hash:'feature',parents:['base']},
      {hash:'base',parents:[]},
    ]);
    const mergeEdges=layout.edges.filter(edge=>edge.row===0);
    expect(mergeEdges).toHaveLength(2);
    expect(new Set(mergeEdges.map(edge=>edge.parentHash))).toEqual(new Set(['main','feature']));
    expect(mergeEdges.map(edge=>edge.parentRow)).toEqual([1,2]);
    expect(new Set(mergeEdges.map(edge=>edge.toLane)).size).toBe(2);
    expect(layout.edges.filter(edge=>edge.parentHash==='base')).toHaveLength(2);
  });

  it('marks parents missing from a filtered or paged set as external edges',()=>{
    const layout=layoutCommitGraph([{hash:'page-tail',parents:['not-loaded']}]);
    expect(layout.edges).toEqual([{row:0,parentRow:null,fromLane:0,toLane:0,parentHash:'not-loaded',mergeParent:false}]);
  });
});
