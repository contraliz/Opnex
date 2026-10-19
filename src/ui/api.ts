let token='';
async function readJson(r:Response){try{return await r.json()}catch{throw Error(`Local service returned an invalid response (${r.status}).`)}}
export async function bootstrap(){const r=await fetch('/api/bootstrap');const j=await readJson(r);if(!r.ok)throw Error(j.error||r.statusText);token=j.csrf;return j;}
async function request(url:string,body:unknown){return fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-pseudoharness-token':token},body:body===undefined?undefined:JSON.stringify(body)});}
export async function api<T=any>(url:string,body?:unknown):Promise<T>{let r=await request(url,body);let j=await readJson(r);if(r.status===403&&String(j.error||'').includes('session token')){await bootstrap();r=await request(url,body);j=await readJson(r);}if(!r.ok)throw Error(j.error||r.statusText);return j;}
