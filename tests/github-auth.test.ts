import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubAuthService } from '../server/github-auth.js';

class FixtureChild extends EventEmitter{
  stdout=new PassThrough();
  stderr=new PassThrough();
  killed=0;
  kill(){this.killed++;this.emit('close',null);return true;}
  close(code:number){this.emit('close',code);}
  output(value:string){this.stderr.write(value);}
}

const deviceOutput='! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
const signedOut={available:true,authenticated:false};

afterEach(()=>vi.useRealTimers());

describe('bounded GitHub CLI device sign-in',()=>{
  it('uses the noninteractive gh device flow, exposes the in-memory code, then refreshes account state',async()=>{
    vi.useFakeTimers();
    const child=new FixtureChild();
    const readAuth=vi.fn().mockResolvedValueOnce(signedOut).mockResolvedValue({available:true,authenticated:true,account:'demo-user'});
    const launchLogin=vi.fn(()=>child);
    const service=new GitHubAuthService({readAuth,spawnLogin:launchLogin,now:Date.now});
    expect(await service.start()).toMatchObject({state:'starting'});
    expect(launchLogin).toHaveBeenCalledWith(['auth','login','--hostname','github.com','--web','--skip-ssh-key','--clipboard=false']);
    child.output(deviceOutput.slice(0,35));child.output(deviceOutput.slice(35));
    expect(await service.status()).toMatchObject({state:'awaiting',verificationUrl:'https://github.com/login/device',userCode:'ABCD-1234'});
    child.close(0);
    await vi.waitFor(async()=>expect(await service.status()).toMatchObject({state:'authenticated',account:'demo-user'}));
  });

  it('keeps duplicate starts bounded and cancellation clears the one-time code',async()=>{
    const child=new FixtureChild();
    const service=new GitHubAuthService({readAuth:async()=>signedOut,spawnLogin:()=>child});
    await service.start();child.output(deviceOutput);
    expect((await service.start()).state).toBe('awaiting');
    const result=await service.cancel();
    expect(result).toMatchObject({state:'cancelled',authenticated:false});
    expect(result).not.toHaveProperty('userCode');
    expect(child.killed).toBe(1);
  });

  it('expires and terminates an unfinished device authorization attempt',async()=>{
    vi.useFakeTimers();
    const child=new FixtureChild();
    const service=new GitHubAuthService({readAuth:async()=>signedOut,spawnLogin:()=>child,now:Date.now,loginTimeoutMs:60_000});
    await service.start();child.output(deviceOutput);
    expect((await service.status()).state).toBe('awaiting');
    await vi.advanceTimersByTimeAsync(60_000);
    const result=await service.status();
    expect(result).toMatchObject({state:'expired',authenticated:false});
    expect(result).not.toHaveProperty('userCode');
    expect(child.killed).toBe(1);
  });

  it('reports failed CLI output without returning the device code or token-shaped text',async()=>{
    const child=new FixtureChild();
    const service=new GitHubAuthService({readAuth:async()=>signedOut,spawnLogin:()=>child});
    await service.start();child.output(`${deviceOutput}\nToken: ghp_supersecret1234567890\n`);child.close(1);
    const result=await service.status();
    expect(result).toMatchObject({state:'failed',authenticated:false});
    expect(JSON.stringify(result)).not.toContain('ABCD-1234');
    expect(JSON.stringify(result)).not.toContain('ghp_supersecret');
  });

  it('reports missing gh without starting a process',async()=>{
    const error=Object.assign(new Error('missing'),{code:'ENOENT'});
    const launchLogin=vi.fn(()=>{throw error;});
    const service=new GitHubAuthService({readAuth:async()=>signedOut,spawnLogin:launchLogin});
    expect(await service.start()).toMatchObject({state:'failed',cliAvailable:false,detail:'GitHub CLI (gh) is not installed or available on PATH.'});
    expect(launchLogin).toHaveBeenCalledTimes(1);
  });
});
