import os from 'node:os';
import path from 'node:path';

type Platform='win32'|'darwin'|'linux'|string;

export function defaultDataDirectory({platform=process.platform,home=os.homedir(),env=process.env}:{platform?:Platform;home?:string;env?:NodeJS.ProcessEnv}={}){
  if(platform==='win32'){
    const paths=path.win32;
    const local=env.LOCALAPPDATA;
    return paths.join(local&&paths.isAbsolute(local)?local:paths.join(home,'AppData','Local'),'Pseudoharness');
  }
  if(platform==='darwin')return path.posix.join(home,'Library','Application Support','Pseudoharness');
  const paths=path.posix;
  const xdg=env.XDG_DATA_HOME;
  return paths.join(xdg&&paths.isAbsolute(xdg)?xdg:paths.join(home,'.local','share'),'pseudoharness');
}

export function stateDirectory(env:NodeJS.ProcessEnv=process.env,platform:Platform=process.platform,home=os.homedir()){
  // Keep the original data-folder spelling so existing settings, sessions, skills, and browser data remain discoverable.
  const override=env.OPNEX_DATA_DIR||env.PSEUDOHARNESS_DATA_DIR;
  if(!override)return defaultDataDirectory({platform,home,env});
  const paths=platform==='win32'?path.win32:path.posix;
  return paths.resolve(override);
}
