# Pseudoharness

Pseudoharness is a local desktop-style Codex delegation app. Its orchestrator follows the app-owned policy in [`policy/CODEX_DELEGATION_POLICY.md`](policy/CODEX_DELEGATION_POLICY.md): it may answer directly or assign a separate `gpt-6-luna` worker at high effort, then review the worker's structured receipt. Progress and reasoning update the UI but do not wake another model. This independent project is not affiliated with OpenAI.

## Requirements

- Node.js 22.12 or newer and npm.
- Codex CLI installed, signed in, and able to run `codex app-server --stdio`. The signed-in account must have access to the models you select.
- A workspace directory to choose in Settings.
- Optional: AgentMem available as an MCP stdio server in the same Codex environment, with a project registered to the selected workspace root.

The app uses your installed Codex runtime; it does not ask for or store an API key. First-run settings have an empty workspace and AgentMem project, so no author-specific path or knowledge-base identity is required. If `codex` is not on `PATH`, set `CODEX_EXECUTABLE` to the CLI executable path before starting. `CODEX_HOME` can select a non-default Codex configuration directory.

The code uses Node's cross-platform process and path APIs. Windows 11 was used for release verification; macOS and Linux are intended but were not independently verified for this package. Codex CLI availability and sign-in are external prerequisites on each machine.

## Install the portable package

Build a local tarball with the compiled app and its bundled runtime dependencies:

```sh
npm ci
npm run package
```

The output is `artifacts/pseudoharness-1.0.0.tgz`. Copy that file to another machine with Node.js/npm and Codex CLI, then install and start it:

```sh
npm install --global ./pseudoharness-1.0.0.tgz
pseudoharness
```

Open <http://127.0.0.1:4174>. The app binds to loopback only. Stop it with Ctrl+C; remove it with `npm uninstall --global pseudoharness`. If your npm global prefix is not writable, use a user-owned prefix or install from the source checkout below. The package contains compiled app files, the owned delegation policy, MIT license, and the three server runtime dependencies. It excludes source history, tests, local settings, sessions, build caches, temporary files, and AgentMem data. It does not include Node.js or Codex CLI.

## Run from source

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies API and event-stream requests to the local backend on port 4174. Press Ctrl+C to stop both processes. To run the production server directly from the checkout, use:

```sh
npm run build
npm start
```

Open <http://127.0.0.1:4174>. `npm run package` rebuilds from clean output directories before creating the tarball. `PORT` changes the backend loopback port. `PSEUDOHARNESS_DATA_DIR` selects an alternate absolute path for local state.

By default, settings and task history stay in the OS user-data directory: `%LOCALAPPDATA%\\Pseudoharness` on Windows, `~/Library/Application Support/Pseudoharness` on macOS, or `$XDG_DATA_HOME/pseudoharness` (default `~/.local/share/pseudoharness`) on Linux. These paths are outside the install/package directory.

## Configure and use

On first launch, Settings asks for the exact workspace root. Select **Browse** beside the read-only path field to open the folder chooser. Expand folders in place to inspect subdirectories, select a folder row, then choose **Use this folder**; the tree loads children only when expanded, and larger lists reveal more rows in batches. Choose **New folder** to create a single folder inside the selected location; the chooser selects it, but you still need to choose **Use this folder** and save Settings to apply it. Cancelling after creation leaves that new folder on disk. You can also enter a path in the chooser and choose **Go**. Selection only fills the unsaved setting until you save. The browser shows the current OS user's accessible folders and drives (on Windows) and does not bypass filesystem permissions. Settings lists actual registered AgentMem knowledge bases whose memory directories are under the configured `projects` directory. Choosing one pairs it with its registered workspace root; **Disabled** keeps the current workspace and skips AgentMem for new tasks. Save applies the pair, while Cancel discards it. The app does not register, adopt, or rebind directories. If the AgentMem service is unavailable, the picker explains the error and offers a retry. Existing tasks retain their original workspace and AgentMem project.

The composer has actual selectors for the orchestrator model, its catalog-supported reasoning effort, and Codex's approval preset. These choices are saved and applied to new turns. The worker remains pinned to `gpt-6-luna` with `high` effort; it is never silently substituted. A catalog entry does not establish model entitlement, so a delegated task can still be blocked by the signed-in runtime. The selected orchestrator decides whether policy permits a direct answer or requires a complete delegated assignment; the app does not use a prompt-length shortcut.

Each expanded **Run receipt** contains a collapsed **Current workspace changes** disclosure. Open it to view read-only file cards with actual added/deleted line counts and per-file **View changes** disclosures; the adjacent Refresh button does not toggle the section. Small untracked text files are included. Git data is fetched only when the section first opens (or Refresh is pressed); it compares the task's current workspace with `HEAD`, not a pass-start snapshot, and never stages or reverts files. The worker-reported change list remains separate from this live Git view. Repositories outside the selected workspace and files outside that repository are not shown.

Orchestrator reasoning summaries appear inline as supported deltas arrive. Luna conversation and reasoning are grouped in a collapsed-by-default activity panel; the reviewed final output remains visible, and a separate collapsed receipt shows repository and knowledge-base changes, acceptance, checks, and risks. The app requests the most detailed readable reasoning summary supported by the Codex runtime and asks it to expose raw reasoning when available. These provider-exposed fields may be absent and are not access to hidden reasoning. Both channels are scoped to role and turn, displayed only in the UI, and never forwarded into another model's prompt. See the [Codex app-server documentation](https://developers.openai.com/codex/app-server/) and [configuration reference](https://developers.openai.com/codex/config-reference/).

At the end of each pass, the usage footer shows total tokens, Codex's estimated cost (credits or USD when the provider supplies it), and approximate changes in the account's 5-hour and weekly Codex allowance snapshots. Hover or keyboard-focus each value to see orchestrator and Luna worker contributions. Token totals come from cumulative per-thread snapshots; cached input and reasoning output remain subsets of their respective totals. The `account/usage/read` thread query supplies Codex-estimated credits and sometimes USD, not a final bill; its model, effort, speed, and estimate source are saved on that pass. Allowance percentages are differences between account-wide `account/rateLimits/read` snapshots around each role turn, with sample times and window reset boundaries saved per pass. Concurrent Codex clients or delayed/coarse snapshots can affect them; unavailable or reset-crossing windows stay unavailable. These pass snapshots are not recalculated when settings or later account state change. Missing token or credit data stays marked unavailable; older saved passes do not gain fabricated zero counts. Usage events update local state without scheduling another model turn.

Assistant responses, receipts, and readable summary text use safe Markdown rendering with GitHub-flavored tables and lists. The composer is a single Markdown source editor: inline formatting renders as the caret moves away and the original markers reappear when editing that segment. It sends the exact source text; there is no separate preview mode. Raw HTML is not enabled, and unsafe link protocols are not activated.

Approval presets map to Codex app-server values: **On request** uses `on-request`, **Untrusted commands** uses `untrusted`, and **Never ask** uses `never`; these keep the existing role-specific sandbox behavior. **Full access (auto approve)** uses `approvalPolicy: never` and `danger-full-access` for the thread and every turn, including reviews and resumed work. The selected policy is saved on each pass, so changing Settings affects new passes without changing historical ones. Full access removes Codex filesystem sandbox restrictions and approval prompts; assignment scope remains guidance, not an OS boundary. Use this mode only when you want both orchestrator and worker turns to run without those restrictions. The app presents server approval requests with the requested command or permission details and sends an explicit accept, decline, or cancel response for modes that request approval.

## Workflow and boundaries

- A complete, schema-validated assignment is required before the worker starts. Empty read scope is valid for an answer-only task; it grants no additional access. Non-empty write scope must be absolute and inside the configured workspace.
- Each new user prompt after a pass ends gets its own assignment/receipt history and fresh Codex threads. Corrections and updates received while a pass is active stay attached to that pass. The next orchestrator turn receives bounded, role-labeled user-visible history, including prior direct answers and accepted orchestrator responses, so follow-ups such as “double that result” retain meaning. Past requests remain context rather than current instructions. Assignments, receipts, worker transcripts, tool output, and internal reasoning are excluded.
- The task inspector keeps the current pass's orchestrator and worker thread IDs visible and links each local session to Codex desktop. A workspace file or knowledge-base statement is not evidence that a document is public; the models are instructed to verify that it is tracked and present in the relevant remote repository before making that claim.
- The worker runs in a separate thread. One directly related consolidated correction reuses that worker thread; unrelated tasks get fresh threads.
- Worker outcomes are validated before review. The `type` discriminator selects receipt versus escalation; nullable fields for the other branch are ignored for receipts, while incomplete escalations report the missing decision, evidence, or options without echoing model output.
- Only explicit user input, a structured worker escalation, or the final receipt schedules the orchestrator. Progress and tool events update the UI only. Worker transcripts are not forwarded to the orchestrator.
- Task and thread state is persisted under the operating system's local application-data directory. A restart pauses active work for explicit inspection; the app does not silently replay a turn. Cancellation is persisted before interrupting and ignores late events.
- Worker turns with no write scope use Codex `readOnly`; authorized write turns use `workspaceWrite` with validated roots and network access disabled. Read scope remains assignment guidance; it is not an OS-level read boundary. The active Codex sandbox/profile enforces the actual host permission boundary.
- AgentMem is accessed through the configured MCP stdio service after verifying project ID and root. The app retrieves scoped context before assignment and records work receipts separately from runtime thread state. Before completion, it follows AgentMem task-context continuation offsets until all mandatory current requirements and task acceptance criteria are included. An accepted app receipt asks AgentMem to complete its work task with evidence-backed checks and releases the lease only when accepted. Incomplete work stays open and releases ownership; blocked work is marked blocked then released; cancellation releases ownership. A disconnected stdio transport is invalidated and recreated on the next request. Reads and idempotent receipt/release calls retry once; receipt writes reuse the task-scoped idempotency key and exact payload, receipt failures stay visible; when lease release cannot be confirmed, the app retains that lease and offers retry using it.
- This is a single-user local app without login. The service checks loopback host/origin, uses an in-memory token for mutations, bounds request sizes, and launches subprocesses without interpolated shell commands. Do not expose its ports to a network.

## Checks and license

Run `npm run lint`, `npm test`, `npm run typecheck`, and `npm run build` from the source checkout. `npm run package` produces the portable local tarball; it does not publish it. App-server model access, approval prompts, and sandbox behavior depend on each user's signed-in Codex installation. This project is licensed under MIT; see [LICENSE](LICENSE).
