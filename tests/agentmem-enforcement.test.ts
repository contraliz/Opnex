import { describe, expect, it } from 'vitest';
import { agentMemArtifactUsageGaps } from '../server/agentmem-enforcement.js';
import type { AgentMemAudit, TaskPass } from '../server/state.js';
import type { Receipt } from '../server/contracts.js';
import { recordAgentReceipt } from '../server/receipt-provenance.js';

const stamp='2026-10-24T10:00:00.000Z';
function pass():TaskPass{return {id:'pass-1',index:1,createdAt:stamp,userInput:'change source',userInputs:['change source'],userMessageIds:[],phase:'worker_running',correctionCount:0,processedTurns:[],agentmemAudit:{recorded:true,coverage:'full_pass',selectedProjectId:'pseudoharness',workspaceRoot:'D:/programming/pseudoharness',verifiedProjectId:'pseudoharness',verifiedRoot:'D:/programming/pseudoharness',verifiedRepositoryId:'repo-1',identityStatus:'verified',modelMcpStatus:'observed',contexts:[],calls:[]}};}
function receipt(updated:string[]=[]):Receipt{return {status:'complete',result:'done',changes:[],acceptance:{met:['done'],unmet:[]},verification:[{check:'check',result:'passed'}],risks:[],knowledge:{consulted:[],updated},decision_required:null};}
function call(audit:AgentMemAudit,method:string,service:'knowledge'|'repository_index',operation:'read'|'write',id=method){audit.calls.push({id,source:'model',role:'worker',method,status:'completed',startedAt:stamp,updatedAt:stamp,threadId:'thread-1',turnId:'turn-1',service,operation,projectId:'pseudoharness',repositoryId:service==='repository_index'?'repo-1':undefined});}
function readyPass(sourceDiff=''){const current=pass();const audit=current.agentmemAudit!;call(audit,'decisions','knowledge','read');call(audit,'repository_search','repository_index','read');current.turnSourceChanges=[{role:'worker',threadId:'thread-1',turnId:'turn-1',status:'verified',workspaceRoot:'D:/programming/pseudoharness',baselineCapturedAt:stamp,completedAt:'2026-10-24T10:01:00.000Z',changedPaths:sourceDiff?['src/a.ts']:[],repositoryRevisionChanged:false}];current.gitDiff={status:'recorded',source:'codex-turn-diff',updatedAt:stamp,turns:[{threadId:'thread-1',turnId:'turn-1',role:'worker',diff:sourceDiff,capturedAt:stamp}]};return current;}

describe('artifact AgentMem enforcement',()=>{
  it('requires model reads from both distinct services for the same role and turn',()=>{
    const current=pass();
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt())).toContain('The model did not complete a knowledge-base read against the selected project during the artifact-producing turn.');
    call(current.agentmemAudit!,'decisions','knowledge','read');
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt())).toContain('The model did not search or retrieve code from the selected repository index during the artifact-producing turn.');
  });

  it('accepts verified reads, a justified no-change decision and a complete unchanged-source snapshot',()=>{
    const current=readyPass();
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because the task was a verification-only review.','No repository resync was needed because the full turn diff is empty.']))).toEqual([]);
  });

  it('accepts the required hyphenated repository-index resync wording',()=>{
    const current=readyPass();
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because this audit produced no new durable facts.','No repository-index resync was needed because this was a read-only audit and no source files changed.']))).toEqual([]);
  });

  it('requires a later model-issued repository resync when source files changed',()=>{
    const current=readyPass('diff --git a/a.ts b/a.ts');
    const noWrite=receipt(['No AgentMem knowledge update was needed because no durable project decision changed.']);
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',noWrite)).toContain('Repository files changed or the change snapshot was truncated, but the model did not complete a repository-index resync in this turn.');
    const audit=current.agentmemAudit!;call(audit,'repository_resync','repository_index','write');audit.calls.at(-1)!.updatedAt='2026-10-24T10:01:00.000Z';
    expect(agentMemArtifactUsageGaps(audit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because no durable project decision changed.','Repository index refreshed after source edits.']))).toEqual([]);
  });

  it('rejects missing/partial snapshots and receipts that omit knowledge write or no-change rationale',()=>{
    const current=readyPass();current.turnSourceChanges=undefined;
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because no durable project decision changed.']))[0]).toMatch(/before\/after workspace snapshot is unavailable/);
    const truncated=readyPass();truncated.turnSourceChanges![0].status='unavailable';truncated.turnSourceChanges![0].reason='The snapshot exceeded its safety limits.';
    expect(agentMemArtifactUsageGaps(truncated.agentmemAudit,truncated,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because no durable knowledge changed.','No repository resync was needed because nothing changed.']))[0]).toContain('snapshot exceeded its safety limits');
    const empty=readyPass();
    expect(agentMemArtifactUsageGaps(empty.agentmemAudit,empty,'worker','thread-1','turn-1',receipt())).toContain('The receipt must name a completed knowledge write or explain why no AgentMem knowledge update was needed.');
  });

  it('blocks a mismatched KB/workspace identity rather than accepting otherwise valid calls',()=>{
    const current=readyPass();current.agentmemAudit!.verifiedRoot='D:/other';
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt())).toEqual(['The selected AgentMem project and workspace identity are not verified.']);
  });
  it('normalizes Windows path separators when validating the same selected workspace',()=>{
    const current=readyPass();current.agentmemAudit!.workspaceRoot='D:/programming/pseudoharness';current.agentmemAudit!.verifiedRoot='D:\\programming\\pseudoharness\\';
    expect(agentMemArtifactUsageGaps(current.agentmemAudit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because no durable decision changed.','No repository resync was needed because the verified source snapshot did not change.']))).toEqual([]);
  });
  it('requires a code search against the exact registered repository index, not a status call or another index',()=>{
    const current=readyPass();const audit=current.agentmemAudit!;audit.calls=audit.calls.filter(row=>row.service!=='repository_index');call(audit,'repository_status','repository_index','read');
    expect(agentMemArtifactUsageGaps(audit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because there was no durable finding.','No repository resync was needed because the source snapshot was unchanged.']))[0]).toContain('did not search or retrieve code');
    audit.calls=audit.calls.filter(row=>row.method!=='repository_status');call(audit,'repository_search','repository_index','read');audit.calls.at(-1)!.repositoryId='another-repo';
    expect(agentMemArtifactUsageGaps(audit,current,'worker','thread-1','turn-1',receipt(['No AgentMem knowledge update was needed because there was no durable finding.','No repository resync was needed because the source snapshot was unchanged.']))[0]).toContain('did not search or retrieve code');
  });

  it('stores each artifact-producing receipt against its exact role, thread, turn and references',()=>{
    const current=pass();const first=receipt();first.changes=['src/first.ts'];
    recordAgentReceipt(current,'worker','thread-1','turn-1',first,stamp);
    const second=receipt();second.changes=['src/second.ts'];
    recordAgentReceipt(current,'worker','thread-1','turn-2',second,'2026-10-24T10:02:00.000Z');
    recordAgentReceipt(current,'worker','thread-1','turn-2',second,'2026-10-24T10:03:00.000Z');
    expect(current.agentReceipts).toHaveLength(2);
    expect(current.agentReceipts?.[0]).toMatchObject({producerRole:'worker',threadId:'thread-1',turnId:'turn-1',artifactRefs:['src/first.ts'],receipt:first});
    expect(current.agentReceipts?.[1]?.recordedAt).toBe('2026-10-24T10:03:00.000Z');
  });
});
