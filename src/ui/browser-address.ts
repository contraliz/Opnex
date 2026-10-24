export type BrowserAddressSuggestion={label:string;url:string};

export const BROWSER_ADDRESS_SUGGESTIONS:BrowserAddressSuggestion[]=[
  {label:'Google',url:'https://www.google.com/'},
  {label:'GitHub',url:'https://github.com/'},
  {label:'GitHub device sign-in',url:'https://github.com/login/device'},
  {label:'OpenAI Codex docs',url:'https://developers.openai.com/codex/'},
  {label:'OpenAI API docs',url:'https://platform.openai.com/docs/'},
  {label:'MDN Web Docs',url:'https://developer.mozilla.org/'},
];

export function normalizeBrowserAddress(input:string):string{
  const value=input.trim();
  if(!value)throw new Error('Enter a website address.');
  const explicitScheme=value.match(/^([a-z][a-z\d+.-]*):\/\//i)?.[1]?.toLowerCase();
  const bareHostPort=!explicitScheme&&/^[^\s:/?#]+:\d+(?:[/?#]|$)/.test(value);
  const scheme=explicitScheme||(!bareHostPort?value.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase():undefined);
  if(scheme&&scheme!=='https'&&scheme!=='http')throw new Error('Only HTTP and HTTPS browser addresses are supported.');
  const candidate=scheme?value:`https://${value}`;
  let url:URL;
  try{url=new URL(candidate);}catch{throw new Error('Enter a valid website address, such as github.com.');}
  if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('Only HTTP and HTTPS browser addresses are supported.');
  if(url.username||url.password)throw new Error('Addresses that contain credentials are not accepted.');
  if(!url.hostname)throw new Error('Enter a valid website address, such as github.com.');
  return url.toString();
}

export function browserAddressSuggestions(query:string){
  const normalized=query.trim().toLocaleLowerCase();
  if(!normalized)return BROWSER_ADDRESS_SUGGESTIONS;
  return BROWSER_ADDRESS_SUGGESTIONS.filter(item=>`${item.label} ${item.url}`.toLocaleLowerCase().includes(normalized));
}
