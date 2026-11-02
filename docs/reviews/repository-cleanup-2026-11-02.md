# Repository update and review

## What this change does

This review and cleanup updates the existing Opnex rename work, makes first-party code consistently readable, removes proven dead UI code, and fixes concrete correctness and test gaps found in the full review. The final source review completed on 2026-11-03.

## Scope and method

The review started from pre-fetch HEAD `e4b01c17e5177c93caa019f5cd3d86c9888761b2`. It covered all 242 current first-party application source, runtime configuration, tests, and Markdown paths (105,420 indexed lines), plus the deleted 51-line `src/ui/WorkspaceGitDiff.tsx` baseline. The ledger separates 217 source/config/test files (104,024 lines) from 25 Markdown files (1,396 lines). It excludes three vendored Humanizer files, generated output, dependencies, binaries/build artifacts, `package-lock.json`, and four skill-agent metadata YAML files; these are not application source. Independent Standards and Spec reviewers read their assigned paths through EOF and checked linked callers/tests. The full inventory is in `source-review-coverage-2026-11-02.csv`.

The review assumes a local-user desktop and standalone app. External AgentMem stays optional. DSH keeps its native handoff. Forge remains separate and is not treated as production-accepted or security-isolated by its worktrees. Existing user data, storage behavior, compatibility identifiers, and legacy reads remain intact.

## Remote update and preservation

The starting tree and index were clean. A broad fetch hit unrelated missing objects in the shared Git object store; a targeted fetch of the active upstream branch succeeded. The branch was up to date at the pinned baseline, and fast-forward pull found no remote commits to integrate. The cleanup branch is `codex/repository-cleanup-review`, based on the already-pushed cleanup commit `5a85bc3806be7971f23d459465b0a3040b983cbe`. No pre-existing edits were overwritten. No profile, installed app, live process, or user data directory was modified.

## Changes

- Formatted first-party code with a consistent 100-column Prettier layout. The project had no formatter configuration; the formatting check used temporary `npx` tooling and added no dependency.
- Split the conversation view, session explorer, conversation history, pass details, and approval cards from `App.tsx` into cohesive components. Removed unused `WorkspaceGitDiff.tsx` after confirming no callers; the existing project Git API and current Git views remain.
- Corrected view state, focus, keyboard navigation, browser annotation, clipboard error handling, Git path identity, and session scrolling. Grouped conversation messages and history indexes in single passes instead of repeatedly filtering them.
- Made initial-commit previews verify both worktree blobs and index entries after staging. Added a regression for a concurrent index change that restores the reviewed worktree contents.
- Centralized smoke-test child-process cleanup and test it with a spawned descendant. The desktop smoke now launches the Electron binary directly, and Windows timeout cleanup targets the process tree before it can orphan the app.
- Allowed valid empty Codex MCP/plugin maps so optional tools do not prevent agent thread startup; malformed config shapes still fail closed.
- Corrected documentation that claimed raw reasoning text is stored and displayed. The current implementation intentionally accepts readable summaries and rejects raw text events; no raw reasoning capture, persistence, or display was added.
- Removed the duplicate coordinator branch and unused return values, corrected the Electron Linux state path documentation, and made the responsive CSS test insensitive to whitespace formatting.

`App.tsx` is 2,292 formatted lines; it was 1,218 lines before readable formatting. The extracted components remove mixed view responsibilities. The remaining file coordinates pane/session state and app-level actions; splitting it further by line count would add prop plumbing without a clear separation of ownership.

## Standards report

**Coverage:** 217 current source, config, and test paths; 104,024 lines read through EOF. The deleted component's baseline was reviewed separately. The reviewer applied the repo code-review and ponytail guidance, including Fowler's smell list, and checked linked callers and tests. A static minified-output comparison differed in 40 files; that comparison cannot prove equivalence, so correctness evidence comes from full source review and the checks below.

**Resolved findings:** A Forge correction replay accepted changed saved assignment data; replay now compares normalized findings and the complete assignment snapshot. The Forge `verification[].evidence` schema now allows its required nullable value. A hard-coded drive path in a test was replaced with an OS temp fixture. A stale routing-test count was corrected. Smoke cleanup now terminates descendants. Initial-commit staging now rejects concurrent index substitution. A missing Forge operation-marker regression test was added.

**Remaining finding — P3:** `server/workspace-initial-commit.ts:443-470` checks for an unborn branch, validates the staged snapshot, and then calls `git commit`. Another Git process can create the root commit after the check and before that command. Opnex can then create an unintended child commit (an empty child if the preview was empty). Existing staging/index race tests do not cover this ref race. Eliminating it atomically would require changing Git commit/ref plumbing and may change hook or signing behavior, so this cleanup leaves it documented.

## Spec report

**Coverage:** 242 current first-party paths and 105,420 lines read through EOF, plus the deleted 51-line baseline. The Spec reviewer checked the user task, current task requirements and decisions, README, architecture/design docs, desktop/IPC, app-server/DSH, worktree, migration, UI, tests, packaging, and current naming compatibility.

**Resolved findings:** The package tarball example now matches the emitted artifact. Versioned `/api/v1` responses include both compatibility headers, including `/info`. Valid MCP/plugin-free Codex configuration now starts a worker thread, and malformed maps remain rejected. The design and architecture prose now describe summary-only reasoning correctly.

**Deferred pre-existing finding — P2, REQ-0064:** Windows Electron stores backend state under `%APPDATA%\\Opnex\\local-state`; the requirement asks for `%LOCALAPPDATA%\\Opnex`. This cleanup preserves current storage and user data. A future change should align the path while preserving existing data and refusing to overwrite conflicts; it needs its own migration/active-owner plan. No storage relocation or migration was attempted.

**REQ-0014/0015 interpretation:** The only retained paraphrase is “preserve live exposed reasoning and summaries.” Current code stores readable summaries/commentary/tool lifecycle and intentionally ignores raw `item/reasoning/textDelta`; tests assert that behavior. The exact requirement text could not be retrieved because AgentMem's shared service quota was exhausted. The docs now match the code, but this review cannot claim the ambiguous requirement is met or violated. No raw reasoning data was added.

## Ponytail review

### Must

None.

### Should

- **P2 — REQ-0064 storage path.**
  - **What:** Windows Electron state uses Roaming AppData while REQ-0064 specifies Local AppData.
  - **Problem:** Existing installations and the requirement point to different locations.
  - **Smallest fix:** Plan a separate data-preserving path migration with conflict refusal and active-owner checks.
  - **If skipped:** Windows Electron state remains at its current Roaming path.

- **P3 — initial-commit ref race.**
  - **What:** A concurrent Git client can create the root commit between the unborn check and Opnex's `git commit`.
  - **Problem:** The action can create an unintended child commit after the preview was approved.
  - **Smallest fix:** Use an atomic expected-unborn ref update while preserving intended Git hook/signing behavior.
  - **If skipped:** A narrow concurrent race can leave extra local history; no data loss is expected.

- **Unranked — REQ-0014/0015 wording.**
  - **What:** The saved paraphrase may refer to raw reasoning events, while the code intentionally supports summaries only.
  - **Problem:** Exact requirement wording was unavailable, so compliance is unresolved.
  - **Smallest fix:** Retrieve the exact records when AgentMem quota permits and confirm the intended summary-only behavior.
  - **If skipped:** The ambiguity remains; the app continues rejecting raw reasoning text.

### Nice

None.

## Naming and compatibility

A case-insensitive scan outside this report found 125 `Pseudoharness` occurrences in 48 files, including one occurrence in excluded dependency lock metadata. Remaining values are compatibility inputs or historical evidence: the npm command and `PSEUDOHARNESS_*` environment aliases; the Electron app ID, browser partition, and owner-lock name; version-1 protocol identity and old headers; legacy bridge/session keys; packaged helper and recruitment manifest readers; supported data migration markers/paths; installer upgrade fixtures; release notes; and historical merge-audit text. Current code emits Opnex names where compatibility permits. No tracked current filename remains under the old name; the unused old CLI shim and `WorkspaceGitDiff.tsx` were removed. No third-party content or provenance was rewritten.

## Verification

- `npm run lint` — passed.
- `npm run typecheck` — passed for client and server projects.
- `npm test -- --testTimeout=30000` — 81 files passed; 790 tests passed, 4 skipped.
- `npm run build` — passed; Vite transformed 2,331 modules.
- `npx prettier ... --check` for changed JS/TS/JSX/CSS/config paths — passed.
- `git diff --check` — passed; Git emitted only expected LF-to-CRLF warnings.
- `node scripts/desktop-smoke.mjs` — passed isolated startup, tray lifecycle, browser-profile persistence, and attached-kernel quit checks.
- `node scripts/electron-annotation-smoke.mjs --annotation-only` — passed on the Opnex bridge at native 1442×962; annotation capture, overlay, unsent-composer routing, local-state privacy, and native BrowserView geometry passed.
- `node scripts/electron-annotation-smoke.mjs` — full interaction run passed earlier in this task, including native resizing, toolbar, token-usage layout, Git filtering/history, and settings fit.
- `npm pack --dry-run --json` — passed for `opnex@1.1.3`; emitted `opnex-1.1.3.tgz`, included `bin/opnex.js`, and excluded `bin/pseudoharness.js`.

No signed installer, cross-platform interactive run, deployment, release, PR, or merge was performed.

## AgentMem and skills

Project: `opnex`; canonical root `D:\\programming\\opnex`; KB `D:\\projects\\Opnex`; task `6a4e52254347`. The earlier task pass read onboarding/materials, decisions DEC-0010/0012/0013 and applicable task-linked requirements. It saved receipt `a43850dae9c6488faf4fa863d6808106`, but AgentMem returned `completion_accepted: false`, `status: in_progress`, five saved criteria missing from submitted recognition, `revision_matches: true`, and no note. The lease was released; no requirements were marked fulfilled and no curated pages were written. On this pass, both review agents and the worker made no fresh AgentMem calls because the shared service quota was exhausted; no knowledge changes were made.

The worker and both read-only reviewers applied `agentmem`, `agentmem-project`, `code-review`, `ponytail-review`, and `ponytail` guidance. Reviewers kept Standards and Spec reports separate. The worker also used the repo's release guidance for package/runtime checks.
