export type GraphCommit={hash:string;parents:string[]};
export type GraphEdge={row:number;parentRow:number|null;fromLane:number;toLane:number;parentHash:string;mergeParent:boolean};
export type GraphLayout={positions:number[];edges:GraphEdge[];laneCount:number;rowHeight:number};

/** Lay out the loaded history, then project visible rows without reallocating their lanes. */
export function layoutCommitGraph(commits:GraphCommit[],visibleCommits:GraphCommit[]=commits):GraphLayout{
  const rowByHash=new Map(commits.map((commit,index)=>[commit.hash,index]));
  const occupied:string[]=[];const positions:number[]=[];const allEdges:GraphEdge[]=[];const rowHeight=50;
  for(let row=0;row<commits.length;row++){
    const commit=commits[row];let lane=occupied.indexOf(commit.hash);
    if(lane<0){lane=occupied.findIndex(value=>!value);if(lane<0)lane=occupied.length;occupied[lane]=commit.hash;}
    positions[row]=lane;occupied[lane]='';
    const parents=[...new Set(commit.parents)];
    for(let parentIndex=0;parentIndex<parents.length;parentIndex++){
      const parentHash=parents[parentIndex];const parentRow=rowByHash.get(parentHash);let targetLane=occupied.indexOf(parentHash);
      if(targetLane<0){
        targetLane=parentIndex===0&&!occupied[lane]?lane:occupied.findIndex(value=>!value);
        if(targetLane<0)targetLane=occupied.length;
        // Reserve unloaded parents so paging in their commits keeps existing lanes stable.
        occupied[targetLane]=parentHash;
      }
      allEdges.push({row,parentRow:parentRow??null,fromLane:lane,toLane:targetLane,parentHash,mergeParent:parentIndex>0});
    }
  }

  const visibleRowByHash=new Map(visibleCommits.map((commit,index)=>[commit.hash,index]));
  const visiblePositions=visibleCommits.map(commit=>{
    const row=rowByHash.get(commit.hash);
    return row===undefined?0:positions[row];
  });
  const visibleEdges=allEdges.flatMap(edge=>{
    const row=visibleRowByHash.get(commits[edge.row].hash);
    if(row===undefined)return [];
    const parentRow=edge.parentRow===null?null:visibleRowByHash.get(commits[edge.parentRow].hash)??null;
    return [{...edge,row,parentRow}];
  });
  const laneCount=Math.max(1,occupied.length,...positions.map(value=>value+1),...allEdges.map(edge=>Math.max(edge.fromLane,edge.toLane)+1));
  return {positions:visiblePositions,edges:visibleEdges,laneCount,rowHeight};
}
