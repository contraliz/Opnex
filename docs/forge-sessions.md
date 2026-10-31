# Forge sessions

Forge adds a workspace-owned ticket workflow alongside the existing Conversation sessions. A Forge ticket is a draft until you start it; creating it does not dispatch model work.

> **Known limitation:** strict Forge workers currently cannot complete Git commits. Their worktree commit writes to shared Git object storage outside the worker's permitted write roots. The private per-attempt object-store correction is not implemented. A recent bounded disposable live ticket did not complete: its worker could not commit, and the host validator also failed on an equal-baseline `rev-list` check. Forge is not production-accepted; treat this branch as a testing handoff.

## Create and start a ticket

Select a named workspace and choose **Forge** when opening a new session. Enter a title, task description, checkable acceptance criteria, and workspace-relative read/write scopes. Choose the Codex orchestrator model and effort, select the local target branch, and set any additional Opnex skills. The worker model and effort come from Settings and are copied into the ticket when it is created. The approval policy is copied too; **Full Access** is not supported for Forge.

Forge requires the `agentmem-project` skill to be present in the workspace or a configured Codex skill location. That only supplies instructions: Opnex does not configure or call the external AgentMem service. Without a matching external service registration, knowledge lookup is unavailable. The ticket can continue with other work when its assignment does not require that knowledge. Knowledge scope and operation limits are instruction-only unless the external skill interface enforces them.

Create the draft, review its saved scope and profiles, then choose **Start Forge** to authorize execution within that ticket. The selected orchestrator plans and validates the work; a valid plan automatically continues into eligible workers without another confirmation. Invalid or stale plans fail safely and remain visible on the board. Pause or cancel Forge if you need to stop after starting. The board reports `open`, `claimed`, `finished`, and `blocked` work items, plus receipts, attempts, tool counts, worker commits, integration checks, and runtime capability labels.

## Pause, resume, and completion

Use **Pause** to stop new dispatches and request cancellation of active work, or **Cancel ticket** to end the ticket. A cancellation can remain uncertain while a provider effect is in flight. After an application restart, an unknown live run is blocked for reconciliation; Forge will not start a duplicate writer automatically. Refresh the board to read the saved state and follow its attention message.

Worker completion is provisional. The integrator combines the worker commits in a dedicated local branch, runs the ticket's checks and QA, and saves a combined receipt. The orchestrator reviews that receipt and candidate diff. A ticket becomes complete only after the guarded local merge into the pinned target branch succeeds and its commit is read back. Forge does not push a branch or publish a release.

## Runtime limits

Forge uses each worker's own Git worktree, but a worktree alone does not confine filesystem access. The board labels runtime capabilities as enforced, monitored, instruction-only, or unavailable. Strict filesystem confinement is required for unattended writes. The current DeepSeek Harness adapter does not provide that confinement, so Forge blocks strict DeepSeek worker execution unless a supported outer sandbox is present. Do not treat Full Access or a worktree as a sandbox.

The default ticket limits are up to three active workers, two execution attempts per work item, three integrator correction rounds, a shared 64-operation knowledge budget, and a default allocation of two (maximum eight) knowledge operations per run. These are workflow limits, not provider credits or dollar caps. Retries and replacement attempts use the same shared knowledge balance.

Forge currently exposes no Opnex-owned tools to its model roles. Tool requests received on a Forge provider turn fail closed and do not fall through to Conversation handlers. Provider-native tools remain subject to the provider's actual runtime and sandbox; the board's scope and capability labels describe only what Opnex can verify.

## Testing handoff

Earlier in integration, the full suite passed (73 files, 699 tests), and `npm run typecheck`, `npm run lint`, `npm run build`, `npm run desktop:smoke`, and `npm run desktop:interaction-smoke` passed. These results predate the final UI handoff edits and do not verify the handoff branch's final head. Rerun those commands from the repository root when testing this branch. A disposable live Forge ticket can confirm planning and dispatch, but do not count it as successful completion until the worker commit, integrated candidate review, guarded merge, and readback all succeed. No production acceptance is claimed.
