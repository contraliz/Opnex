import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {browserProfilePath}=require('../desktop/browser-profile.cjs') as {browserProfilePath:(input:{platform:string;localAppData?:string;userData:string;isolated?:boolean})=>string};

describe('local Electron browser profile',()=>{
  it('keeps the persistent Windows browser session under Local AppData',()=>{
    const localAppData=path.resolve('fixture-local-app-data');
    const userData=path.resolve('fixture-user-data');
    expect(browserProfilePath({platform:'win32',localAppData,userData})).toBe(path.join(localAppData,'Pseudoharness','browser-profile'));
  });
  it('keeps disposable smoke profiles isolated under the supplied temporary app-data directory',()=>{
    const userData=path.resolve('fixture-smoke-app-data');
    expect(browserProfilePath({platform:'win32',localAppData:path.resolve('fixture-local-app-data'),userData,isolated:true})).toBe(path.join(userData,'browser-profile'));
  });
  it('uses the app-local profile directory on macOS and Linux',()=>{
    const data=path.resolve('fixture-user-data');
    expect(browserProfilePath({platform:'darwin',userData:data})).toBe(path.join(data,'browser-profile'));
    expect(browserProfilePath({platform:'linux',userData:data})).toBe(path.join(data,'browser-profile'));
  });
});
