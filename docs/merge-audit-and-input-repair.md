# Merge audit and targeted UI/input repairs

## Branch integration audit

Both requested feature branch tips are ancestors of the current `main` (`2bb8db455030e5e9e5aba66f45651d01def05848`):

| Branch | Tip | Ancestry | Intended scope | Effective behavior on current `main` |
|---|---|---|---|---|
| `delegation-routing` | `a9232d564c2db0d966b40017d03c2af239a22235` | `git merge-base --is-ancestor origin/delegation-routing main` succeeds; merge-base equals the branch tip. | Isolated app-owned Codex context and role routing. | Current `server/intake.ts`, `server/orchestrator.ts`, and `server/codex.ts` retain router/direct/simple/orchestrator/worker roles. The router uses the isolated agent runtime, low-effort Luna and no dynamic tools; direct/simple routes are dispatched through role-specific turn setup and policy checks. Focused tests remain in `tests/intake.test.ts`, `tests/orchestrator-routing.test.ts`, and `tests/codex-protocol.test.ts`. Later main commits add staged workers and workspaces without removing this routing flow. |
| `codex/macos-support` | `4b603f733e713e9079baf8f84e28b26ef3260ded` | `git merge-base --is-ancestor origin/codex/macos-support main` succeeds; merge-base equals the branch tip. | Platform-correct application-data paths and portable path tests. | `server/paths.ts` branches for Windows, macOS, and Linux/XDG; macOS uses `~/Library/Application Support/Pseudoharness`, and the data-directory override resolves with the selected platform's path API. `tests/paths.test.ts` covers the macOS path. Current `tests/git.test.ts` and `tests/policy.test.ts` use platform-appropriate paths. |

The merge commit `e03a539` brought both tips together; later commits on main advanced the UI and workspace features. The ancestry and present source/tests both support the conclusion that the two identified branches were merged and their described behavior remains. This audit does not identify or attribute the separately preserved attachment implementation to any branch.

## Drag behavior and desktop menu

Session tabs can be reordered in a strip, transferred by dropping on another pane's strip, or split to either side of any pane by dropping on that pane's content half. Pane groups are horizontally adjacent and dynamic; empty groups are pruned, remaining widths are normalized, and collapsing a group transfers its tabs to a neighbor without changing tab IDs or drafts. Browser page tabs retain their existing reorder/split behavior. Browser/GitHub rail movement retains its existing workspace placement and native view instance. Side-pane actions are drag-based; there are no visible dock, main/side, or full-view buttons.

This adapts Obsidian's documented pane model: tabs can be dragged between tab groups and panes can be split to arrange adjacent content. Pseudoharness uses in-window horizontal pane groups and content-half drop targets; it does not reproduce Obsidian's separate pop-out windows. [Obsidian Help: Tabs](https://help.obsidian.md/User%20interface/Tabs), [Obsidian Help: Panes](https://help.obsidian.md/User%20interface/Panes)

On Windows and Linux, Electron's visible menu bar is hidden on the app window. macOS keeps Electron's standard application menu behavior. The app renderer continues to use the OS-provided window frame and controls.

## Multimodal attachments

The composer exposes a plus button for selecting up to five PNG, JPEG, WebP, TXT, Markdown, CSV, or JSON files. Each file is capped at 5 MiB and each submission at 12 MiB. The client keeps selected files with the session draft, shows an image thumbnail or file name, and allows removal. Failed submissions retain the draft and attachments. The server validates declared MIME type, base64 shape, actual byte count, text UTF-8, image signatures, file count and aggregate size. Names are reduced to a safe basename; the server does not read client paths. Image data is delivered to the Codex turn as inline image input; text files are attached as labeled text. Attachments are untrusted task data and travel with the originating pass through routing, direct/simple execution, orchestration, and delegated execution.

No live provider inference, private-file picker selection, or macOS picker check is claimed by this implementation record. See `docs/attachments.md` for supported formats and limits.

## Verification and limits

- `npm run lint`, `npm run typecheck`, all 192 tests, `npm run build` (through `npm run desktop:smoke`), `npm run desktop:smoke`, and `git diff --check` passed. The production build reports its existing advisory that the JavaScript chunk exceeds 500 kB.
- Edge rendered the isolated app at 2040×935 with temporary local backend data. Visible UI drags created three panes at approximately 844/422/422 pixels, split to the left half of an existing pane, transferred tabs between groups, reordered tabs, and resized both neighboring dividers. Collapsing a middle group preserved its tabs and active draft; closing the last tabs pruned the group and expanded the survivor to the full workspace width. The explorer was resized, collapsed below 112 pixels and reopened; the 42-pixel activity rail stayed visible. No task was submitted.
- React interaction tests cover dynamic pane split, tab transfer/reorder, group pruning and weight normalization, divider resizing/collapse, explorer collapse/restore, session drafts, native browser-tab reorder/splitting, attachment selection/removal/attachment-only payload, and backend image/text mapping. Native Electron browser-tab drag was not directly exercised; the desktop smoke verifies app startup and persistent browser profile only.
- The Windows `BrowserWindow.setMenuBarVisibility(false)` path is present and the source Electron app launched in smoke; no visible native menu-bar screenshot was captured. macOS menu/picker behavior remains unverified. No live provider image inference or native desktop file-picker selection was performed.
- The attachment feature was restored selectively while leaving the existing stash intact. Its committed branch provenance is unknown; the two requested branch tips are independently verified as ancestors of `main` and their effective routing/path behavior remains in current source and tests.
