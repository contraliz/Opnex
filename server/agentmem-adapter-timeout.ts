export class AgentMemTimeoutError extends Error{
  constructor(operation:string){super(`${operation} timed out.`);this.name='AgentMemTimeoutError';}
}

export async function withAgentMemTimeout<T>(operation:Promise<T>,timeoutMs:number,operationName:string):Promise<T>{
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('AgentMem timeout must be a positive finite number.');
  let timer:NodeJS.Timeout|undefined;
  try{
    return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new AgentMemTimeoutError(operationName)),timeoutMs);})]);
  }finally{if(timer)clearTimeout(timer);}
}
