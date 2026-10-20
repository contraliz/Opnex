import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(scriptDir,'..');
for(const name of ['dist','dist-server']){
  const target=path.resolve(root,name);
  if(path.dirname(target)!==root)throw new Error(`Refusing to clear build output outside the project: ${target}`);
  await rm(target,{recursive:true,force:true});
}
