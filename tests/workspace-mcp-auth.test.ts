import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { authorizedWorkspaceRoot } from '../server/workspace-mcp-auth.js';

const root=path.resolve(os.tmpdir(),'authorized-workspace');
const scope={taskId:'task-a',passId:'pass-a',role:'worker' as const,sessionId:'worker-a'};
function task(overrides:Record<string,unknown>={}){
  return {id:scope.taskId,userRoot:root,currentPassId:scope.passId,phase:'worker_running',activeRole:'worker',activeTurnId:'turn-a',workerStage:'execute',workerThreadId:scope.sessionId,passes:[{id:scope.passId,workerStage:'execute',executionProfile:{provider:'deepseek'}}],...overrides};
}

describe('workspace MCP authorization',()=>{
  it('binds a simple execution to its current DeepSeek pass, turn, and working directory',()=>{
    const row=task({phase:'simple_running',activeRole:'simple',simpleThreadId:'simple-a',workerStage:undefined,workerThreadId:undefined,passes:[{id:scope.passId,executionProfile:{provider:'deepseek'}}]});
    expect(authorizedWorkspaceRoot({tasks:[row]},{...scope,role:'simple',sessionId:'simple-a'})).toBe(root);
    expect(authorizedWorkspaceRoot({tasks:[{...row,currentPassId:'pass-b'}]},{...scope,role:'simple',sessionId:'simple-a'})).toBeUndefined();
    expect(authorizedWorkspaceRoot({tasks:[{...row,activeTurnId:undefined}]},{...scope,role:'simple',sessionId:'simple-a'})).toBeUndefined();
  });

  it('allows only the active recruited DeepSeek worker or integrator from a sealed current-pass team',()=>{
    const team={sealed:true,passId:scope.passId,workers:[{threadId:'worker-a',status:'running',activeTurnId:'turn-worker',executionProfile:{provider:'deepseek'}}],integration:{threadId:'integrator-a',status:'running',activeTurnId:'turn-integrator',deepSeekExecution:{provider:'opencode-go'}}};
    const row=task({workerStage:undefined,workerThreadId:undefined,passes:[{id:scope.passId,recruitmentTeam:team}]});
    expect(authorizedWorkspaceRoot({tasks:[row]},scope)).toBe(root);
    expect(authorizedWorkspaceRoot({tasks:[row]},{...scope,sessionId:'integrator-a'})).toBe(root);
    expect(authorizedWorkspaceRoot({tasks:[{...row,passes:[{id:scope.passId,recruitmentTeam:{...team,sealed:false}}]}]},scope)).toBeUndefined();
    expect(authorizedWorkspaceRoot({tasks:[{...row,phase:'paused_after_restart'}]},scope)).toBeUndefined();
    expect(authorizedWorkspaceRoot({tasks:[{...row,passes:[{id:scope.passId,recruitmentTeam:{...team,workers:[{...team.workers[0],status:'complete'}]}}]}]},scope)).toBeUndefined();
  });

  it('rejects a Codex thread, a wrong session, and an unvalidated directory',()=>{
    expect(authorizedWorkspaceRoot({tasks:[task({passes:[{id:scope.passId,executionProfile:{provider:'codex'},workerStage:undefined}],workerStage:undefined})]},scope)).toBeUndefined();
    expect(authorizedWorkspaceRoot({tasks:[task()]},{...scope,sessionId:'other'})).toBeUndefined();
    expect(authorizedWorkspaceRoot({tasks:[task({userRoot:'relative/path'})]},scope)).toBeUndefined();
  });
});
