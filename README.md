# Opnex

Opnex is a local Codex request-routing and delegation app with project-owned working directories and sessions. Requests are classified by GPT-6 Luna at low effort with the Fast tier. Direct answers use a separate read-only Luna turn at high effort; bounded implementation uses Luna at xhigh; hard tasks use the configured Sol/Astra Codex orchestrator, then DeepSeek Harness for recruited execution workers and integration, with Codex reviewing the combined receipt. Optional project knowledge is accessed through the project's `agentmem-project` skill and an externally configured MCP service. Opnex does not own, configure, or require that service. The app-owned policy is in [policy/CODEX_DELEGATION_POLICY.md](policy/CODEX_DELEGATION_POLICY.md). This independent project is not affiliated with OpenAI.

## Requirements

- Node.js 22.12 or newer and npm to run from source or use the portable npm package. The packaged Electron app includes its runtime. Use Node.js 22.22.2 for source checks; it satisfies the locked jsdom test environment's runtime requirements and is the version used in CI.
- For Codex-backed tasks, Codex CLI must be installed and signed in, with `codex app-server --stdio` available. Routing requires GPT-6 Luna low effort and the Fast (`priority`) service tier; direct answers require Luna high effort. The runtime must support the short-lived external-auth bridge, per-thread base/developer instructions, and empty `instructionSources` acknowledgement for new and resumed agent threads; otherwise those roles fail closed. Hard-task recruitment also requires the DeepSeek Harness desktop SDK and a signed-in provider account. The current native desktop SDK launch is verified on Windows; other operating systems require an explicitly configured, verified SDK launch. The signed-in accounts must have access to their selected models. The app window can still launch without either model runtime; unavailable work fails with an actionable provider error rather than silently switching providers.
- A project with an existing working directory. New sessions require a selected project.
- Optional: configure an external project-knowledge MCP service in the Codex host and select the `agentmem-project` skill for relevant work. If the service or matching registration is unavailable, ordinary project sessions continue without it.
- Optional: GitHub CLI (`gh`) for GitHub account and repository features. Local Git workspace data remains available without `gh`.

### macOS first run

In Terminal, check the existing Codex sign-in with codex login status, then run npm ci --include=dev and npm run dev from this checkout. Open http://127.0.0.1:5173, create a project, and choose its working directory. No separate Mac app bundle is required; the app runs locally in your browser and keeps its existing state under ~/Library/Application Support/Pseudoharness so the rebrand does not strand saved settings, sessions, or skills. Use npm run package to build the portable npm tarball instead.

The model and effort selectors use the catalog returned by the Codex executable the app launches. If an expected model is marked unavailable or its effort selector is disabled, check `codex --version` and point the app at a newer runtime with `CODEX_EXECUTABLE=/path/to/codex npm run dev`. This override leaves the CLI on `PATH` unchanged.

### Optional Electron desktop shell

From a fresh clone, install the locked dependencies before the first launch:

```sh
git clone https://github.com/contraliz/Opnex.git
cd Opnex
npm ci --include=dev
npm run desktop
```

Use Node.js 22.12 or newer. `npm ci --include=dev` installs the project-local development tools used by the source build, including TypeScript, Vite, and Electron, even when `NODE_ENV=production` is set. Run it again after pulling a change to `package-lock.json`. Do not install TypeScript globally or omit development dependencies for a source build; if TypeScript or Vite is missing locally, the build stops with this install instruction before clearing existing build output.

The desktop shell starts the local execution kernel inside its existing Electron user-data directory and adds native Browser and local Git workspaces. Its system tray and navigation rail use the supplied Opnex gate mark. Closing the session window leaves Opnex available from the tray; **Open Opnex** restores the existing window or creates a new client for the same kernel, and **Quit** safely shuts down only a kernel started by that shell. An independently attached kernel keeps running when its client quits. Session, Browser, and Git are peer tabs in the shared app workspace; opening Browser or Git keeps the session tab and can split or move among panes. Each session's compact Stop and Heads-up icon controls stay inside that session's content, without a separate action bar or tab-strip controls. Each Browser peer owns a persistent-profile native `WebContentsView` that fills its pane. Remote browser pages have no app preload, Node integration, or browser permissions. Site expiry and sign-in policies still apply; use a site's own “remember me” option if it offers one. Browser data can be cleared from Settings. Run `npm run desktop:package` on macOS or Windows to create a desktop build in `desktop-release/` (zip app on macOS, NSIS installer on Windows); these local builds are unsigned. The Windows installer requests administrator permission when opened and installs for all users; the installed Opnex app itself runs as the signed-in user. Upgrading an earlier per-user installation keeps that user's app data and saved skills. CI targets both operating systems and performs packaged-app/profile smoke tests plus an isolated Windows install/upgrade/uninstall check. `npm run desktop:smoke` runs the source-shell check locally. The regular Vite app, portable npm package, and `npm run start` remain browser-based. See [`docs/kernel-client.md`](docs/kernel-client.md) for starting and attaching clients, reconnect behavior, and explicit kernel shutdown.

Each **Browser** tab owns one persistent, sandboxed Electron page with compact Codex-like chrome, keyboard-accessible common-address suggestions, bare-host HTTPS normalization, and optional user-directed text annotations. Browser cookies and site storage stay in a local Electron profile and are never forwarded to Opnex task state, AgentMem, or model prompts. The **Git** peer is a local interface for branches, worktrees, commit history, and GitHub repository/PR/issue metadata. Its in-page **Sign in with GitHub** flow uses GitHub CLI's web/device authorization; the user completes authorization in GitHub, and the app never asks for or stores a password or token. The CLI credential store is separate from browser cookies. The app does not push branches or modify GitHub items. New Luna workers can use a bounded workspace tool to open these views and inspect a minimal GitHub status summary, but cannot read browser page contents, obtain cookies, or perform GitHub writes. See [`docs/browser-github-and-parallel-workers.md`](docs/browser-github-and-parallel-workers.md) for data locality, annotations, authentication, and limits.

Each session's compact Heads-up panel keeps its status, route, cumulative session tokens, and settings attached to that workspace; its expandable rows hold current sessions and saved/current project details. Each current-session row opens that exact Codex thread through a validated desktop link.

The app uses your installed Codex runtime; it does not ask for or store an API key. Global settings contain model, effort, approval, and application preferences. Create a project and choose its working directory before starting a session. If codex is not on PATH, set CODEX_EXECUTABLE to the CLI executable path before starting. CODEX_HOME can select a non-default Codex configuration directory.

The code uses Node's cross-platform process and path APIs. Electron packaging targets macOS (x64/arm64 ZIP) and Windows (x64 NSIS), and GitHub Actions is configured to build and test both. This implementation pass was run on Windows; macOS execution was not available locally, so confirm the current macOS CI run before treating that platform as verified. Linux is intended but not independently verified. Codex CLI availability, model access, and sign-in are external prerequisites on each machine.

## Request routing

The router receives the current request and bounded conversation context, then returns a route, rule ID, and brief reason. Its Fast capability is checked before classification; the app does not substitute another speed or model. Direct and simple requests do not start the configured hard-task orchestrator. That Codex model and effort apply only after a request is routed to a hard task; recruited execution roles use the separately selected DeepSeek Harness provider, model, and requested native effort. The task details panel records the selected route and executor.

Codex-backed roles run in the versioned, app-owned agent-codex-home-v2, a compatibility overlay rather than the normal session home. At each app launch it refreshes hard links to the normal Codex config and selected profile config, plus a link to the configured plugin directory; it intentionally omits the global Codex-home AGENTS.md and does not copy session histories or link the global auth.json. Authentication uses the app-server short-lived token bridge into app-owned runtime state. Every session runs with its selected project canonical working directory. Codex roles retain repository instruction discovery, externally configured MCP servers, plugins and Codex apps subject to their role policy, task scope, sandbox and approval behavior. The router remains classification-only with MCP, plugins, apps, web search and project instructions disabled. QA remains read-only and receives no external MCP tools. Opnex suppresses automatic skills and user memories, native multi-agent delegation, hooks, and ambient environment/collaboration instructions; it supplies app-owned role instructions and a compaction prompt. Old thread records remain visible, but threads created under an older role configuration cannot resume; send a follow-up to start a fresh pass.

Codex still provides its mandatory system, platform, security, tool instructions and schemas. Codex native tools follow the sandbox, project write roots, approvals, and network policy; exposing a configured tool does not authorize an unrelated side effect. Select the `agentmem-project` skill when project knowledge is relevant. The skill uses only MCP tools already exposed by the Codex host and verifies the current working directory against one exact registered source root. It does not guess an identity, create or rebind a knowledge base, or block normal work if its service is unavailable. Router and QA roles receive no external MCP tools. Recruited DeepSeek Harness workers use their own isolated profile and do not inherit Codex host MCP configuration; they can still read selected skill instructions and continue without unavailable services. Configured Codex filesystem skills are searchable only after a user types `/skill codex:`; explicit selection is resolved by a stable path hash and bounded before use.

**Saved application skills** live in a passive, app-wide SQLite library at `skills.sqlite3` in Opnex app data (schema version 2), shared across projects within the current OS user profile. Its database and supporting files stay in that profile's app-data directory. Opening the app or Skills tab does not read or load skill bodies. Users can create or import a `SKILL.md` package, search, preview, edit, and archive it; imports are copies with bounded safe support files and never run scripts. Type `/` in the composer to open the local skill picker; continue typing to filter by name or description, then select a result to insert a revision-pinned reference such as `/skill library:<id>@<sha256>`. This keeps the chosen revision stable if the library is edited before the pass is sent. Installed filesystem skills remain available through `/skill codex:`. The exact selected revision and source are saved in that pass. Execution roles can explicitly call `skills_list`, `skills_search`, `skills_load`, and `skills_read_file` MCP tools; only explicit `skills_load` reads the full body. During an active task pass, direct, simple, orchestrator, and worker turns can save a new skill or update one with the exact revision returned by `skills_load`; each save records its task, pass, role, action, and revision. This application-library permission is separate from repository filesystem write scope. The router and independent QA auditor do not receive `skills_save`. Existing filesystem `skill_refs` no longer cause automatic loading, and the library namespace `library:<id>` keeps stored skills distinct from installed Codex skills.

## Install the portable package

Build a local tarball with the compiled app and its bundled runtime dependencies:

```sh
npm ci --include=dev
npm run package
```

The output is `artifacts/opnex-1.1.2.tgz`. Copy that file to another machine with Node.js/npm and Codex CLI, then install and start it:

```sh
npm install --global ./opnex-1.1.2.tgz
opnex
```

Open <http://127.0.0.1:4174>. The app binds to loopback only. Stop it with Ctrl+C; remove it with `npm uninstall --global opnex`. If your npm global prefix is not writable, use a user-owned prefix or install from the source checkout below. The `pseudoharness` command remains as an alias for existing scripts. The package contains compiled app files, the owned delegation policy, MIT license, and the three server runtime dependencies. It excludes source history, tests, local settings, sessions, build caches, temporary files, and AgentMem data. It does not include Node.js or Codex CLI.

## Run from source

```sh
npm ci --include=dev
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies API and event-stream requests to the local backend on port 4174. Press Ctrl+C to stop both processes. To run the production server directly from the checkout, use:

```sh
npm run build
npm start
```

Open <http://127.0.0.1:4174>. `npm run package` rebuilds from clean output directories before creating the tarball. `PORT` changes the backend loopback port. `OPNEX_DATA_DIR` selects an alternate absolute path for local state; the former `PSEUDOHARNESS_DATA_DIR` name remains supported.

The existing non-desktop state directories remain `%LOCALAPPDATA%\\Pseudoharness` on Windows, `~/Library/Application Support/Pseudoharness` on macOS, and `$XDG_DATA_HOME/pseudoharness` (default `~/.local/share/pseudoharness`) on Linux. The Electron shell also keeps its existing `Pseudoharness` user-data folder. These legacy folder names preserve saved settings, sessions, skills, and browser data across the rebrand.

The installed `org.pseudoharness.desktop` application ID remains stable so existing installations upgrade in place. The old `pseudoharness` CLI command and `PSEUDOHARNESS_DATA_DIR` setting remain supported; Opnex UI and project documentation use the new names.

## Configure and use

Create a project from the session explorer and choose an existing working directory with Browse. The saved path is canonicalized and checked before use. Select a project in the top selector to determine the working directory for new sessions; the API rejects new-session requests without a project ID. Sessions stay grouped under their project. Older or ambiguous history remains visible under Unclassified and needs an explicit compatible project assignment before a new pass can run. Moving a session never changes the directory recorded in its history.

Project settings own the display name, working directory, and pin. Changing a directory is blocked while a session for that project is active or resumable. A historical thread is not silently reused after its project working directory changes; start a new session for the new identity.

To consult project knowledge in an Opnex session, type `/skill codex:agentmem-project` and select the project skill suggestion. This loads `.agents/skills/agentmem-project/SKILL.md` from the selected project's working directory into the current pass. Configure the external MCP service in the Codex host using that service's instructions; Codex's [MCP setup guide](https://developers.openai.com/codex/mcp/) documents CLI and `config.toml` setup, and `codex mcp list` verifies configured servers. The skill resolves a project only from an exact registered source root that matches the active session directory. If no exact registration or external service is available, proceed with repository files and supplied context. Knowledge-base creation and identity repair require an explicit user request and confirmation; Opnex has no setup controls or API for those operations.

## Workflow and boundaries

- The app validates and stores the complete assignment before starting workers. Each worker receives the full assignment and explicitly selected skills in one execution turn. Independent workers start together; dependent workers wait for completed prerequisites. Empty read scope is valid when no files are needed; it grants no additional access. Non-empty write scope must be absolute and inside the configured project worktree.
- Each new user prompt after a pass ends gets its own assignment and receipt history plus fresh Codex threads and task-owned DSH sessions. Corrections and updates received while a pass is active stay attached to that pass. The next orchestrator turn receives bounded, role-labeled user-visible history, including prior direct answers and accepted orchestrator responses, so follow-ups such as “double that result” retain meaning. Past requests remain context rather than current instructions. Assignments, receipts, worker transcripts, tool output, and internal reasoning are excluded.
- Each session has its own Heads-up panel with status, routing, current Codex and DeepSeek Harness sessions, cumulative available token totals, and session/current project settings. It remains attached to its owning tab; it is not a transcript viewer. A workspace file or knowledge-base statement is not evidence that a document is public; the models are instructed to verify that it is tracked and present in the relevant remote repository before making that claim.
- Each recruited DeepSeek Harness role uses a task-owned SDK session and isolated profile for its execution turn. The selected approval policy, workspace, and write scope are fixed for that turn. Writable Full access is unrestricted at the operating-system level, so assigned paths remain task instructions. Corrections reuse the saved pass context; unrelated sessions use fresh provider sessions.
- Worker outcomes are validated before review. The `type` discriminator selects receipt versus escalation; nullable fields for the other branch are ignored for receipts, while incomplete escalations report the missing decision, evidence, or options without echoing model output.
- Only explicit user input, a structured worker escalation, or the final receipt schedules the orchestrator. Progress and tool events update the UI only. Worker transcripts are not forwarded to the orchestrator.
- Task and thread state is persisted under the operating system's local application-data directory. A restart pauses active work for explicit inspection; the app does not silently replay a turn. Cancellation is persisted before interrupting and ignores late events.
- Codex simple-work turns retain their existing Codex sandbox and approval behavior. DeepSeek Harness phases use the native read-only preset when the assignment has no write scope. Writable DSH phases require explicitly selected Full access, which is unrestricted; assigned paths remain task instructions rather than an OS-level boundary. Cancellation and kernel shutdown terminate owned provider process trees. The installed DSH SDK does not report effective reasoning effort and does not support in-session approval responses, steering, or graceful per-session cancellation.
- The `agentmem-project` skill provides the optional project-knowledge workflow through an external MCP already configured by the host. It reads or writes knowledge only after an exact working-directory registration is verified. Opnex does not own a client, gateway, identity binding, knowledge setup, context prefetch, receipt lease, or completion check. Missing tools never block normal project work; old audit and service-binding records remain available as historical data.
- This is a single-user local app without login. The service checks loopback host/origin, uses an in-memory token for mutations, bounds request sizes, and launches subprocesses without interpolated shell commands. Do not expose its ports to a network.

## Checks and license

Run `npm run lint`, `npm test`, `npm run typecheck`, and `npm run build` from the source checkout. The locked jsdom test environment needs Node.js 22.22.2; CI uses that tested version. `npm run package` produces the portable local tarball; it does not publish it. App-server model access, approval prompts, and sandbox behavior depend on each user's signed-in Codex installation. This project is licensed under MIT; see [LICENSE](LICENSE).

## External project knowledge

Opnex does not install, start, configure, or monitor AgentMem. Configure the external MCP server in the Codex host if you want it available to normal execution roles. Then type `/skill codex:agentmem-project` in a project session and select the project skill suggestion. The workflow allows at most eight AgentMem MCP tool invocations for the entire user request/pass, counting failures, catalog calls, retries, and delegated work. A typical lookup is one exact-root registration check followed by one bounded attach/retrieval; only directly useful follow-ups and at most one authorized update are allowed. Retry at most once for a transient transport failure. Stop on missing service, unknown or conflicting identity, sufficient evidence, or budget exhaustion; do not paginate, poll, index, traverse full history, or restart the budget. This is a skill instruction, not runtime metering: direct external MCP calls can bypass it, so Opnex cannot guarantee an enforced cap. Router and QA roles are isolated from external MCP. DeepSeek Harness execution workers do not inherit Codex host MCP configuration, so their knowledge access depends on tools separately configured in that provider host; missing tools do not block task completion.
