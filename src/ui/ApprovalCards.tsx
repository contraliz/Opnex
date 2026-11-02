import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { ApprovalRequest, ForgeTicket } from '../types';
export function ForgeApprovalCard({
  ticket,
  request,
  onDecision,
}: {
  ticket?: ForgeTicket;
  request: ApprovalRequest;
  onDecision: (
    decision: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => void;
}) {
  return (
    <ApprovalCard
      request={request}
      onDecision={onDecision}
      disabledReason={
        ticket
          ? forgeApprovalResponseReason(ticket, request)
          : 'The saved Forge ticket is unavailable. Refresh the session before responding.'
      }
    />
  );
}
function forgeApprovalResponseReason(ticket: ForgeTicket, request: ApprovalRequest) {
  if (ticket.phase === 'paused')
    return 'Forge is paused. Review the saved run and resume the ticket before answering; this request remains pending.';
  if (ticket.phase === 'cancelled' || ticket.phase === 'complete')
    return 'This Forge ticket is cancelled or complete. The saved request cannot receive a response.';
  if (ticket.phase === 'blocked')
    return `Forge needs reconciliation before this request can be answered${ticket.attentionReason ? `: ${ticket.attentionReason}` : ''}. Refresh the board and reconcile the saved run.`;
  if (!['planning', 'review', 'running', 'integrating'].includes(ticket.phase))
    return 'This request is not attached to a currently actionable Forge run.';
  const context = request.forgeContext;
  if (!context || context.ticketId !== ticket.id)
    return 'This saved request is missing its Forge run identity and cannot be answered.';
  if (context.targetType === 'planning' || context.targetType === 'final_review') {
    const run = ticket.orchestratorRuns.find(
      (row) => row.id === context.targetId && row.purpose === context.targetType
    );
    if (run?.status === 'unknown_after_restart')
      return 'The orchestrator run status is uncertain after restart. Refresh and reconcile the saved run before answering; the request remains pending.';
    if (
      !run ||
      ticket.activeOrchestratorRunId !== run.id ||
      run.status !== 'running' ||
      run.ownerId !== context.ownerId ||
      run.threadId !== request.threadId ||
      run.turnId !== request.turnId ||
      context.claimToken
    )
      return 'This request no longer matches the active orchestrator run and cannot be answered.';
    return undefined;
  }
  if (context.targetType === 'worker_attempt') {
    const attempt = ticket.attempts.find((row) => row.id === context.targetId);
    if (attempt?.status === 'unknown_after_restart' || attempt?.status === 'unknown_effect')
      return 'The worker attempt is uncertain or unreconciled. Refresh and reconcile the saved attempt before answering; the request remains pending.';
    const active = ticket.workitems.some(
      (row) => row.id === attempt?.taskId && row.activeAttemptId === attempt.id
    );
    if (
      !attempt ||
      !active ||
      attempt.status !== 'claimed' ||
      attempt.claim.ownerId !== context.ownerId ||
      attempt.claim.token !== context.claimToken ||
      attempt.threadId !== request.threadId ||
      attempt.turnId !== request.turnId
    )
      return 'This request no longer matches an active worker attempt and cannot be answered.';
    return undefined;
  }
  const run = ticket.integration.runs.find((row) => row.id === context.targetId);
  if (run?.status === 'unknown_after_restart')
    return 'The integration run status is uncertain after restart. Refresh and reconcile the saved run before answering; the request remains pending.';
  if (
    !run ||
    ticket.integration.activeRunId !== run.id ||
    run.status !== 'running' ||
    run.ownerId !== context.ownerId ||
    run.threadId !== request.threadId ||
    run.turnId !== request.turnId ||
    context.claimToken
  )
    return 'This request no longer matches the active integration run and cannot be answered.';
  return undefined;
}
export function ApprovalCard({
  request,
  onDecision,
  disabledReason,
}: {
  request: ApprovalRequest;
  onDecision: (
    decision: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ) => void;
  disabledReason?: string;
}) {
  const [contentText, setContentText] = useState('{}');
  const [contentError, setContentError] = useState('');
  const permission = request.method === 'item/permissions/requestApproval';
  const elicitation = request.method === 'mcpServer/elicitation/request';
  const forgeContext = request.forgeContext;
  const accept = () => {
    if (disabledReason) return;
    if (!elicitation || request.mode === 'url' || !request.requestedSchema) {
      onDecision('accept');
      return;
    }
    try {
      const value = JSON.parse(contentText || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Response must be a JSON object.');
      onDecision('accept', value as Record<string, unknown>);
      setContentError('');
    } catch (error) {
      setContentError(error instanceof Error ? error.message : 'Enter a valid JSON object.');
    }
  };
  return (
    <section
      className='approval-card'
      aria-label={elicitation ? 'MCP server input request' : 'Codex approval needed'}
    >
      <div className='approval-heading'>
        <ShieldCheck size={15} />
        <strong>{elicitation ? 'MCP server needs your input' : 'Approval needed'}</strong>
        <span>
          {forgeContext
            ? `Forge · ${forgeContext.targetType.replaceAll('_', ' ')}`
            : elicitation
              ? `${request.serverName || 'MCP server'} · ${request.mode || 'form'}`
              : permission
                ? 'Permission request'
                : request.method.includes('fileChange')
                  ? 'File change'
                  : 'Command execution'}
        </span>
      </div>
      {(elicitation ? request.message : request.reason) && (
        <p>{elicitation ? request.message : request.reason}</p>
      )}
      {forgeContext && (
        <div className='approval-meta'>
          Bound to {forgeContext.targetType.replaceAll('_', ' ')} run {forgeContext.targetId} ·{' '}
          {forgeContext.ownerId}
        </div>
      )}
      {disabledReason && (
        <div className='forge-approval-inactive' role='status'>
          {disabledReason}
        </div>
      )}
      {request.url && elicitation && (
        <div className='approval-meta'>Requested URL: {request.url}</div>
      )}
      {elicitation && request.requestedSchema && (
        <>
          <div className='approval-meta'>Requested fields</div>
          <pre className='permission-preview'>
            {JSON.stringify(request.requestedSchema, null, 2)}
          </pre>
          <label className='approval-form-label'>
            Response JSON
            <textarea
              disabled={!!disabledReason}
              value={contentText}
              onChange={(event) => {
                setContentText(event.target.value);
                setContentError('');
              }}
              spellCheck={false}
              aria-label='MCP response JSON'
            />
          </label>
          {contentError && (
            <div role='alert' className='approval-error'>
              {contentError}
            </div>
          )}
        </>
      )}
      {request.command && <pre>{request.command}</pre>}
      {request.networkHost && (
        <div className='approval-meta'>
          Network destination: {request.networkHost} ({request.networkProtocol})
        </div>
      )}
      {request.cwd && <div className='approval-meta'>Working directory: {request.cwd}</div>}
      {request.grantRoot && (
        <div className='approval-meta'>Requested write root: {request.grantRoot}</div>
      )}
      {permission && (
        <pre className='permission-preview'>
          {JSON.stringify(request.permissionRequest, null, 2)}
        </pre>
      )}
      <div className='approval-actions'>
        <button disabled={!!disabledReason} onClick={() => onDecision('decline')}>
          Decline
        </button>
        <button disabled={!!disabledReason} onClick={() => onDecision('cancel')}>
          Cancel turn
        </button>
        <button className='approval-accept' disabled={!!disabledReason} onClick={accept}>
          {elicitation
            ? 'Send response'
            : permission
              ? 'Grant requested permissions'
              : 'Approve once'}
        </button>
      </div>
    </section>
  );
}
