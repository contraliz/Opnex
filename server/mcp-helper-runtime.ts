import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type McpHelperLaunch = { command:string;args:string[];cwd:string;packaged:boolean };
export type McpHelperRuntimeOptions = {
  modulePath:string;
  helperFile:string;
  platform?:string;
  arch?:string;
  packaged?:boolean;
  resourcesPath?:string;
  nodeExecutable?:string;
  tsxLoader?:string;
  fileExists?:(filePath:string)=>boolean;
};

const platformPath=(platform:string)=>platform==='win32'?path.win32:path.posix;

function moduleSpecifier(value:string,platform:string){
  if(value.startsWith('file:')||value.startsWith('node:'))return value;
  return platformPath(platform).isAbsolute(value)?pathToFileURL(value).href:value;
}

/** Resolve the standalone helper runtime without relying on Electron's RunAsNode fuse. */
export function resolveMcpHelperLaunch(options:McpHelperRuntimeOptions):McpHelperLaunch{
  const platform=options.platform||process.platform,arch=options.arch||process.arch,paths=platformPath(platform);
  const packaged=options.packaged??process.env.PSEUDOHARNESS_PACKAGED_APP==='1';
  const moduleDirectory=paths.dirname(options.modulePath);
  if(packaged){
    const resourcesPath=options.resourcesPath||process.env.PSEUDOHARNESS_RESOURCES_PATH;
    if(!resourcesPath)throw new Error(`Pseudoharness could not locate its installed app resources for ${options.helperFile}. Restart the app after reinstalling it.`);
    const runtimeDirectory=paths.join(resourcesPath,'pseudoharness-node',`${platform}-${arch}`);
    const executable=paths.join(runtimeDirectory,platform==='win32'?'node.exe':'node');
    if(!(options.fileExists||existsSync)(executable))throw new Error(`The bundled Node runtime is missing for ${platform}/${arch} (${executable}). Reinstall Pseudoharness to restore its local helper runtime.`);
    const helper=paths.join(resourcesPath,'app.asar.unpacked','dist-server',options.helperFile);
    if(!(options.fileExists||existsSync)(helper))throw new Error(`The packaged ${options.helperFile} helper is missing (${helper}). Reinstall Pseudoharness to restore its local tools.`);
    return {command:executable,args:[helper],cwd:paths.join(resourcesPath,'app.asar.unpacked'),packaged:true};
  }

  const development=options.modulePath.endsWith('.ts');
  const helper=paths.join(moduleDirectory,options.helperFile);
  const electron=!!process.versions.electron;
  const command=options.nodeExecutable||(electron?'node':process.execPath);
  const tsxLoader=options.tsxLoader??import.meta.resolve('tsx');
  const args=development?['--import',moduleSpecifier(tsxLoader,platform),helper]:[helper];
  return {command,args,cwd:paths.resolve(moduleDirectory,'..'),packaged:false};
}
