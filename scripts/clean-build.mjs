import { createRequire } from 'node:module';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(scriptDir,'..');
const require=createRequire(import.meta.url);
const nodeModules=path.join(root,'node_modules');

const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
const supportedNode=nodeMajor>22||(nodeMajor===22&&nodeMinor>=12);
if(!supportedNode){
  console.error(`Pseudoharness source builds require Node.js 22.12.0 or newer; detected ${process.versions.node}. Install a supported Node.js version, then run npm ci --include=dev from the repository root.`);
}

const missing=[];
if(supportedNode){
  for(const name of ['typescript','vite']){
    try{
      const resolved=require.resolve(name);
      const relative=path.relative(nodeModules,resolved);
      if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))missing.push(name);
    }catch(error){
      if(error?.code==='MODULE_NOT_FOUND')missing.push(name);
      else throw error;
    }
  }
}
if(missing.length){
  const labels=missing.map(name=>name==='typescript'?'TypeScript (`typescript`)':'Vite (`vite`)');
  console.error(`Missing local source-build dependencies: ${labels.join(', ')}.\nRun npm ci --include=dev from the repository root to install the lockfile's development dependencies, then retry. Source builds cannot use npm ci --omit=dev or a global TypeScript install.`);
}

if(!supportedNode||missing.length)process.exitCode=1;
else{
  for(const name of ['dist','dist-server']){
    const target=path.resolve(root,name);
    if(path.dirname(target)!==root)throw new Error(`Refusing to clear build output outside the project: ${target}`);
    await rm(target,{recursive:true,force:true});
  }
}
