export type GraphCommit={hash:string;parents:string[]};
export type GraphEdge={row:number;parentRow:number|null;fromLane:number;toLane:number;parentHash:string;mergeParent:boolean};
export type GraphLayout={positions:number[];edges:GraphEdge[];laneCount:number;rowHeight:number};

export function layoutCommitGraph(commits:GraphCommit[]):GraphLayout{
  const rowByHash=new Map(commits.map((commit,index)=>[commit.hash,index]));
  const occupied:string[]=[];const positions:number[]=[];const edges:GraphEdge[]=[];const rowHeight=50;
  for(let row=0;row<commits.length;row++){
    const commit=commits[row];let lane=occupied.indexOf(commit.hash);
    if(lane<0){lane=occupied.findIndex(value=>!value);if(lane<0)lane=occupied.length;occupied[lane]=commit.hash;}
    positions[row]=lane;occupied[lane]='';
    const parents=[...new Set(commit.parents)];
    for(let parentIndex=0;parentIndex<parents.length;parentIndex++){
      const parentHash=parents[parentIndex];const parentRow=rowByHash.get(parentHash);let targetLane:number;
      if(parentRow===undefined){
        targetLane=parentIndex===0?lane:occupied.findIndex(value=>!value);
        if(targetLane<0)targetLane=occupied.length;
        occupied[targetLane]='';
        edges.push({row,parentRow:null,fromLane:lane,toLane:targetLane,parentHash,mergeParent:parentIndex>0});
        continue;
      }
      targetLane=occupied.indexOf(parentHash);
      if(targetLane<0){
        targetLane=parentIndex===0&&!occupied[lane]?lane:occupied.findIndex(value=>!value);
        if(targetLane<0)targetLane=occupied.length;
        occupied[targetLane]=parentHash;
      }
      edges.push({row,parentRow,fromLane:lane,toLane:targetLane,parentHash,mergeParent:parentIndex>0});
    }
  }
  return {positions,edges,laneCount:Math.max(1,occupied.length,...positions.map(value=>value+1),...edges.map(edge=>Math.max(edge.fromLane,edge.toLane)+1)),rowHeight};
}
