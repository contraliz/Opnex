import { describe,expect,it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveMcpHelperLaunch } from '../server/mcp-helper-runtime.js';
import { skillLibraryMcpServerConfig } from '../server/skill-library-mcp-config.js';
import { NODE_RUNTIME_SHA256,NODE_RUNTIME_VERSION } from '../scripts/prepare-mcp-helper-runtime.mjs';

describe('packaged MCP helper runtime',()=>{
  it('keeps development on local Node and passes filesystem loaders as file URLs',()=>{
    const root=path.resolve('repo with spaces');const modulePath=path.join(root,'server','skill-library-mcp-config.ts');const loaderPath=path.join(root,'node_modules','tsx','dist','loader.mjs');
    const launch=resolveMcpHelperLaunch({modulePath,helperFile:'skills-mcp-gateway.ts',platform:process.platform,arch:process.arch,tsxLoader:loaderPath});
    expect(launch.command).toBe(process.execPath);expect(launch.packaged).toBe(false);expect(launch.args).toEqual(['--import',pathToFileURL(loaderPath).href,path.join(root,'server','skills-mcp-gateway.ts')]);expect(launch.cwd).toBe(root);
  });
  it('keeps package specifiers and the resolved default loader unchanged',()=>{
    const root=path.resolve('repo');const modulePath=path.join(root,'server','skill-library-mcp-config.ts');
    const defaultLaunch=resolveMcpHelperLaunch({modulePath,helperFile:'skills-mcp-gateway.ts'});
    expect(defaultLaunch.args[1]).toBe(import.meta.resolve('tsx'));
    const override=resolveMcpHelperLaunch({modulePath,helperFile:'skills-mcp-gateway.ts',tsxLoader:'tsx'});
    expect(override.args[1]).toBe('tsx');
  });
  it('uses a bundled architecture-specific runtime and unpacked helper modules when packaged',()=>{
    const available=new Set(['C:\\app\\resources\\opnex-node\\win32-x64\\node.exe','C:\\app\\resources\\app.asar.unpacked\\dist-server\\skills-mcp-gateway.js']);
    const launch=resolveMcpHelperLaunch({modulePath:'C:\\app\\resources\\app.asar\\dist-server\\skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'win32',arch:'x64',packaged:true,resourcesPath:'C:\\app\\resources',fileExists:file=>available.has(file)});
    expect(launch).toEqual({command:'C:\\app\\resources\\opnex-node\\win32-x64\\node.exe',args:['C:\\app\\resources\\app.asar.unpacked\\dist-server\\skills-mcp-gateway.js'],cwd:'C:\\app\\resources\\app.asar.unpacked',packaged:true});
  });
  it('keeps reading the former bundled-runtime directory from existing installations',()=>{
    const oldRuntime='C:\\app\\resources\\pseudoharness-node\\win32-x64\\node.exe';
    const helper='C:\\app\\resources\\app.asar.unpacked\\dist-server\\skills-mcp-gateway.js';
    const launch=resolveMcpHelperLaunch({modulePath:'C:\\app\\resources\\app.asar\\dist-server\\skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'win32',arch:'x64',packaged:true,resourcesPath:'C:\\app\\resources',fileExists:file=>file===oldRuntime||file===helper});
    expect(launch.command).toBe(oldRuntime);
  });
  it('selects the matching macOS Node executable for either packaged architecture',()=>{
    for(const arch of ['x64','arm64']){
      const launch=resolveMcpHelperLaunch({modulePath:'/Applications/Opnex.app/Contents/Resources/app.asar/dist-server/skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'darwin',arch,packaged:true,resourcesPath:'/Applications/Opnex.app/Contents/Resources',fileExists:()=>true});
      expect(launch.command).toBe(`/Applications/Opnex.app/Contents/Resources/opnex-node/darwin-${arch}/node`);expect(launch.args[0]).toBe('/Applications/Opnex.app/Contents/Resources/app.asar.unpacked/dist-server/skills-mcp-gateway.js');
    }
  });
  it('keeps the skills MCP config free of Electron RunAsNode and preserves explicit tool configuration',()=>{
    const config=skillLibraryMcpServerConfig({taskId:'task',role:'direct'});
    expect(config.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');expect(config.enabled_tools).toEqual(['skills_list','skills_search','skills_load','skills_read_file','skills_save']);
  });
  it('fails clearly for missing bundled runtime or helper instead of falling back to Electron or PATH',()=>{
    expect(()=>resolveMcpHelperLaunch({modulePath:'C:\\app\\resources\\app.asar\\dist-server\\skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'win32',arch:'x64',packaged:true,resourcesPath:'C:\\app\\resources',fileExists:()=>false})).toThrow('bundled Node runtime is missing');
    expect(()=>resolveMcpHelperLaunch({modulePath:'C:\\app\\resources\\app.asar\\dist-server\\skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'win32',arch:'x64',packaged:true,resourcesPath:'C:\\app\\resources',fileExists:file=>file.endsWith('node.exe')})).toThrow('packaged skills-mcp-gateway.js helper is missing');
    expect(()=>resolveMcpHelperLaunch({modulePath:'C:\\app\\resources\\app.asar\\dist-server\\skill-library-mcp-config.js',helperFile:'skills-mcp-gateway.js',platform:'win32',arch:'x64',packaged:true,fileExists:()=>true})).toThrow('could not locate its installed app resources for skills-mcp-gateway.js');
  });
  it('pins official supported Node LTS archives and records checksums for each package architecture',()=>{
    expect(NODE_RUNTIME_VERSION).toBe('24.22.1');expect(Object.keys(NODE_RUNTIME_SHA256).sort()).toEqual(['darwin-arm64','darwin-x64','win32-x64']);
    expect(Object.values(NODE_RUNTIME_SHA256).every(hash=>/^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });
});
