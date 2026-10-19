# Architecture

Pseudoharness is a localhost desktop-style web application with a React/Vite/TypeScript UI and Node/TypeScript service. The service controls Codex app-server over stdio JSONL and AgentMem through its already configured MCP stdio transport. It does not modify global Codex settings, invent an AgentMem HTTP API, or use direct API keys.

## Scheduling and contracts

Each task has a separate orchestrator thread and Luna worker thread. The orchestrator must return one full schema-validated assignment before the worker is started. Assignment scope has explicit read and write arrays; empty read scope is allowed for answer-only work, while empty write scope authorizes no filesystem writes. Non-empty write roots are validated inside the selected workspace before being passed to Codex. Luna is explicitly `gpt-6-luna` with high effort and is not replaced with another model. Completion is idempotent by turn ID. A correction is limited to one consolidated update and reuses the worker thread.

The only orchestrator wake causes are explicit user input, an explicit structured worker escalation, and a final receipt. Progress events and timers update the UI but cannot schedule inference. Worker transcripts and tool output are not passed to the orchestrator. Assignments, receipts, escalation, and review decisions are validated server-side; invalid results stop the workflow with an actionable error.

## Approval and sandbox

The composer exposes Codex approval presets, serialized to app-server's `approvalPolicy`: `on-request`, `untrusted`, or `never`. The app-server `sandboxPolicy` separately sets worker turns to `readOnly` when no write roots are authorized or `workspaceWrite` with validated roots and network access disabled when writes are authorized. Orchestrator turns are read-only. `never` suppresses prompts; it does not broaden sandbox access. No danger-full-access preset or custom approval editor is implemented.

When app-server sends a command/file-change or permission approval request, the service records it against the correct task and presents details in the UI. The user can accept, decline, or cancel; the service answers the original server request ID using the method's protocol response. Requests for unsupported methods are rejected and shown as actionable errors. The protocol is experimental and this request handling should be revalidated after CLI updates.

Read scope is still prompt/assignment guidance rather than an OS-level read restriction. The actual read/write boundary depends on the user's installed Codex sandbox and profile. Localhost binding and request-origin checks limit access to the local machine, but the service has no authentication system and must not be exposed to a network.

## Persistence, recovery, and AgentMem

The app stores task IDs, thread/turn IDs, revisions, messages, and completion deduplication state in the operating system's local application-data directory. Active work is paused on restart and is never automatically replayed. Explicit user action attempts to resume the saved Codex thread; unavailable threads or active-writer conflicts remain paused for inspection. Cancellation is saved before a best-effort interrupt, and late events for cancelled tasks are ignored. A user update during work interrupts/serializes the existing turn before one consolidated update is scheduled.

Settings require a workspace root and an already-registered AgentMem project identity. First-run defaults are blank so a public clone cannot adopt a developer's private project by assumption. The service verifies that the registered root matches the selected root, then retrieves scoped requirements, accepted lessons, and evidence before assignment. Durable work receipts and runtime thread state remain separate. AgentMem completion includes acceptance evidence and the current requirement revision; the AgentMem service decides whether the task is done and clears the lease. Incomplete results remain in progress and release ownership; blocked results are recorded as blocked then released; cancellation releases ownership. Adapter errors remain visible in app state rather than claiming persistence succeeded.

## Local security

The server binds to `127.0.0.1`, rejects non-loopback hosts and mismatched origins, uses a process-local mutation token, bounds JSON payloads, and starts app-server without constructing shell command strings from task content. Runtime state, environment files, dependencies, build output, and temporary QA files are ignored by Git. The application is intended for one local user and does not provide a network deployment model.

## Deferred work

The requested roadmap items are listed in [ROADMAP.md](../ROADMAP.md): editable custom approval policies and multimodal task input. This release does not implement them.
