export function errorMessage(error:unknown){
  const issues=(error as {issues?:unknown}|null)?.issues;
  if(Array.isArray(issues)){
    const details=issues.slice(0,3).map((issue:any)=>{
      const field=Array.isArray(issue?.path)?issue.path.map(String).join(' ').replace(/([a-z0-9])([A-Z])/g,'$1 $2').toLowerCase():'';
      return [field,typeof issue?.message==='string'?issue.message:'Invalid value'].filter(Boolean).join(': ');
    });
    if(details.length)return `Please check ${details.join('; ')}.`.slice(0,1000);
  }
  if(error&&typeof error==='object'&&typeof (error as {message?:unknown}).message==='string'){
    const message=(error as {message:string}).message.trim();
    if(message)return message.slice(0,1000);
  }
  if(typeof error==='string'&&error.trim())return error.trim().slice(0,1000);
  return 'The request could not be completed. Check the supplied information and local service, then try again.';
}
