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

  it('keeps existing lanes stable when older parent commits are paged in',()=>{
    const firstPage=[
      {hash:'head',parents:['main','feature']},
      {hash:'unrelated',parents:['side']},
    ];
    const fullHistory=[...firstPage,
      {hash:'main',parents:['base']},
      {hash:'feature',parents:['base']},
      {hash:'side',parents:['base']},
      {hash:'base',parents:[]},
    ];
    const firstLayout=layoutCommitGraph(firstPage);
    const fullLayout=layoutCommitGraph(fullHistory);

    expect(fullLayout.positions.slice(0,firstPage.length)).toEqual(firstLayout.positions);
    expect(fullLayout.edges.filter(edge=>edge.row<firstPage.length).map(({row,fromLane,toLane,parentHash,mergeParent})=>({row,fromLane,toLane,parentHash,mergeParent})))
      .toEqual(firstLayout.edges.map(({row,fromLane,toLane,parentHash,mergeParent})=>({row,fromLane,toLane,parentHash,mergeParent})));
  });

  it('preserves lanes while filtering rows and marks hidden parents as external',()=>{
    const commits=[
      {hash:'merge',parents:['main','feature']},
      {hash:'main',parents:['base']},
      {hash:'feature',parents:['base']},
      {hash:'base',parents:[]},
    ];
    const full=layoutCommitGraph(commits);
    const filtered=layoutCommitGraph(commits,[commits[0],commits[2]]);
    const featureBaseEdge=filtered.edges.find(edge=>edge.row===1&&edge.parentHash==='base');

    expect(filtered.positions).toEqual([full.positions[0],full.positions[2]]);
    expect(filtered.laneCount).toBe(full.laneCount);
    expect(featureBaseEdge).toMatchObject({parentRow:null,toLane:full.edges.find(edge=>edge.row===2&&edge.parentHash==='base')?.toLane});
  });
});
