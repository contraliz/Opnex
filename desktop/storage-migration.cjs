const fs = require('node:fs');
const path = require('node:path');

const userDataMigrationMarker = '.opnex-user-data-migration.json';

function desktopUserDataPath(appData,platform=process.platform){
  const paths=platform==='win32'?path.win32:path;
  return paths.join(paths.resolve(appData),'Opnex');
}

function desktopUserDataPaths(appData){
  const root=path.resolve(appData);
  return {legacy:path.join(root,'Pseudoharness'),current:desktopUserDataPath(root)};
}

function isEmptyDirectory(directory,operations=fs){
  try{
    const stat=operations.lstatSync(directory);
    return stat.isDirectory()&&!stat.isSymbolicLink()&&operations.readdirSync(directory).length===0;
  }catch(error){if(error.code==='ENOENT')return false;throw error;}
}

function desktopUserDataPathForLock(paths,operations=fs){
  if(operations.existsSync(paths.legacy)&&(!operations.existsSync(paths.current)||isEmptyDirectory(paths.current,operations)))return paths.legacy;
  return paths.current;
}

function desktopStorageFallbackPaths(userDataPaths,error,operations=fs){
  try{
    if(error?.code==='OPNEX_STORAGE_MIGRATION_CONFLICT'||!operations.existsSync(userDataPaths.legacy))return null;
    const source=operations.lstatSync(userDataPaths.legacy);
    if(!source.isDirectory()||source.isSymbolicLink())return null;
    if(operations.existsSync(userDataPaths.current)&&!isEmptyDirectory(userDataPaths.current,operations))return null;
    return {userData:userDataPaths.legacy};
  }catch{return null;}
}

function migrationMarkerMatches(directory,operations=fs){
  try{
    const marker=JSON.parse(operations.readFileSync(path.join(directory,userDataMigrationMarker),'utf8'));
    return marker.version===1&&marker.source==='pseudoharness-desktop-user-data';
  }catch{return false;}
}

function shouldCopyDesktopEntry(root,source){
  const relative=path.relative(root,source);
  if(!relative)return true;
  if(relative.includes(path.sep))return true;
  return !['lockfile','singletonlock','singletonsocket','singletoncookie',userDataMigrationMarker].includes(path.basename(source).toLowerCase());
}

function copyDirectory(legacy,current,{marker=false,operations=fs}={}){
  if(!operations.existsSync(legacy))return 'missing';
  const source=operations.lstatSync(legacy);
  if(!source.isDirectory()||source.isSymbolicLink())throw new Error(`The legacy Opnex data path ${legacy} is not a regular directory; it was left untouched.`);
  if(operations.existsSync(current)){
    const target=operations.lstatSync(current);
    if(!target.isDirectory()||target.isSymbolicLink())return 'preserved';
    if(operations.readdirSync(current).length>0){
      return marker&&migrationMarkerMatches(current,operations)?'previously-copied':'preserved';
    }
  }

  const parent=path.dirname(current);
  operations.mkdirSync(parent,{recursive:true});
  const staging=operations.mkdtempSync(path.join(parent,'.opnex-storage-migration-'));
  const copied=path.join(staging,path.basename(current));
  let migrationError;
  try{
    operations.cpSync(legacy,copied,{recursive:true,dereference:false,filter:item=>shouldCopyDesktopEntry(legacy,item)});
    if(marker)operations.writeFileSync(path.join(copied,userDataMigrationMarker),JSON.stringify({version:1,source:'pseudoharness-desktop-user-data'}),{flag:'wx',mode:0o600});
    if(operations.existsSync(current)){
      if(!isEmptyDirectory(current,operations))return 'preserved';
      operations.rmdirSync(current);
    }
    operations.renameSync(copied,current);
    return 'copied';
  }catch(error){
    migrationError=error;
    throw error;
  }finally{
    try{operations.rmSync(staging,{recursive:true,force:true});}
    catch(cleanupError){
      if(migrationError&&typeof migrationError==='object'){
        try{migrationError.cleanupError=cleanupError;}catch{}
      }else console.warn('Opnex could not remove a user-data migration staging directory:',cleanupError instanceof Error?cleanupError.message:String(cleanupError));
    }
  }
}

function migrateDesktopUserData(paths,operations=fs){
  const status=copyDirectory(paths.legacy,paths.current,{marker:true,operations});
  if(status==='preserved'){
    const error=new Error(`Both legacy and Opnex desktop data directories contain data. Neither was changed. Close Opnex and move or back up one directory before restarting: ${paths.legacy} and ${paths.current}`);
    error.code='OPNEX_STORAGE_MIGRATION_CONFLICT';
    throw error;
  }
  return {directory:paths.current,migrated:status==='copied',status};
}

module.exports={desktopUserDataPath,desktopUserDataPaths,desktopUserDataPathForLock,desktopStorageFallbackPaths,migrateDesktopUserData,isEmptyDirectory};
