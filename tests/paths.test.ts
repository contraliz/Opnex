import { describe, expect, it } from 'vitest';
import { defaultDataDirectory, stateDirectory } from '../server/paths.js';

describe('portable per-user state locations',()=>{
  it('uses the Windows local application data directory',()=>{
    expect(defaultDataDirectory({platform:'win32',home:'C:\\Users\\demo',env:{LOCALAPPDATA:'C:\\Users\\demo\\AppData\\Local'}})).toBe('C:\\Users\\demo\\AppData\\Local\\Opnex');
    expect(defaultDataDirectory({platform:'win32',home:'C:\\Users\\alice',env:{LOCALAPPDATA:'C:\\Users\\alice\\AppData\\Local'}})).not.toBe(defaultDataDirectory({platform:'win32',home:'C:\\Users\\bob',env:{LOCALAPPDATA:'C:\\Users\\bob\\AppData\\Local'}}));
  });
  it('uses macOS Application Support',()=>{
    expect(defaultDataDirectory({platform:'darwin',home:'/Users/demo',env:{}})).toBe('/Users/demo/Library/Application Support/Opnex');
  });
  it('honors an absolute Linux XDG data directory and ignores a relative one',()=>{
    expect(defaultDataDirectory({platform:'linux',home:'/home/demo',env:{XDG_DATA_HOME:'/home/demo/data'}})).toBe('/home/demo/data/opnex');
    expect(defaultDataDirectory({platform:'linux',home:'/home/demo',env:{XDG_DATA_HOME:'relative'}})).toBe('/home/demo/.local/share/opnex');
  });
  it('resolves an explicit state override independently of the launch directory',()=>{
    expect(stateDirectory({PSEUDOHARNESS_DATA_DIR:'D:\\app-state'},'win32','C:\\Users\\demo')).toBe('D:\\app-state');
  });
  it('prefers the Opnex state override while retaining the legacy environment name',()=>{
    expect(stateDirectory({OPNEX_DATA_DIR:'D:\\opnex-state',PSEUDOHARNESS_DATA_DIR:'D:\\app-state'},'win32','C:\\Users\\demo')).toBe('D:\\opnex-state');
    expect(stateDirectory({PSEUDOHARNESS_DATA_DIR:'D:\\app-state'},'win32','C:\\Users\\demo')).toBe('D:\\app-state');
  });
});
