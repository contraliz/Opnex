# Pseudoharness

Pseudoharness is a local desktop-style Codex delegation harness. Its orchestrator follows the app-owned policy copy at [`policy/CODEX_DELEGATION_POLICY.md`](policy/CODEX_DELEGATION_POLICY.md): it can answer trivial prompts directly, or write a complete assignment for a separate `gpt-6-luna` worker at high effort and review the worker's structured receipt. The orchestrator stays idle during worker progress and tool events. This is an independent project and is not affiliated with OpenAI.

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

The composer has actual selectors for the orchestrator model, its catalog-supported reasoning effort, and Codex's approval preset. These choices are saved and applied to new turns. The worker remains pinned to `gpt-6-luna` with `high` effort; it is never silently substituted. A catalog entry does not establish model entitlement, so a delegated task can still be blocked by the signed-in runtime. The selected orchestrator decides whether policy permits a direct answer or requires a complete delegated assignment; the app does not use a prompt-length shortcut.

Each model turn requests Codex's supported detailed summary mode. When the app-server streams `item/reasoning/summaryTextDelta`, Pseudoharness displays it live; it also handles summary-section boundaries and the final readable summary on completed reasoning items. Each stream stays with its pass, role, and turn, and shows the requested model and effort; a supported reroute event can show a separate effective model. While a turn is active, the timeline says when it is waiting for a readable summary. If the turn ends without one, it says no readable summary was provided. Codex does not emit these public summaries on every model/account/runtime turn, so the app cannot guarantee that text will appear. It never displays raw `reasoning.content` or `item/reasoning/textDelta`, forwards summaries between role threads, or schedules another model turn because a summary changed. These are readable summaries supplied by Codex, not private chain of thought. Event contracts are described in [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

Approval presets map to Codex app-server values: **On request** uses `on-request`, **Untrusted commands** uses `untrusted`, and **Never ask** uses `never`. These presets affect approval prompts, while the sandbox continues to constrain writes. The app presents server approval requests with the requested command or permission details and sends an explicit accept, decline, or cancel response. The app does not offer danger-full-access or editable custom policies.

## Workflow and boundaries

- A complete, schema-validated assignment is required before the worker starts. Empty read scope is valid for an answer-only task; it grants no additional access. Non-empty write scope must be absolute and inside the configured workspace.
- Each new user prompt after a pass ends gets its own assignment/receipt history and fresh Codex threads. Corrections and updates received while a pass is active stay attached to that pass. The next orchestrator turn receives bounded, role-labeled user-visible history, including prior direct answers and accepted orchestrator responses, so follow-ups such as “double that result” retain meaning. Past requests remain context rather than current instructions. Assignments, receipts, worker transcripts, tool output, and internal reasoning are excluded.
- The worker runs in a separate thread. One directly related consolidated correction reuses that worker thread; unrelated tasks get fresh threads.
- Only explicit user input, a structured worker escalation, or the final receipt schedules the orchestrator. Progress and tool events update the UI only. Worker transcripts are not forwarded to the orchestrator.
- Task and thread state is persisted under the operating system's local application-data directory. A restart pauses active work for explicit inspection; the app does not silently replay a turn. Cancellation is persisted before interrupting and ignores late events.
- Worker turns with no write scope use Codex `readOnly`; authorized write turns use `workspaceWrite` with validated roots and network access disabled. Read scope remains assignment guidance; it is not an OS-level read boundary. The active Codex sandbox/profile enforces the actual host permission boundary.
- AgentMem is accessed through the configured MCP stdio service after verifying project ID and root. The app retrieves scoped context before assignment and records work receipts separately from runtime thread state. Before completion, it follows AgentMem task-context continuation offsets until all mandatory current requirements and task acceptance criteria are included. An accepted app receipt asks AgentMem to complete its work task with evidence-backed checks and releases the lease only when accepted. Incomplete work stays open and releases ownership; blocked work is marked blocked then released; cancellation releases ownership. Save failures remain visible, with an explicit retry for an accepted pass whose released AgentMem record remains open.
- This is a single-user local app without login. The service checks loopback host/origin, uses an in-memory token for mutations, bounds request sizes, and launches subprocesses without interpolated shell commands. Do not expose its ports to a network.

## Checks

```powershell
npm run typecheck
npm test
npm run build
```

See [architecture and limitations](docs/architecture.md), [design system](docs/design-system.md), and [future work](ROADMAP.md).

## Verification

The current local build passes 48 deterministic tests across eight files, `npm run typecheck`, and `npm run build`. A live desktop session verified four prompts in one app task: direct arithmetic, direct orchestrator identity with “do not delegate”, explicit Luna delegation, and another direct arithmetic pass. All results stayed attached to their passes after reload. A second live sequence answered “What is 1+1?” with 2 and used that visible history to answer “Double that result.” with 4, without starting a worker. AgentMem completion pagination was verified against the live service with a scoped smoke task; six accepted app-owned records were retried through the app and verified done with no owners or active leases. App-server model entitlement, approval prompts, and sandbox behavior depend on the signed-in Codex installation. See [architecture and limitations](docs/architecture.md) for pass isolation and context handling.
