import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const probePath=fileURLToPath(new URL('./body-parser-security-probe.cjs',import.meta.url));

function runProbe(mode:string){
  return new Promise<{code:number|null;signal:NodeJS.Signals|null;stdout:string;stderr:string;timedOut:boolean}>(resolve=>{
    const child=spawn(process.execPath,[probePath,mode],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
    let stdout='';let stderr='';let timedOut=false;
    child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});
    child.stderr.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},8000);
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout:stdout.trim(),stderr:stderr.trim(),timedOut});});
  });
}

function parseProbe(result:Awaited<ReturnType<typeof runProbe>>){
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as {status:number;body:string;health:number};
}

describe('compressed JSON parser security boundary',()=>{
  it('keeps the parser process alive after a complete gzip frame with trailing request bytes',async()=>{
    const result=parseProbe(await runProbe('gzip-trailing'));
    expect(result.status).toBe(404);
    expect(result.health).toBe(200);
  });

  it('keeps the service alive for trailing deflate bytes as well',async()=>{
    const result=parseProbe(await runProbe('deflate-trailing'));
    expect([400,404]).toContain(result.status);
    expect(result.health).toBe(200);
  });

  it('drains request bytes that arrive after the gzip frame has finished',async()=>{
    const result=parseProbe(await runProbe('sequenced-gzip-trailing'));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({a:1});
    expect(result.health).toBe(200);
  });

  it('continues accepting valid gzip-compressed JSON',async()=>{
    const result=parseProbe(await runProbe('compressed-control'));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({a:1});
    expect(result.health).toBe(200);
  });
});
