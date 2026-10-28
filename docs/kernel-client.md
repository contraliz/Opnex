# Headless kernel and client contract

Pseudoharness runs as one local execution kernel per writable state directory. The kernel owns persisted projects, settings, sessions, approval requests, recruited worker teams, provider sessions, worktrees, receipts, and recovery. Browser pages and the Electron window are clients: closing or reconnecting a page does not schedule, resume, or cancel model work.

## Start a browser client without Electron

From a source checkout:

```sh
npm ci --include=dev
npm run build
npm start
```

Open <http://127.0.0.1:4174>. The server binds to `127.0.0.1`. `PORT` changes its port; `PSEUDOHARNESS_DATA_DIR` chooses another absolute local state directory. Each distinct state directory has one kernel owner. A second process pointed at an owned directory reports `STATE_DIRECTORY_IN_USE`; separate directories can run independent profiles. Do not expose the listener to a network.

The development web page uses the same local API boundary through Vite's proxy. Electron starts the same server as a headless utility process, then attaches the window to it. The kernel writes its loopback address and a startup proof to `kernel-instance.json`; Electron reads that record from the profile's app-data directory. When another shell is launched for the same profile, it attaches only after the challenge response matches the recorded kernel instance. A stale discovery record is ignored and replaced by the kernel that successfully claims the state lock.

Closing the Electron window disconnects that client and leaves the shell and kernel available from the Pseudoharness system tray. The tray's **Open Pseudoharness** action restores the existing window or creates a new one without starting another kernel. **Quit** stops a kernel launched by that shell through the versioned shutdown API, waits for its managed process to exit, and then closes the shell; a shell attached to an independently running kernel only disconnects. The **Stop Pseudoharness kernel** Settings action remains an explicit, confirmed shutdown: it persists the paused state, terminates owned provider processes, closes all event streams, releases profile ownership, and disconnects every client. Process termination or restart also pauses active work; the kernel never silently replays a turn or emits a replacement completion wake.

## Protocol version 1

Every `/api/v1/*` request must supply `x-pseudoharness-protocol-version: 1`. EventSource clients pass `?protocol=1`, because the browser API does not let them set request headers. A missing, stale, or unsupported version returns HTTP 426 with `PROTOCOL_VERSION_MISMATCH`. The existing `/api/*` routes remain available for legacy clients. Version 1 maps supported commands onto those same server-side validators and handlers; it does not give the page authority to write state directly.

The first client request is `GET /api/v1/snapshot`. It returns:

```json
{
  "protocolVersion": 1,
  "kernelInstanceId": "...",
  "cursor": 42,
  "state": { "revision": 42 },
  "runtime": {},
  "csrf": "..."
}
```

The `csrf` value is process-local. Send it as `x-pseudoharness-token` on every mutation, together with the protocol version. For example, `POST /api/v1/projects/select` carries the same JSON body as the compatible `/api/projects/select` route. The kernel validates project IDs, settings, approvals, file paths, write scopes, and workflow state before changing the persisted snapshot. A rejected command leaves state unchanged and returns an HTTP error.

`GET /api/v1/info` returns the protocol version, instance ID, loopback host/port, and persisted revision. `GET /api/v1/events?protocol=1` opens a server-sent event stream. Each state event has an SSE `id` equal to the persisted monotonic revision and contains a complete snapshot, not a partial patch. A reconnect sends the browser's `Last-Event-ID`; clients may also pass `?after=<revision>`. If the saved cursor no longer equals the current revision, the kernel sets `resync: true` and sends the latest full snapshot. Snapshot reconnects never issue commands or wake a model.

The revision increments after every successful state mutation, after the new state has been written to disk and before clients are notified. The stream does not retain a delta-event journal. Clients that fall behind receive a full current snapshot and resume at that revision. Heartbeats carry no state cursor.

`POST /api/v1/kernel/shutdown` requires the same version and CSRF headers and the explicit body `{"confirm":"stop-kernel"}`. It returns HTTP 202 only after saving active jobs as paused. If AgentMem work or a receipt write is still in progress, it returns HTTP 409 (`AGENTMEM_WORK_PENDING`) and leaves the kernel running.

## Local security and compatibility

The kernel binds only to loopback, validates the request `Host` and allowed browser origins, uses a session token for mutations, applies request-size limits, and retains the existing route-level schema, path, approval, and task-scope checks. It does not trust a client-provided provider, session, worktree, or approval outcome. A client protocol mismatch fails with an explicit error; it does not downgrade to a different provider or permission policy.

State upgrades remain in the existing state format. A missing monotonic revision is initialized to zero and persisted along with other safe normalization. If the state file cannot be parsed or validated, the kernel keeps the file and reports a state error instead of replacing user history. Existing completed messages, receipts, and worktrees remain available. Active work is marked interrupted and paused for explicit user follow-up.

QA correction planning records a preflight marker before sending a planner turn. A preflight-only setup failure can resume from its saved findings because no turn was sent. Once a turn may have been sent, pause, disconnect, and restart keep that dispatch marked unresolved; neither another correction plan nor a QA audit can resume until the exact turn reaches a confirmed terminal or interrupted outcome. Old paused correction records without a dispatch marker are treated as unresolved because their send state cannot be reconstructed safely.

Codex remains responsible for routing, orchestration, simple work, and review. Recruited execution and integration roles use the saved DeepSeek Harness profile, without a silent Codex fallback. The native requested model and effort are recorded for each role and privilege phase. The installed SDK does not report effective reasoning effort; approval responses, steering, and per-session cancellation are unsupported. Cancellation and kernel shutdown terminate the owned process tree. In writable Full Access phases, the native runtime is unrestricted and the validated assignment write scope is an instruction, not operating-system confinement. Read-only planning and context composition run with the DSH read-only preset before any authorized writable execution session starts.

The execution-phase audit keeps a separate DSH session ID, turn ID, provider/model, requested native effort, selected policy, native permission preset, validated worktree/write scope, runtime/SDK identity, and terminal status for each phase. Assignment constraints and AgentMem canonical project identity stay distinct from the task-owned worktree. Unsupported permissions and unverified provider tools fail closed.

Recruited DSH stages wait up to 30 minutes for the session to return to idle. A timeout fails that stage, retains its sanitized event metadata, and does not automatically resume or duplicate the provider turn. A user can inspect the failed task and start a new pass explicitly.

## Test coverage

`tests/kernel-server.test.ts` launches the TypeScript server directly with no Electron window, attaches through the versioned HTTP/SSE client, closes and reconnects the event stream, checks stale protocol/origin rejection, verifies duplicate state ownership is refused, exercises independent profile directories, and confirms explicit shutdown preserves completed outcomes and pauses active work. These are disposable local integration fixtures; they do not prove a live model task or native Electron window lifecycle.
