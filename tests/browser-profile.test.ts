import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const require=createRequire(import.meta.url);
const {browserProfilePath}=require('../desktop/browser-profile.cjs') as {browserProfilePath:(input:{platform:string;localAppData?:string;userData:string;isolated?:boolean})=>string};

describe('local Electron browser profile',()=>{
  it('keeps the persistent Windows browser session under Local AppData',()=>{
    expect(browserProfilePath({platform:'win32',localAppData:'C:/Users/test/AppData/Local',userData:'C:/Users/test/AppData/Roaming/Pseudoharness'})).toBe(path.join('C:/Users/test/AppData/Local','Pseudoharness','browser-profile'));
  });
  it('keeps disposable smoke profiles isolated under the supplied temporary app-data directory',()=>{
    expect(browserProfilePath({platform:'win32',localAppData:'C:/Users/test/AppData/Local',userData:'C:/Temp/pseudoharness-smoke',isolated:true})).toBe(path.join('C:/Temp/pseudoharness-smoke','browser-profile'));
  });
  it('uses the app-local profile directory on macOS and Linux',()=>{
    const data='C:/Users/test/AppData/Roaming/Pseudoharness';
    expect(browserProfilePath({platform:'darwin',userData:data})).toBe(path.join(data,'browser-profile'));
    expect(browserProfilePath({platform:'linux',userData:data})).toBe(path.join(data,'browser-profile'));
  });
});
