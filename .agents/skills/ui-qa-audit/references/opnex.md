# Opnex audit map

Use this reference when auditing the Opnex repository. Source paths below are repository-relative.

## Visibility and fixtures

- Use QA MCP hidden browser stages (`hidden: true`) for interactions and screenshots. Never focus a stage or launch/raise Electron, a visible browser, a desktop capture, or an OS file picker. Respect the user's visibility constraint for the current audit.
- Use isolated, clearly labeled project/session/skill data. Avoid real provider turns, external browser navigation, and remote GitHub writes. Do not change tracked app code to prepare an audit.
- Save every `scenario_run`'s `run-notes.md` and `issues.md` beside that run's actual `meta.json`; use the actual `run_id` with `findings_store`, including an empty finding list for zero-finding scenarios. Map central UI IDs to run-local finding IDs. Do not invent paths or IDs.
- For every primary settled screen, inspect the untouched original first, then overlapping enlarged regions that span the whole image, and a contrast-adjusted dark view when available. Actually view each rendition and retain coordinate mapping to the original. Treat automated measurements as leads.

## Pages and source map

`src/ui/App.tsx` owns the shell, global navigation, session/home content, and dialogs. `src/ui/workspaceTabs.ts` defines four workspace kinds: `session`, `browser`, `git`, and `skills`. Sessions is the home destination. Browser, Git, Skills, and Settings are available from the global rail; Settings is one global overlay, not a separate workspace or a set of internal tabs.

| Destination | Main source | Important surfaces |
| --- | --- | --- |
| Sessions / home | `src/ui/App.tsx` | Empty and populated sidebar, project groups, session tabs and transcript, composer, model/effort/approval controls, slash-skill chooser, pass activity, receipt, errors, approvals, project editor, shortcuts, session actions |
| Browser | `src/ui/EmbeddedWorkspace.tsx` | Address bar, navigation feedback, annotations, pane/split controls and embedded page. The page body uses Electron WebContents; a regular QA Chromium stage can check the toolbar but cannot prove native page rendering or native layering. Use a harmless localhost fixture only. |
| Git | `src/ui/LocalGitWorkspace.tsx` | Inspect all six subviews: Overview, Branches, Worktrees, History, Pull requests, and Issues. Use an isolated local repository. Check unauthenticated/remote states without signing into or writing to a real account. |
| Skills | `src/ui/SkillsLibraryDialog.tsx` (`SkillsLibraryPage`) | Empty and populated states, create, edit, archive/restore, search, and slash invocation from a session. Import folder/file controls invoke OS file pickers; mark native picker behavior blocked under hidden-only testing. |
| Settings overlay | `src/ui/SettingsDialog.tsx` | AgentMem setup/project picker, project-root picker, worker provider/model/effort fields, orchestrator model and effort, approval policy, connection state, reconnect and kernel controls, Cancel and Save. |

Additional dialog implementations live in `src/ui/App.tsx` and `src/ui/SettingsDialog.tsx`: project editing, rename/delete session, keyboard shortcuts, DirectoryPicker, and AgentMem project selection. Inventory the buttons and keyboard paths in the running version before declaring the dialog list exhaustive.

## Required emphasis

1. **Settings from every workspace kind:** open it from Sessions, Browser, Git, and Skills. Inspect the complete scrollable contents and options, not only the top. Check at normal and short supported web sizes (for example 1440×900 and 900×620), page-specific overlay visibility and scroll preservation, field validation, Save persistence, Cancel discarding edits, close/Escape, focus containment and restoration, and nested DirectoryPicker stacking/Escape return. Open each ChoicePopover and verify Escape dismisses only that topmost menu while Settings stays open. Do not assume Cancel semantics: reopen and confirm the draft was discarded. Do not click “Stop Opnex kernel” during an audit; it pauses active work and disconnects clients.
   - Check custom control-label alignment as well as behavior: the AgentMem auto-setup checkbox should share a row with its title and keep help below it, while ordinary Settings field labels remain stacked. Inspect custom provider fieldsets and legends for themed borders, spacing, wrapping, and overflow.
2. **Sessions/home:** include first-run and empty state, configured project state, multiple projects/sessions, navigation, composer actions and pickers, rich/long content, receipts both collapsed and expanded, project and session dialogs, keyboard shortcuts, and scroll at supported sizes. Use labeled safe fixtures for loading, errors, activity/tool, streaming, and approval states only when the state can be represented faithfully. Do not send a real provider turn to manufacture a state.
   - Inspect the project-to-session hierarchy in expanded and collapsed states. Count visible guide lines for named projects and Unclassified, with empty, one-child, and multi-child groups; check selected and hovered rows, child-text inset, and whether a collapsed group leaves an orphan guide.
3. **Browser:** verify address and toolbar states with a local fixture. Report the Electron WebContents body, browser profiles, native menus, split layering, and desktop resizing as blocked when they cannot be seen through the hidden web stage; never infer them from a placeholder.
4. **Git and Skills:** visit each Git subview, and exercise each safe Skills action. Separate isolated local Git behavior from authenticated/remote behavior. Treat OS file/folder import pickers as blocked when opening them would violate the hidden-window constraint.

## Opnex state-recovery boundary

`server/state.ts` pauses persisted in-flight tasks on startup, removes active turns and approval requests, and records interrupted approvals. A state file containing an active or approval fixture therefore does not prove those live UI states were rendered. If a safe faithful state cannot be maintained without a provider turn or app modification, document the specific limit and leave that row unverified.
