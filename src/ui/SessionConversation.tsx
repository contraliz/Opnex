import type { UIEvent } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { ApprovalCard, ForgeApprovalCard } from './ApprovalCards';
import { ConversationMessage, PassPanel } from './ConversationHistory';
import { ForgeBoard } from './ForgeBoard';
import type { ApprovalRequest, ForgeTicket, Task, TaskPass } from '../types';

type ApprovalDecision = 'accept' | 'decline' | 'cancel';
type QualityAction = 'accept' | 'pause' | 'resume';
type PassDisclosure = 'receipt' | 'recruitmentTeam' | 'toolCalls' | 'agentmemAudit';

type SessionConversationProps = {
  tab: string;
  task: Task;
  tabError?: string;
  expandedSections: Record<string, boolean>;
  selectedSteerWorkerId?: string;
  setConversationElement: (element: HTMLDivElement | null) => void;
  onScroll: (tab: string, element: HTMLDivElement) => void;
  onDismissError: () => void;
  onApprovalDecision: (
    requestId: string | number,
    decision: ApprovalDecision,
    content?: Record<string, unknown>
  ) => void;
  onForgeTicketChange: (ticket: ForgeTicket) => void;
  onQualityAction: (action: QualityAction) => void;
  onSelectSteerWorker: (workerId: string) => void;
  onToggleDisclosure: (passId: string, disclosure: PassDisclosure) => void;
};

export function SessionConversation({
  tab,
  task,
  tabError,
  expandedSections,
  selectedSteerWorkerId,
  setConversationElement,
  onScroll,
  onDismissError,
  onApprovalDecision,
  onForgeTicketChange,
  onQualityAction,
  onSelectSteerWorker,
  onToggleDisclosure,
}: SessionConversationProps) {
  const handleScroll = (event: UIEvent<HTMLDivElement>) => onScroll(tab, event.currentTarget);
  const errorNotice = tabError ? (
    <div className='tab-error' role='alert'>
      <AlertCircle size={15} />
      <span>{tabError}</span>
      <button className='icon-btn' aria-label='Dismiss session error' onClick={onDismissError}>
        <X size={13} />
      </button>
    </div>
  ) : null;

  if (task.sessionType === 'forge') {
    return (
      <div
        className='conversation forge-session-view'
        aria-label='Forge session'
        ref={setConversationElement}
        onScroll={handleScroll}
      >
        {errorNotice}
        {task.approvalRequests?.map((request) => (
          <ForgeApprovalCard
            key={String(request.requestId)}
            ticket={task.forge}
            request={request}
            onDecision={(decision, content) =>
              onApprovalDecision(request.requestId, decision, content)
            }
          />
        ))}
        {task.forge ? (
          <ForgeBoard ticket={task.forge} task={task} onTicketChange={onForgeTicketChange} />
        ) : (
          <div role='status' className='forge-empty-state'>
            Forge ticket details are not present in this saved session snapshot. Refresh the session
            or restart the local service before continuing.
          </div>
        )}
      </div>
    );
  }

  const unassociatedMessages: Task['messages'] = [];
  const messagesByPass = new Map<string, Task['messages']>();
  for (const message of task.messages) {
    if (!message.passId) {
      unassociatedMessages.push(message);
      continue;
    }
    const messages = messagesByPass.get(message.passId) || [];
    messages.push(message);
    messagesByPass.set(message.passId, messages);
  }

  return (
    <div className='conversation' ref={setConversationElement} onScroll={handleScroll}>
      {errorNotice}
      {unassociatedMessages.map((message) => (
        <ConversationMessage key={message.id} message={message} />
      ))}
      {task.passes?.map((pass) => (
        <PassPanel
          key={pass.id}
          pass={pass}
          messages={messagesByPass.get(pass.id) || []}
          active={pass.id === task.currentPassId}
          task={task}
          onQualityAction={onQualityAction}
          selectedSteerWorkerId={pass.recruitmentTeam ? selectedSteerWorkerId : undefined}
          onSelectSteerWorker={onSelectSteerWorker}
          receiptExpanded={isDisclosureExpanded(expandedSections, pass.id, 'receipt')}
          recruitmentTeamExpanded={isDisclosureExpanded(
            expandedSections,
            pass.id,
            'recruitmentTeam'
          )}
          toolCallsExpanded={isDisclosureExpanded(expandedSections, pass.id, 'toolCalls')}
          agentmemAuditExpanded={isDisclosureExpanded(expandedSections, pass.id, 'agentmemAudit')}
          toggleReceipt={() => onToggleDisclosure(pass.id, 'receipt')}
          toggleRecruitmentTeam={() => onToggleDisclosure(pass.id, 'recruitmentTeam')}
          toggleToolCalls={() => onToggleDisclosure(pass.id, 'toolCalls')}
          toggleAgentMemAudit={() => onToggleDisclosure(pass.id, 'agentmemAudit')}
        />
      ))}
      {task.approvalRequests?.map((request: ApprovalRequest) => (
        <ApprovalCard
          key={String(request.requestId)}
          request={request}
          onDecision={(decision, content) =>
            onApprovalDecision(request.requestId, decision, content)
          }
        />
      ))}
    </div>
  );
}

function isDisclosureExpanded(
  expandedSections: Record<string, boolean>,
  passId: TaskPass['id'],
  disclosure: PassDisclosure
) {
  return expandedSections[`${disclosure}:${passId}`] ?? false;
}
