import type { AccessMode, Settings } from '../types.js';

export const ACCESS_MODE_OPTIONS = [
  { value: 'read-only', label: 'Read-only' },
  { value: 'workspace-write', label: 'Workspace write · auto-block' },
  { value: 'workspace-write-approval', label: 'Workspace write · approval' },
  { value: 'full-access', label: 'Full access (unrestricted)' },
] as const;

export const ACCESS_MODE_HELP =
  'Read-only blocks every write. Auto-block stops at the sandbox edge without prompting. Approval waits for you at that edge. Full access removes the sandbox.';

export function accessModeFromApproval(policy: Settings['approvalPolicy']): AccessMode {
  return policy === 'full-access'
    ? 'full-access'
    : policy === 'never'
      ? 'workspace-write'
      : 'workspace-write-approval';
}

export function runtimeApprovalForAccess(mode: AccessMode): Settings['approvalPolicy'] {
  return mode === 'workspace-write-approval'
    ? 'on-request'
    : mode === 'full-access'
      ? 'full-access'
      : 'never';
}
