import { z } from 'zod';

export const MAX_ATTACHMENT_COUNT=5;
export const MAX_ATTACHMENT_BYTES=5*1024*1024;
export const MAX_ATTACHMENT_TOTAL_BYTES=12*1024*1024;
const imageTypes=new Set(['image/png','image/jpeg','image/webp']);
const textTypes=new Set(['text/plain','text/markdown','text/csv','application/json']);
const attachmentSchema=z.object({name:z.string().min(1).max(160),type:z.string().max(100),size:z.number().int().positive().max(MAX_ATTACHMENT_BYTES),data:z.string().min(1).max(Math.ceil(MAX_ATTACHMENT_BYTES*4/3)+8)}).strict();
export type TaskAttachment=z.infer<typeof attachmentSchema>;

export function validateAttachments(value:unknown):TaskAttachment[]{
  const files=z.array(attachmentSchema).max(MAX_ATTACHMENT_COUNT).parse(value??[]);let total=0;
  return files.map(file=>{
    const name=file.name.split(/[\\/]/).at(-1)!.split('').filter(character=>{const code=character.charCodeAt(0);return code>=32&&code!==127;}).join('').trim();
    if(!name||name==='.'||name==='..')throw new Error('Attachment filename is invalid.');
    if(!imageTypes.has(file.type)&&!textTypes.has(file.type))throw new Error(`Unsupported attachment format: ${name}. Use PNG, JPEG, WebP, TXT, Markdown, CSV, or JSON.`);
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data))throw new Error(`Attachment data for ${name} is invalid.`);
    const bytes=Buffer.from(file.data,'base64');if(bytes.length!==file.size)throw new Error(`Attachment size for ${name} does not match its content.`);
    if(textTypes.has(file.type))try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error(`Attachment is not valid UTF-8 text: ${name}.`);}
    if(file.type==='image/png'&&bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||file.type==='image/jpeg'&&bytes.subarray(0,3).toString('hex')!=='ffd8ff'||file.type==='image/webp'&&(bytes.subarray(0,4).toString('ascii')!=='RIFF'||bytes.subarray(8,12).toString('ascii')!=='WEBP'))throw new Error(`Attachment content does not match the declared image format: ${name}.`);
    total+=bytes.length;if(total>MAX_ATTACHMENT_TOTAL_BYTES)throw new Error('Attachments exceed the 12 MB total limit.');return {...file,name};
  });
}
export function attachmentUserInput(files:TaskAttachment[]){
  const items:Array<Record<string,string>>=[];const text:string[]=[];
  for(const file of files)if(imageTypes.has(file.type))items.push({type:'image',image_url:`data:${file.type};base64,${file.data}`});else text.push(`\n\n--- Selected attachment: ${file.name} (${file.type}) ---\n${new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(file.data,'base64'))}\n--- End attachment ---`);
  return {items,text:text.join('')};
}
