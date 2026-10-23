export class ApiError extends Error {
  constructor(message:string,readonly status?:number,readonly code?:string,options?:ErrorOptions){super(message,options);this.name='ApiError';}
  override toString(){return this.message;}
}

let token='';

function asMessage(value:unknown):string|undefined{
  if(typeof value==='string'){
    const message=value.trim();
    if(!message)return;
    if(message.startsWith('{')||message.startsWith('[')){try{return asMessage(JSON.parse(message));}catch{/* Keep the bounded plain-text message below. */}}
    return message.length<500?message:undefined;
  }
  if(Array.isArray(value)){
    const issues=value.map(issue=>{
      if(!issue||typeof issue!=='object')return '';
      const item=issue as Record<string,unknown>;
      const field=Array.isArray(item.path)?item.path.map(part=>String(part).replaceAll('_',' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase()).join(' '):'';
      const message=typeof item.message==='string'?item.message:'';
      return [field,message].filter(Boolean).join(': ');
    }).filter(Boolean);
    if(issues.length)return `Please check ${issues.slice(0,3).join('; ')}.`;
    return;
  }
  if(!value||typeof value!=='object')return;
  const record=value as Record<string,unknown>;
  if(typeof record.message==='string'&&record.message.trim())return asMessage(record.message);
  if(typeof record.error==='string'&&record.error.trim())return asMessage(record.error);
  if(record.error&&typeof record.error==='object')return asMessage(record.error);
  if(Array.isArray(record.issues))return asMessage(record.issues);
  return;
}

function statusFallback(status:number){
  if(status===400)return 'The request contains invalid or missing information. Check the values and try again.';
  if(status===401||status===403)return 'The local request was rejected. Reload Pseudoharness and try again.';
  if(status===404)return 'That local service route is unavailable. Restart Pseudoharness and reload the page.';
  if(status===409)return 'The request conflicts with the current task state. Refresh and try again.';
  if(status>=500)return 'The local service could not complete the request. Check the local server and retry.';
  return `The local service rejected the request (HTTP ${status}).`;
}

async function readJson(response:Response):Promise<any>{
  const contentType=response.headers.get('content-type')||'';
  const text=await response.text().catch(()=> '');
  const looksLikeHtml=contentType.toLowerCase().includes('text/html')||/^\s*<!doctype\s+html|^\s*<html\b/i.test(text);
  if(looksLikeHtml)throw new ApiError(`The local server returned its web page instead of an API response (HTTP ${response.status}). Restart Pseudoharness and reload so its UI and backend versions match.`,response.status,'STALE_BACKEND');
  if(!text.trim()){
    if(!response.ok)throw new ApiError(statusFallback(response.status),response.status,'HTTP_ERROR');
    throw new ApiError(`The local service returned an empty response (HTTP ${response.status}). Restart Pseudoharness and try again.`,response.status,'EMPTY_RESPONSE');
  }
  let payload:unknown;
  try{payload=JSON.parse(text);}catch{
    if(!response.ok){const plain=text.trim();const isPlainText=contentType.toLowerCase().includes('text/plain');if(response.status<500&&isPlainText&&plain.length<300&&!['{','}','[',']'].some(character=>plain.includes(character)))throw new ApiError(plain,response.status,'HTTP_ERROR');throw new ApiError(statusFallback(response.status),response.status,'HTTP_ERROR');}
    throw new ApiError(`The local service returned unreadable data (HTTP ${response.status}). Restart Pseudoharness and try again.`,response.status,'INVALID_RESPONSE');
  }
  if(!response.ok){
    const message=asMessage(payload);
    throw new ApiError(message||statusFallback(response.status),response.status,(payload as any)?.code||'HTTP_ERROR');
  }
  return payload;
}

async function localFetch(url:string,init?:RequestInit){
  try{return await fetch(url,init);}
  catch(error){throw new ApiError('Could not reach the local Pseudoharness service. Check that it is running, then retry.',undefined,'LOCAL_SERVICE_UNREACHABLE',{cause:error});}
}

export async function bootstrap(){const r=await localFetch('/api/bootstrap');const j=await readJson(r);token=j.csrf;return j;}
async function request(url:string,body:unknown,signal?:AbortSignal){return localFetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-pseudoharness-token':token},body:body===undefined?undefined:JSON.stringify(body),signal});}
export async function api<T=any>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{try{return await readJson(await request(url,body,signal));}catch(error){if(signal?.aborted)throw error;if(error instanceof ApiError&&error.status===403&&/session token/i.test(error.message)){await bootstrap();return await readJson(await request(url,body,signal));}throw error;}}
