function navigationState(contents){
  const history=contents.navigationHistory;
  return {canGoBack:history.canGoBack(),canGoForward:history.canGoForward()};
}

function navigate(contents,action){
  if(action==='reload'){
    contents.reload();
    return;
  }
  if(action!=='back'&&action!=='forward')return;

  const history=contents.navigationHistory;
  if(action==='back'&&history.canGoBack())history.goBack();
  else if(action==='forward'&&history.canGoForward())history.goForward();
}

function attachNavigationHandlers(contents,{validateUrl,onMainFrameStart}){
  const guard=details=>{
    try{validateUrl(details.url);}catch{details.preventDefault();}
  };
  contents.on('will-navigate',guard);
  contents.on('will-redirect',guard);
  contents.on('did-start-navigation',details=>{
    if(details.isMainFrame)onMainFrameStart(details.url);
  });
}

module.exports={navigationState,navigate,attachNavigationHandlers};
