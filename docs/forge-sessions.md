# Forge sessions

Forge adds a workspace-owned ticket workflow alongside the existing Conversation sessions. A Forge ticket is a draft until you start planning; creating it does not dispatch model work.

## Create and start a ticket

Select a named workspace and choose **Forge** when opening a new session. Enter a title, task description, checkable acceptance criteria, and workspace-relative read/write scopes. Choose the Codex orchestrator model and effort, select the local target branch, and set any additional Opnex skills. The worker model and effort come from Settings and are copied into the ticket when it is created. The approval policy is copied too; **Full Access** is not supported for Forge.

Forge requires the `agentmem-project` skill to be present in the workspace or a configured Codex skill location. That only supplies instructions: Opnex does not configure or call the external AgentMem service. Without a matching external service registration, knowledge lookup is unavailable. The ticket can continue with other work when its assignment does not require that knowledge. Knowledge scope and operation limits are instruction-only unless the external skill interface enforces them.

Create the draft, read its saved scope and profiles, then choose **Start planning**. Review the proposed assignments and dependency links before choosing **Accept plan and start workers**. The board reports `open`, `claimed`, `finished`, and `blocked` work items, plus receipts, attempts, tool counts, worker commits, integration checks, and runtime capability labels.

## Pause, resume, and completion

Use **Pause** to stop new dispatches and request cancellation of active work, or **Cancel ticket** to end the ticket. A cancellation can remain uncertain while a provider effect is in flight. After an application restart, an unknown live run is blocked for reconciliation; Forge will not start a duplicate writer automatically. Refresh the board to read the saved state and follow its attention message.

Worker completion is provisional. The integrator combines the worker commits in a dedicated local branch, runs the ticket's checks and QA, and saves a combined receipt. The orchestrator reviews that receipt and candidate diff. A ticket becomes complete only after the guarded local merge into the pinned target branch succeeds and its commit is read back. Forge does not push a branch or publish a release.

## Runtime limits

Forge uses each worker's own Git worktree, but a worktree alone does not confine filesystem access. The board labels runtime capabilities as enforced, monitored, instruction-only, or unavailable. Strict filesystem confinement is required for unattended writes. The current DeepSeek Harness adapter does not provide that confinement, so Forge blocks strict DeepSeek worker execution unless a supported outer sandbox is present. Do not treat Full Access or a worktree as a sandbox.

The default ticket limits are up to three active workers, two execution attempts per work item, three integrator correction rounds, a shared 64-operation knowledge budget, and a default allocation of two (maximum eight) knowledge operations per run. These are workflow limits, not provider credits or dollar caps. Retries and replacement attempts use the same shared knowledge balance.

Forge currently exposes no Opnex-owned tools to its model roles. Tool requests received on a Forge provider turn fail closed and do not fall through to Conversation handlers. Provider-native tools remain subject to the provider's actual runtime and sandbox; the board's scope and capability labels describe only what Opnex can verify.
