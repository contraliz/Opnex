const panes=['main','side','chat'];
function assignTabToPane(assignments,id,pane){
  if(!panes.includes(pane))throw new Error('Unknown browser pane.');
  const next={...assignments};for(const key of panes)if(next[key]===id)next[key]=null;next[pane]=id;return next;
}
function removeTabFromPanes(assignments,id){const next={...assignments};for(const key of panes)if(next[key]===id)next[key]=null;return next;}
module.exports={assignTabToPane,removeTabFromPanes};
