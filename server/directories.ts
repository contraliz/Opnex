import { mkdir, realpath, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DirectoryEntry={name:string;path:string};
export type DirectoryListing={path:string|null;parent:string|null;entries:DirectoryEntry[];truncated:boolean;roots?:string[]};

const MAX_ENTRIES=500;

function browseError(code:string|undefined){
  if(code==='ENOENT'||code==='ENOTDIR')return 'That folder does not exist or is not a directory.';
  if(code==='EACCES'||code==='EPERM')return 'You do not have permission to browse that folder.';
  return 'Could not read that folder.';
}

async function windowsRoots(){
  const roots:string[]=[];
  await Promise.all(Array.from({length:26},(_,index)=>String.fromCharCode(65+index)+':\\').map(async root=>{
    try{if((await stat(root)).isDirectory())roots.push(root);}catch{/* Unavailable drive. */}
  }));
  return roots.sort((a,b)=>a.localeCompare(b));
}

export async function resolveProjectDirectory(input:string){
  if(!path.isAbsolute(input.trim()))throw new Error('Enter an absolute folder path.');
  let canonical:string;
  try{canonical=await realpath(input);}
  catch(error){throw new Error(browseError((error as NodeJS.ErrnoException).code));}
  try{if(!(await stat(canonical)).isDirectory())throw new Error('Project root must be a directory.');}
  catch(error){if(error instanceof Error&&error.message==='Project root must be a directory.')throw error;throw new Error(browseError((error as NodeJS.ErrnoException).code));}
  return canonical;
}

export async function validateProjectDirectory(input:string){
  const canonical=await resolveProjectDirectory(input);
  return {path:canonical,parent:path.dirname(canonical)===canonical?null:path.dirname(canonical),entries:[],truncated:false};
}

function validateFolderName(input:string){
  const name=input;
  if(!name.trim())throw new Error('Enter a folder name.');
  if(name==='.'||name==='..'||name.includes('/')||name.includes('\\')||path.isAbsolute(name)||path.basename(name)!==name)throw new Error('Use a single folder name without path separators.');
  if(name.length>255)throw new Error('Folder names must be 255 characters or fewer.');
  if(process.platform==='win32'&&(/[<>:"|?*]/.test(name)||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)))throw new Error('That name is not valid for a Windows folder. Remove reserved characters, a trailing dot or space, or a reserved device name.');
  if([...name].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))throw new Error('Folder names cannot contain control characters.');
  return name;
}

export async function createChildDirectory(parentInput:string,nameInput:string){
  const parent=await resolveProjectDirectory(parentInput);
  const name=validateFolderName(nameInput);
  const folderPath=path.join(parent,name);
  try{await mkdir(folderPath);}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(code==='EEXIST')throw new Error('A folder or file with that name already exists. Choose another name.');
    if(code==='EACCES'||code==='EPERM')throw new Error('You do not have permission to create a folder here. Choose a folder you can write to.');
    if(code==='ENOENT'||code==='ENOTDIR')throw new Error('The selected parent folder is no longer available. Browse to it again and retry.');
    if(code==='ENAMETOOLONG'||code==='EINVAL')throw new Error('That folder name is not valid on this system. Choose a shorter, simpler name.');
    throw new Error('Could not create the folder. Check the selected location and try again.');
  }
  return {parent,entry:{name,path:folderPath}};
}

export async function listDirectories(input?:string,showRoots=false):Promise<DirectoryListing>{
  if(showRoots){
    if(process.platform==='win32')return {path:null,parent:null,entries:[],truncated:false,roots:await windowsRoots()};
    return {path:null,parent:null,entries:[],truncated:false,roots:[path.parse(os.homedir()).root||'/']};
  }
  const requested=input?.trim()||os.homedir();
  if(!path.isAbsolute(requested))throw new Error('Enter an absolute folder path.');
  let canonical:string;
  try{canonical=await resolveProjectDirectory(requested);}
  catch(error){
    if(error instanceof Error&&error.message==='Project root must be a directory.')throw new Error(browseError('ENOTDIR'));
    if(error instanceof Error&&(error.message==='That folder does not exist or is not a directory.'||error.message==='You do not have permission to browse that folder.'))throw error;
    throw new Error(browseError((error as NodeJS.ErrnoException).code));
  }
  try{
    const names=await readdir(canonical,{withFileTypes:true});
    const candidates=names.filter(entry=>entry.isDirectory()||entry.isSymbolicLink());
    const entries:DirectoryEntry[]=[];
    // Dirent already identifies ordinary directories. Only resolve symbolic links,
    // in bounded batches, so a large folder does not trigger hundreds of serial stats.
    for(let index=0;index<candidates.length;index+=32){
      const batch=candidates.slice(index,index+32);
      const resolved=await Promise.all(batch.map(async entry=>{
        const child=path.join(canonical,entry.name);
        if(entry.isDirectory())return {name:entry.name,path:child};
        try{return (await stat(child)).isDirectory()?{name:entry.name,path:child}:null;}catch{return null;}
      }));
      entries.push(...resolved.filter((entry):entry is DirectoryEntry=>entry!==null));
    }
    entries.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));
    const truncated=entries.length>MAX_ENTRIES;
    return {path:canonical,parent:path.dirname(canonical)===canonical?null:path.dirname(canonical),entries:entries.slice(0,MAX_ENTRIES),truncated};
  }catch(error){throw new Error(browseError((error as NodeJS.ErrnoException).code));}
}
