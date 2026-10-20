import { mkdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const npmCli=process.env.npm_execpath;
if(!npmCli)throw new Error('Run this script through `npm run package` so it can locate npm.');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const output=path.join(root,'artifacts');
await mkdir(output,{recursive:true});
const result=spawnSync(process.execPath,[npmCli,'pack','--pack-destination',output],{cwd:root,stdio:'inherit',shell:false});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
console.log(`Portable package: artifacts/${manifest.name}-${manifest.version}.tgz`);
