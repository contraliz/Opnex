function codexThreadUrl(threadId){
  if(typeof threadId!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(threadId))throw new Error('A valid Codex thread ID is required.');
  const url=new URL(`codex://threads/${encodeURIComponent(threadId)}`);
  if(url.protocol!=='codex:'||url.hostname!=='threads'||url.pathname!==`/${threadId}`||url.search||url.hash||url.username||url.password)throw new Error('Only exact Codex thread links are supported.');
  return url.toString();
}

async function openCodexThread(threadId,openExternal){
  if(typeof openExternal!=='function')throw new Error('The Codex desktop link handler is unavailable.');
  await openExternal(codexThreadUrl(threadId));
  return true;
}

module.exports={codexThreadUrl,openCodexThread};
