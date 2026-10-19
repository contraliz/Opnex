# Pseudoharness

Pseudoharness is a local desktop-style Codex delegation harness. A Sol or Astra orchestrator writes and validates a complete assignment, a separate `gpt-6-luna` worker runs it with high reasoning effort, and the orchestrator reviews the worker's structured receipt. The orchestrator stays idle during worker progress and tool events. This is an independent project and is not affiliated with OpenAI.

## Requirements

- Windows, Node.js 22.12 or newer, and npm.
- Codex CLI installed and signed in, with `codex app-server` available.
- AgentMem configured as an MCP stdio server in the same Codex environment.
- A workspace root and AgentMem project that are already registered to the same directory.

Pseudoharness uses the local signed-in Codex runtime. It does not ask for or store an API key. Its first-run defaults contain no project path or AgentMem identity; configure both explicitly in Settings.

## Start

```powershell
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. The Vite development server proxies API calls to the loopback backend on port 4174. Press Ctrl+C in the terminal to stop both processes.

For a production build:

```powershell
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:4174> and stop with Ctrl+C. Both servers bind to loopback only.

## Configure and use

On first launch, Settings asks for the exact workspace root and its already-registered AgentMem project ID. The app checks that both identify the same project before showing AgentMem as connected. It does not register or adopt arbitrary directories.

The composer has actual selectors for the orchestrator model, its catalog-supported reasoning effort, and Codex's approval preset. These choices are saved and applied to new turns. The worker remains pinned to `gpt-6-luna` with `high` effort; it is never silently substituted. A catalog entry does not establish model entitlement, so a real task can still be blocked by the signed-in runtime.

Approval presets map to Codex app-server values: **On request** uses `on-request`, **Untrusted commands** uses `untrusted`, and **Never ask** uses `never`. These presets affect approval prompts, while the sandbox continues to constrain writes. The app presents server approval requests with the requested command or permission details and sends an explicit accept, decline, or cancel response. The app does not offer danger-full-access or editable custom policies.

## Workflow and boundaries

- A complete, schema-validated assignment is required before the worker starts. Empty read scope is valid for an answer-only task; it grants no additional access. Non-empty write scope must be absolute and inside the configured workspace.
- The worker runs in a separate thread. One directly related consolidated correction reuses that worker thread; unrelated tasks get fresh threads.
- Only explicit user input, a structured worker escalation, or the final receipt schedules the orchestrator. Progress and tool events update the UI only. Worker transcripts are not forwarded to the orchestrator.
- Task and thread state is persisted under the operating system's local application-data directory. A restart pauses active work for explicit inspection; the app does not silently replay a turn. Cancellation is persisted before interrupting and ignores late events.
- Worker turns with no write scope use Codex `readOnly`; authorized write turns use `workspaceWrite` with validated roots and network access disabled. Read scope remains assignment guidance; it is not an OS-level read boundary. The active Codex sandbox/profile enforces the actual host permission boundary.
- AgentMem is accessed through the configured MCP stdio service after verifying project ID and root. The app retrieves scoped context before assignment and records work receipts separately from runtime thread state. An accepted app receipt asks AgentMem to complete its work task with evidence-backed checks and releases the lease only when accepted. Incomplete work stays open and releases ownership; blocked work is marked blocked then released; cancellation releases ownership. Save failures remain visible.
- This is a single-user local app without login. The service checks loopback host/origin, uses an in-memory token for mutations, bounds request sizes, and launches subprocesses without interpolated shell commands. Do not expose its ports to a network.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

See [architecture and limitations](docs/architecture.md), [design system](docs/design-system.md), and [future work](ROADMAP.md).

## Verification

The latest release candidate passes 29 deterministic tests across five files, `npm run typecheck`, and `npm run build`. A live desktop task for “hi, make luna return its name” completed through a validated assignment, Luna receipt, orchestrator acceptance, and an AgentMem task marked done with no owner or active lease. The live flow confirmed an empty read scope and empty write scope without inventing file access. Real model, effort, and approval selectors were changed and restored; protocol tests verify their values reach app-server parameters and approval decisions answer the original server request. The main conversation scrolled independently while the composer stayed at the bottom; desktop sizing was also checked in a 1280 × 800 window during earlier QA. A real permission request was not induced during this smoke. Escalation, in-flight updates, cancellation races, AgentMem outage handling, and project writes remain fixture-tested or unverified live. The app-server protocol is experimental; local model entitlement and sandbox behavior depend on the signed-in Codex installation.
