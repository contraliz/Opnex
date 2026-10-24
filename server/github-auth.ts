import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { readGitHubCliAuthStatus } from './github.js';

export type GitHubAuthState='idle'|'starting'|'awaiting'|'authenticated'|'failed'|'cancelled'|'expired';
export type GitHubAuthSnapshot={state:GitHubAuthState;cliAvailable:boolean;authenticated:boolean;account?:string;attemptId?:string;verificationUrl?:string;userCode?:string;expiresAt?:number;detail?:string};

type AuthChild={stdout:Readable|null;stderr:Readable|null;once:(event:'error'|'close',listener:(value:any)=>void)=>AuthChild;kill:(signal?:NodeJS.Signals)=>boolean};
type AuthStatus={available:boolean;authenticated:boolean;account?:string};
type GitHubAuthOptions={spawnLogin?:(args:string[])=>AuthChild;readAuth?:()=>Promise<AuthStatus>;now?:()=>number;setTimer?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>;clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void;startupTimeoutMs?:number;loginTimeoutMs?:number};

const STARTUP_TIMEOUT_MS=15_000;
const LOGIN_TIMEOUT_MS=10*60_000;
const LOGIN_ARGUMENTS=['auth','login','--hostname','github.com','--web','--skip-ssh-key','--clipboard=false'];
const isActive=(state:GitHubAuthState)=>state==='starting'||state==='awaiting';
function stripAnsi(value:string){
  let output='';
  for(let index=0;index<value.length;){
    if(value.charCodeAt(index)===27&&value[index+1]==='['){
      index+=2;
      while(index<value.length&&value.charCodeAt(index)>=0x30&&value.charCodeAt(index)<=0x3f)index++;
      while(index<value.length&&value.charCodeAt(index)>=0x20&&value.charCodeAt(index)<=0x2f)index++;
      if(index<value.length)index++;
    }else output+=value[index++];
  }
  return output;
}

function launchLogin(args:string[]):AuthChild{
  return spawn('gh',args,{cwd:process.cwd(),shell:false,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
}

export class GitHubAuthService{
  private readonly launch:(args:string[])=>AuthChild;
  private readonly readAuth:()=>Promise<AuthStatus>;
  private readonly now:()=>number;
  private readonly setTimer:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>;
  private readonly clearTimer:(timer:ReturnType<typeof setTimeout>)=>void;
  private readonly startupTimeoutMs:number;
  private readonly loginTimeoutMs:number;
  private current:GitHubAuthSnapshot={state:'idle',cliAvailable:false,authenticated:false};
  private child:AuthChild|null=null;
  private startupTimer:ReturnType<typeof setTimeout>|null=null;
  private expiryTimer:ReturnType<typeof setTimeout>|null=null;
  private startPromise:Promise<GitHubAuthSnapshot>|null=null;
  private probePromise:Promise<AuthStatus>|null=null;
  private cachedProbe:AuthStatus={available:false,authenticated:false};
  private lastProbeAt=0;
  private stdout='';
  private stderr='';

  constructor(options:GitHubAuthOptions={}){
    this.launch=options.spawnLogin||launchLogin;
    this.readAuth=options.readAuth||(()=>readGitHubCliAuthStatus());
    this.now=options.now||Date.now;
    this.setTimer=options.setTimer||setTimeout;
    this.clearTimer=options.clearTimer||clearTimeout;
    this.startupTimeoutMs=options.startupTimeoutMs||STARTUP_TIMEOUT_MS;
    this.loginTimeoutMs=options.loginTimeoutMs||LOGIN_TIMEOUT_MS;
  }

  async status():Promise<GitHubAuthSnapshot>{
    if(isActive(this.current.state))return this.snapshot();
    const auth=await this.probe();
    if(auth.authenticated){this.current={state:'authenticated',cliAvailable:true,authenticated:true,...(auth.account?{account:auth.account}:{})};}
    else if(this.current.state==='authenticated'||this.current.state==='idle'){
      this.current={state:'idle',cliAvailable:auth.available,authenticated:false,...(!auth.available?{detail:'GitHub CLI (gh) is not installed or available on PATH.'}:{})};
    }else this.current={...this.current,cliAvailable:auth.available,authenticated:false};
    return this.snapshot();
  }

  async start():Promise<GitHubAuthSnapshot>{
    if(isActive(this.current.state))return this.snapshot();
    if(this.startPromise)return this.startPromise;
    const attemptId=randomUUID();
    this.current={state:'starting',cliAvailable:true,authenticated:false,attemptId};
    this.stdout='';this.stderr='';
    this.startPromise=this.launchAttempt(attemptId);
    try{return await this.startPromise;}finally{this.startPromise=null;}
  }

  async cancel():Promise<GitHubAuthSnapshot>{
    if(!isActive(this.current.state))return this.status();
    const child=this.child;this.finishTimers();this.child=null;
    this.clearOutput();
    this.current={state:'cancelled',cliAvailable:this.current.cliAvailable,authenticated:false,attemptId:this.current.attemptId,detail:'GitHub sign-in was cancelled.'};
    try{child?.kill();}catch{/* The authorization process may already have exited. */}
    return this.snapshot();
  }

  private async launchAttempt(attemptId:string):Promise<GitHubAuthSnapshot>{
    const auth=await this.probe(true);
    if(this.current.attemptId!==attemptId)return this.snapshot();
    if(auth.authenticated){this.current={state:'authenticated',cliAvailable:true,authenticated:true,...(auth.account?{account:auth.account}:{})};this.clearOutput();return this.snapshot();}
    if(!auth.available){this.current={state:'failed',cliAvailable:false,authenticated:false,attemptId,detail:'GitHub CLI (gh) is not installed or available on PATH.'};return this.snapshot();}
    try{
      const child=this.launch([...LOGIN_ARGUMENTS]);
      this.child=child;
      child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
      child.stdout?.on('data',value=>this.receiveOutput(String(value),'stdout',attemptId));
      child.stderr?.on('data',value=>this.receiveOutput(String(value),'stderr',attemptId));
      child.once('error',error=>this.fail(attemptId,error?.code==='ENOENT'?'GitHub CLI (gh) is not installed or available on PATH.':'GitHub CLI could not start sign-in. Check that gh is available on PATH and try again.',error?.code==='ENOENT'?false:true));
      child.once('close',code=>void this.finishLogin(attemptId,typeof code==='number'?code:1));
      this.startupTimer=this.setTimer(()=>{
        if(this.current.attemptId===attemptId&&this.current.state==='starting')this.fail(attemptId,'GitHub CLI did not provide a device code. Update gh and try again.');
      },this.startupTimeoutMs);
      return this.snapshot();
    }catch(error){
      this.fail(attemptId,(error as NodeJS.ErrnoException)?.code==='ENOENT'?'GitHub CLI (gh) is not installed or available on PATH.':'GitHub CLI could not start sign-in. Check that gh is available on PATH and try again.',(error as NodeJS.ErrnoException)?.code!=='ENOENT');
      return this.snapshot();
    }
  }

  private async probe(force=false):Promise<AuthStatus>{
    if(this.probePromise)return this.probePromise;
    if(!force&&this.now()-this.lastProbeAt<1200)return this.cachedProbe;
    this.probePromise=this.readAuth().catch(()=>({available:false,authenticated:false} as AuthStatus)).then(value=>{
      this.cachedProbe={available:value.available===true,authenticated:value.authenticated===true,...(typeof value.account==='string'?{account:value.account}:{})};
      this.lastProbeAt=this.now();return this.cachedProbe;
    }).finally(()=>{this.probePromise=null;});
    return this.probePromise;
  }

  private receiveOutput(chunk:string,stream:'stdout'|'stderr',attemptId:string){
    if(this.current.attemptId!==attemptId||!isActive(this.current.state))return;
    if(this.current.state==='awaiting')return;
    if(stream==='stdout')this.stdout=(this.stdout+chunk).slice(-8_000);else this.stderr=(this.stderr+chunk).slice(-8_000);
    const combined=stripAnsi(`${this.stdout}\n${this.stderr}`);
    const urlMatch=combined.match(/https:\/\/github\.com\/login\/device(?:[/?#][^\s]*)?/i);
    const codeMatch=combined.match(/one-time code\s*:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
    const verificationUrl=urlMatch?.[0]?.replace(/[),.;]+$/,'');
    if(!verificationUrl||!codeMatch)return;
    let url:URL;try{url=new URL(verificationUrl);}catch{return;}
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.pathname!=='/login/device')return;
    if(this.startupTimer){this.clearTimer(this.startupTimer);this.startupTimer=null;}
    const expiresAt=this.now()+this.loginTimeoutMs;
    this.current={state:'awaiting',cliAvailable:true,authenticated:false,attemptId,verificationUrl:url.toString(),userCode:codeMatch[1],expiresAt};
    this.clearOutput();
    if(this.expiryTimer)this.clearTimer(this.expiryTimer);
    this.expiryTimer=this.setTimer(()=>{
      if(this.current.attemptId!==attemptId||!isActive(this.current.state))return;
      const child=this.child;this.child=null;this.finishTimers();
      this.current={state:'expired',cliAvailable:true,authenticated:false,attemptId,detail:'This sign-in attempt expired. Start a new attempt to get another code.'};this.clearOutput();
      try{child?.kill();}catch{/* The authorization process may already have exited. */}
    },this.loginTimeoutMs);
  }

  private async finishLogin(attemptId:string,code:number){
    if(this.current.attemptId!==attemptId||!isActive(this.current.state))return;
    this.finishTimers();this.child=null;
    if(code!==0){this.fail(attemptId,'GitHub CLI sign-in did not complete. Check the connection and try again.');return;}
    const auth=await this.probe(true);
    if(this.current.attemptId!==attemptId)return;
    if(auth.authenticated){this.current={state:'authenticated',cliAvailable:true,authenticated:true,...(auth.account?{account:auth.account}:{})};this.clearOutput();return;}
    this.current={state:'failed',cliAvailable:auth.available,authenticated:false,attemptId,detail:'GitHub CLI exited without confirming an authenticated account. Refresh or retry sign-in.'};this.clearOutput();
  }

  private fail(attemptId:string,detail:string,cliAvailable=true){
    if(this.current.attemptId!==attemptId||!isActive(this.current.state))return;
    const child=this.child;this.child=null;this.finishTimers();
    this.current={state:'failed',cliAvailable,authenticated:false,attemptId,detail};this.clearOutput();
    try{child?.kill();}catch{/* The authorization process may already have exited. */}
  }

  private finishTimers(){
    if(this.startupTimer){this.clearTimer(this.startupTimer);this.startupTimer=null;}
    if(this.expiryTimer){this.clearTimer(this.expiryTimer);this.expiryTimer=null;}
  }

  private clearOutput(){this.stdout='';this.stderr='';}

  private snapshot():GitHubAuthSnapshot{return {...this.current};}
}
