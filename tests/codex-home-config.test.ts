import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkNormalCodexFile } from '../server/codex-home-config.js';

const roots:string[]=[];
const fixture=async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pseudoharness-codex-home-config-'));
  roots.push(root);
  const normalHome=path.join(root,'normal'),agentHome=path.join(root,'agent');
  await Promise.all([mkdir(normalHome),mkdir(agentHome)]);
  return {root,normalHome,agentHome};
};
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('instruction-filtered Codex configuration sharing',()=>{
  it('uses an exact-file symlink after EXDEV when the platform permits it',async()=>{
    const {normalHome,agentHome}=await fixture(),source=path.join(normalHome,'config.toml'),destination=path.join(agentHome,'config.toml'),probe=path.join(agentHome,'.symlink-probe');
    const contents='[mcp_servers.fixture]\ncommand="verified-source"\n';
    await writeFile(source,contents);
    try{await symlink(source,probe,'file');}
    catch(error){if(['EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
    await unlink(probe);
    const crossVolumeLink=async()=>{throw Object.assign(new Error('cross-volume'),{code:'EXDEV'});};
    expect(await linkNormalCodexFile(normalHome,agentHome,'config.toml',true,undefined,{link:crossVolumeLink as any})).toBe('symlink');
    expect(await realpath(destination)).toBe(await realpath(source));
    expect(await readFile(destination,'utf8')).toBe(contents);
    expect((await readdir(agentHome)).sort()).toEqual(['config.toml']);
  });

  it('uses an exact-file snapshot on EXDEV when file symlinks are unavailable and refreshes it atomically',async()=>{
    const {normalHome,agentHome}=await fixture(),source=path.join(normalHome,'config.toml'),destination=path.join(agentHome,'config.toml');
    const first='[mcp_servers.fixture]\ncommand="fixture-one"\n';
    const second='[mcp_servers.fixture]\ncommand="fixture-two"\n';
    await writeFile(source,first);
    const crossVolumeLink=async()=>{throw Object.assign(new Error('cross-volume'),{code:'EXDEV'});};
    const unavailableSymlink=async()=>{throw Object.assign(new Error('symlink privilege unavailable'),{code:'EPERM'});};
    const overrides={link:crossVolumeLink as any,symlink:unavailableSymlink as any};

    expect(await linkNormalCodexFile(normalHome,agentHome,'config.toml',true,undefined,overrides)).toBe('snapshot');
    expect(await readFile(destination,'utf8')).toBe(first);
    await writeFile(source,second);
    expect(await linkNormalCodexFile(normalHome,agentHome,'config.toml',true,undefined,overrides)).toBe('snapshot');
    expect(await readFile(destination,'utf8')).toBe(second);
    expect((await readdir(agentHome)).sort()).toEqual(['config.toml']);
  });

  it('preserves the last verified snapshot if an atomic refresh cannot be installed',async()=>{
    const {normalHome,agentHome}=await fixture(),source=path.join(normalHome,'config.toml'),destination=path.join(agentHome,'config.toml');
    const first='[mcp_servers.fixture]\ncommand="known-good"\n';
    const second='[mcp_servers.fixture]\ncommand="replacement"\n';
    await writeFile(source,first);
    const crossVolumeLink=async()=>{throw Object.assign(new Error('cross-volume'),{code:'EXDEV'});};
    const unavailableSymlink=async()=>{throw Object.assign(new Error('symlink privilege unavailable'),{code:'EPERM'});};
    await linkNormalCodexFile(normalHome,agentHome,'config.toml',true,undefined,{link:crossVolumeLink as any,symlink:unavailableSymlink as any});
    await writeFile(source,second);
    const failInstall=async(from:string,to:string)=>{
      if(path.basename(from).startsWith('.pseudoharness-config-')&&!path.basename(from).startsWith('.pseudoharness-config-backup-')&&path.basename(to)==='config.toml')throw Object.assign(new Error('replacement failed'),{code:'EIO'});
      return rename(from,to);
    };
    await expect(linkNormalCodexFile(normalHome,agentHome,'config.toml',true,undefined,{link:crossVolumeLink as any,symlink:unavailableSymlink as any,rename:failInstall as any})).rejects.toThrow('replacement failed');
    expect(await readFile(destination,'utf8')).toBe(first);
    expect((await readdir(agentHome)).sort()).toEqual(['config.toml']);
  });

  it('fails closed on an unexpected destination directory without replacing it',async()=>{
    const {normalHome,agentHome}=await fixture(),destination=path.join(agentHome,'config.toml');
    await writeFile(path.join(normalHome,'config.toml'),'[mcp_servers.fixture]\ncommand="fixture"\n');
    await mkdir(destination);
    await writeFile(path.join(destination,'keep.txt'),'preserve');
    await expect(linkNormalCodexFile(normalHome,agentHome,'config.toml',true)).rejects.toThrow('Unexpected entry');
    expect(await readFile(path.join(destination,'keep.txt'),'utf8')).toBe('preserve');
  });

  it('allows snapshots only for the normal config and the explicitly selected profile config',async()=>{
    const {normalHome,agentHome}=await fixture();
    await writeFile(path.join(normalHome,'config.toml'),'[mcp_servers.fixture]\ncommand="fixture"\n');
    await expect(linkNormalCodexFile(normalHome,agentHome,'other.config.toml',false)).rejects.toThrow('Only the normal Codex config');
    await expect(linkNormalCodexFile(normalHome,agentHome,'selected.config.toml',false,'other')).rejects.toThrow('Only the normal Codex config');
    await writeFile(path.join(normalHome,'selected.config.toml'),'model="selected"\n');
    expect(await linkNormalCodexFile(normalHome,agentHome,'selected.config.toml',false,'selected')).toBe('hardlink');
    expect(await readFile(path.join(agentHome,'selected.config.toml'),'utf8')).toBe('model="selected"\n');
  });

  it('rejects an unexpected existing symlink target',async()=>{
    const {root,normalHome,agentHome}=await fixture(),destination=path.join(agentHome,'config.toml'),other=path.join(root,'other.toml');
    await writeFile(path.join(normalHome,'config.toml'),'[mcp_servers.fixture]\ncommand="fixture"\n');
    await writeFile(other,'do not expose');
    try{await symlink(other,destination,'file');}catch(error){if(!['EPERM','EACCES','ENOTSUP','EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code??''))throw error;return;}
    await expect(linkNormalCodexFile(normalHome,agentHome,'config.toml',true)).rejects.toThrow('Unexpected symbolic link');
    expect(await readFile(other,'utf8')).toBe('do not expose');
  });

  it('rejects an app-owned home reached through a linked parent directory',async()=>{
    const {root,normalHome,agentHome}=await fixture(),linkedRoot=path.join(root,'linked-parent'),source=path.join(normalHome,'config.toml');
    await writeFile(source,'[mcp_servers.fixture]\ncommand="fixture"\n');
    try{await symlink(root,linkedRoot,'junction');}
    catch(error){if(['EPERM','EACCES','ENOTSUP','EOPNOTSUPP','ENOSYS'].includes((error as NodeJS.ErrnoException).code??''))return;throw error;}
    const aliasedAgentHome=path.join(linkedRoot,path.basename(agentHome));
    await expect(linkNormalCodexFile(normalHome,aliasedAgentHome,'config.toml',true)).rejects.toThrow('not a verified directory');
    await expect(readFile(path.join(agentHome,'config.toml'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  });
});
