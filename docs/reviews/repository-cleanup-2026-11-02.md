# Repository update and review

Reviewed on 2026-11-02 from branch `codex/repository-cleanup-review`.

## Scope and method

The review started from `e4b01c17e5177c93caa019f5cd3d86c9888761b2`. The tracked inventory contains 264 files: 250 first-party files and 14 vendored Humanizer skill files, which were excluded from edits. Independent Standards and Spec reviews inventoried the first-party repository and inspected the current patch, linked callers, tests, packaging, migration, HTTP, Codex/DSH, worktree, UI, and documentation paths. They did not read every unchanged line, so this review does not claim exhaustive proof that no other issue exists.

The working assumption is a local-user desktop and standalone application. AgentMem remains external and optional, native DSH handoff remains native, and Forge remains a separate feature. Worktrees are not treated as a security boundary.

## Remote update and working tree

The starting worktree and index were clean on `ui-typography-and-models`. A broad fetch failed because the shared Git object store has unrelated missing objects and broken links. A targeted fetch of `origin/ui-typography-and-models` succeeded; its head matched the pinned baseline, and `git pull --ff-only origin ui-typography-and-models` reported that the branch was up to date. There was no upstream delta to integrate.

The cleanup is on `codex/repository-cleanup-review`, with no commit, push, merge, release, deployment, or installed/live profile changes. No pre-existing user edits were present or needed preservation.

## Changes

- Made Opnex names primary for CLI, desktop IPC, MCP server/tool namespace, DSH session IDs, generated config names, and current test fixtures. Removed the old CLI shim; the package alias now points directly to `bin/opnex.js`.
- Kept current and legacy kernel protocol headers interoperable. All versioned API responses now include both headers, including `/api/v1/info`.
- Reworked the preload bridge and annotation script into readable functions and removed duplicate legacy annotation state handling.
- Removed the unused workspace MCP gateway, config, authorization module, and tests after confirming there were no production callers. DSH continues using the native handoff.
- Made recruitment cleanup inspect the task root before deleting worktrees. Unexpected files now cause cleanup to preserve the task data. New work uses an Opnex manifest name, while cleanup still reads the old manifest for existing tasks.
- Removed a duplicate package dependency property, clarified the manifest resolver, and corrected the README tarball example to the current `opnex-1.1.3.tgz`.
- Review found a desktop startup regression in the working patch: a literal newline escape had commented out the persistent browser partition declaration. It is now a real separate declaration. The isolated desktop smoke passes with the fix.
- Corrected the Electron annotation smoke setup: native layout checks now focus the isolated test window and support an annotation-only run without CDP viewport emulation. The full smoke also checks the current expandable token-usage summary rather than stale tooltip selectors removed from the UI.

## Standards report

**Coverage:** The independent reviewer checked the final 61-file code diff at review time, affected callers, package scripts, lint configuration, CI, README, and architecture documentation. The later README and protocol-header changes were separately reviewed in the Spec pass.

**Findings:** Two issues were found and resolved. The commented-out partition declaration was fixed and exercised by desktop startup smoke. The unreferenced workspace MCP authorization module and its only test were deleted. No Standards findings remain open.

**Worst remaining issue:** None identified. The review did not inspect every unchanged line individually.

**Focused correction review:** No findings. The reviewer checked only the new test-only focus IPC, preload exposure, native viewport checks, and their current callers. The focus handler is registered only in interaction-test mode and retains the app-window sender check.

## Spec report

**Coverage:** The independent reviewer used the task acceptance criteria, all 46 applicable task-linked AgentMem requirements, the current project decisions, and additional checks of REQ-0063 and REQ-0064. The user request and current architecture notes served as the specification where no dedicated requirement existed.

**Findings:**

- The README named a tarball the current package build does not produce. Updated the example to `opnex-1.1.3.tgz`; the packaging script and package version agree.
- The protocol documentation said versioned responses include both header names, but `/api/v1/info` did not. The version middleware now emits both for versioned routes, and the kernel test verifies both headers on `/info`.
- **P2, unresolved pre-existing requirement mismatch — REQ-0064.** Windows Electron currently stores backend state under `%APPDATA%\Opnex\local-state`; REQ-0064 requires `%LOCALAPPDATA%\Opnex`. Standalone state and the browser profile already use Local AppData. Windows still skips automatic probing, reading, or migrating of legacy Pseudoharness roots. This mismatch is about the current Opnex Roaming location, not a legacy-root read.

For this pass the storage path remains unchanged to preserve existing behavior and user data. Moving it safely requires a separate plan for existing Roaming data, destination conflicts, and any active kernel owner. A future change should align the Electron backend with Local AppData while preserving the old source and refusing to merge or overwrite conflicting data. REQ-0063’s read-only recruitment path had no issue in the reviewed code.

**Worst remaining issue:** The REQ-0064 Windows data-location mismatch. No storage migration or live profile was changed in this review.

## Ponytail review

No remaining readability or overengineering issue was identified in the reviewed patch. The one deferred item is the P2 storage-location mismatch above, which needs a data-migration decision rather than a rename-only edit.

## Naming scan and compatibility exceptions

A final case-insensitive scan of tracked text found 125 occurrences across 48 files. The occurrences are limited to deliberate compatibility behavior, historical release/migration records, installer-upgrade checks, and tests for those boundaries. No current on-disk path contains the old name; the tracked `bin/pseudoharness.js` path is deleted in this patch.

The remaining names are retained for these reasons:

- The `pseudoharness` npm command remains an alias to the Opnex launcher; legacy `PSEUDOHARNESS_*` environment variables remain accepted as inputs. New child-process configuration uses `OPNEX_*`.
- `org.pseudoharness.desktop`, the Electron partition `persist:pseudoharness-browser-v1`, and `.pseudoharness-owner.sqlite` retain installation, browser-session, and kernel-lock continuity.
- Version 1 keeps the public protocol identity `pseudoharness.kernel`. The kernel accepts and emits old HTTP header names for existing clients; current clients also send the new Opnex names.
- The old `window.pseudoharnessDesktop` bridge, MCP namespace/server-name inputs, packaged helper directory, GitHub auth session marker, and recruitment ownership manifest remain readable for compatibility. Current code emits or writes the Opnex names.
- macOS and Linux retain their supported one-time migration from old data directories. Windows does not automatically probe, read, or migrate old Pseudoharness roots. An explicitly supplied legacy data-directory environment variable remains an explicit user override.
- Release notes, the merge audit, `.gitignore`, and the Windows installer-upgrade smoke retain old names as historical or upgrade-test inputs. Compatibility assertions in tests intentionally retain the corresponding values.

## Verification

- `npm run lint` — passed.
- `npm run typecheck` — passed.
- `npm run build` — passed; Vite transformed 2,325 modules.
- `npm test -- --testTimeout=30000` — 78 files passed; 765 tests passed and 4 were skipped. The default five-second timeout had earlier interrupted three Git fixture tests under parallel load; those fixtures passed in focused and final reruns.
- Focused Git/worktree rerun — 3 files, 17 tests passed.
- Focused compatibility/regression rerun — 7 files, 103 tests passed.
- `node scripts/desktop-smoke.mjs` — passed isolated startup, tray lifecycle, browser-profile persistence, and attached-kernel quit checks.
- `npm pack --dry-run --json` — passed; package is `opnex@1.1.3`, filename `opnex-1.1.3.tgz`, includes `bin/opnex.js`, and excludes the deleted legacy shim.
- `node --check` — passed for the desktop entry/preload/annotation files and desktop smoke scripts.
- `git diff --check` — no whitespace errors. Git reported expected LF-to-CRLF normalization warnings for several files.
- `node scripts/electron-annotation-smoke.mjs --annotation-only` — passed in an isolated Electron profile at native viewport `1442 × 962`. The Opnex bridge and compatibility alias were checked; native BrowserView bounds followed sidebar collapse/reopen and settled within 1 ms, with a maximum sampled animation offset of `1 px`. Annotation capture, overlay geometry, routing into the unsent task composer, and local-state privacy checks passed.
- `node scripts/electron-annotation-smoke.mjs` — passed in an isolated Electron profile. It exercised browser toolbar checks, native BrowserView/sidebar motion, annotation routing, token-usage summary layout in a narrow split, Git pagination/filter/history, resize behavior, reduced motion, and settings fit. Final native BrowserView checks ran at `902 × 622`; sidebar collapse/reopen sampled offsets stayed below `1 px`. The smoke emits screenshots under a temporary evidence directory and cleans up its app profile and fixture.
- The first full-mode rerun reached a stale `.pass-usage-datum` selector that no longer exists in the current UI. The smoke now opens and checks the current `.usage` summary and per-role rows; the subsequent full run passed.

No signed installer build, publication, cross-platform interactive run, or live-profile migration was performed.

## AgentMem

The attached project was `opnex` at `D:\programming\opnex`, with KB `D:\projects\Opnex`. The task was `6a4e52254347`. The accountable worker read fresh-agent onboarding, materials, architecture, DEC-0010/0012/0013, all 46 applicable task requirements, and the relevant REQ-0048/0049/0059/0063/0064 boundaries. Both review agents independently attached and retrieved the applicable requirements. The worker and both reviewers applied AgentMem, code-review, ponytail-review, and ponytail guidance; the worker also consulted agentmem-project and opnex-release. No curated knowledge pages were changed.

After the annotation correction, `record_work(action="receipt")` saved receipt `a43850dae9c6488faf4fa863d6808106` but returned `completion_accepted: false`, `status: in_progress`, `saved_count: 5`, `submitted_count: 0`, all five exact saved criteria in `missing`, `unknown: []`, `revision_matches: true`, and an empty `note`. The task therefore remains `in_progress`; the service did not recognize the submitted criteria despite the saved revision matching. The worker released its lease; AgentMem reported `owner: ""` and `lease_until: 0`. No requirement was marked fulfilled and no curated knowledge page was changed.

Repository resync advanced the code index to revision 1503 with no pending changes, but the scan remained truncated and AgentMem reported the index as stale. The reviewers and accountable worker inspected the local checkout directly. Repository indexing is separate from curated knowledge. No broader project requirements were changed or marked fulfilled.
