function clampNativeBounds(rect,contentSize){
  if(!rect||!contentSize||![rect.x,rect.y,rect.width,rect.height,contentSize.width,contentSize.height].every(Number.isFinite)||rect.width<=0||rect.height<=0||contentSize.width<=0||contentSize.height<=0)return {x:0,y:0,width:0,height:0};
  const x=Math.max(0,Math.round(rect.x));
  const y=Math.max(0,Math.round(rect.y));
  const right=Math.min(Math.floor(contentSize.width),Math.round(rect.x+rect.width));
  const bottom=Math.min(Math.floor(contentSize.height),Math.round(rect.y+rect.height));
  const width=Math.max(0,right-x);
  const height=Math.max(0,bottom-y);
  return width>0&&height>0?{x,y,width,height}:{x:0,y:0,width:0,height:0};
}

module.exports={clampNativeBounds};
