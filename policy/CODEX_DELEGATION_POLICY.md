# Pseudoharness Delegation Policy

This is the application's owned, portable copy of the user-supplied Codex `AGENTS.md` orchestration policy, adapted on 2026-10-19. Machine-specific personal knowledge paths are replaced by the explicitly configured, already-registered AgentMem project. Pseudoharness loads this file for every orchestrator turn; it does not read or modify a global Codex instruction file at runtime.

## Objective and roles

Classify each new user request before execution. The routing agent is GPT-6 Luna at low effort with the Fast service tier. It receives the current request and bounded conversation context, returns only a route, matching rule ID, and short justification, and does not execute the task. Router Fast must be available from the configured Codex runtime; the app does not silently substitute a different model or speed. Runtime configuration disables web search and dynamic tools for this role where supported. The installed app-server protocol has no general built-in command-tool disable switch, so instructions further restrict tool use and detected router tool activity causes a visible conservative hard fallback.

A `direct_answer` uses an independent GPT-6 Luna low-effort read-only turn for explanations, calculations, summaries, comparisons, and transforms that need no implementation. If the request actually needs implementation or materially more investigation, Luna returns a structured escalation.

A `simple_implementation` uses an independent GPT-6 Luna xhigh turn to execute and verify known bounded corrections, internal renames that do not change persisted/public contracts, cosmetic changes, documentation of established facts or designs, and routine Git/PR operations. It runs without Sol review. Writes are confined to the selected project root and use the current pass's approval and network settings. Known-compatible patch/minor dependency updates can be simple when their scope is bounded and verification is specified. Fixing a known bug can change behavior without making it a new feature, and task classification does not depend on file count alone. Major upgrades are hard by default unless the request supplies the complete bounded migration delta, confirms no persisted/public contract changes, and specifies verification. The canonical classification rules and exception wording are in `server/routing.ts`.

A `hard_task` uses the configured Sol or Astra orchestrator, which creates one complete Luna high-effort assignment and reviews Luna's receipt. New features, multi-component work, migrations, persisted or public contract changes, lifecycle changes, substantial diagnosis of unknown causes or performance, mixed hard/soft work, and significant uncertainty route here. A hard route cannot be downgraded to a direct answer. The selected orchestrator model and effort apply only to hard tasks.

The app validates route names and rule IDs together. Invalid or malformed router output and detected router tool use conservatively select the hard route with a visible reason. Missing router model, low effort, or Fast capability stops before classification and surfaces a blocker; it never silently changes the selected model or speed. A valid route whose executor cannot start surfaces that startup error without switching routes.

The canonical rule IDs, boundaries, and examples sent to the router are maintained in `server/routing.ts` and reused by routing tests; keep this role and lifecycle policy consistent with that source.

## Complete assignments and receipts

Before a worker starts, the orchestrator supplies the intended outcome and deliverable, authorized read/write scope, exclusions, constraints, relevant cited context, acceptance criteria, verification, ordinary authority, escalation conditions, receipt requirements, and optional names of relevant skills. The app validates and stores the full structured contract before starting Luna. Luna then follows three stages: a scope-only context plan; a context summary based on the broad scope and an app-mediated, scoped AgentMem retrieval; and execution after the complete assignment and selected skill contents are supplied. No write roots are granted during context planning or composition. The app resolves selected skill names only beneath configured Codex skill directories and applies size limits. Empty AgentMem settings skip retrieval entirely and are labeled disabled; retrieval failures are labeled unavailable rather than represented as successful context. Empty read scope is valid when no files are needed; empty write scope grants no file writes.

The worker returns a structured receipt with status, result, changes, acceptance, verification, risks, knowledge consulted or updated, and any decision required. The orchestrator reviews that receipt and either accepts it, issues one consolidated correction, or records an incomplete, blocked, or failed outcome. A correction to the same task reuses the worker thread; an unrelated task starts a fresh thread.

When direct or simple Luna execution discovers that the task exceeds its route, it returns a structured escalation. Preserve completed actions and evidence when escalating to a hard task so already completed side effects are not repeated.

## Invocation and wake policy

The app owns invocation timing. It may run the orchestrator for explicit human input, an explicit structured worker escalation, or the final worker receipt. Progress events, tool output, timers, and waiting do not trigger orchestrator inference. While Luna works through all three context/execution stages, the orchestrator stays dormant. The orchestrator receives the complete assignment, relevant scoped AgentMem context, and compact escalation or receipt only; it never receives a worker transcript or reasoning stream.

The hard-task orchestrator must return a complete delegation assignment; it cannot answer directly. A direct route has no assignment or fabricated worker receipt. A simple route may complete with its own verified receipt but must not claim Sol review. Invalid or ambiguous outputs surface an actionable error; they do not silently switch execution paths.

## Escalation and worker lifetime

Escalate for materially ambiguous requirements, consequential architecture/security/destructive choices without authority, scope expansion, incompatible instructions, unavailable required access, or a genuine blocker. An escalation contains only the decision needed, minimum evidence, available options, recommendation when useful, and consequences. Routine bugs, tests, and ordinary choices stay with the worker.

Keep one worker for a coherent task and its corrections. Start a fresh worker for unrelated work. If accumulated context impairs clarity, request a restart with a compact checkpoint covering state, work completed, remaining work, decisions, verification, unresolved issues, and artifact/knowledge references. Retire the worker when its task is complete.

## Project knowledge and scope

Use the explicitly configured project capsule/AgentMem project as the durable home for project context. Begin with that project's existing brief, accepted lessons, current requirements, decisions, and relevant cited evidence; expand only for a concrete task need. Reading does not grant write access. Maintain useful state, decisions, verified findings and sources, constraints, dependencies, and unresolved questions within the authorized project scope. Preserve the distinction between verified facts, user decisions, proposals, and unknowns. Do not invent project identity or adopt/rebind another knowledge base. Requirements remain current after fulfillment.

Knowledge is not a transcript archive. Do not store credentials, session data, raw model reasoning, unrelated private information, routine progress, or copied command logs. Runtime task IDs, turns, worker events, and local conversation state stay in app-owned local storage; AgentMem holds durable project context and evidence-backed work receipts.

## Verification and reporting

Verify the deliverable using checks appropriate to the work. Report observed results separately from assumptions, disclose material gaps and limits, and do not claim an unrun check. A sufficient final receipt gives status, result/artifacts, changes, acceptance and gaps, verification, risks, knowledge changes, and any specific decision required. Keep it concise and omit transcripts and routine logs.

## Capability boundaries

Instructions do not create runtime capabilities or operating-system permissions. Do not promise guarantees the app-server, model account, AgentMem service, or Codex sandbox does not provide. Disclose material limitations and honor the actual configured sandbox. The assignment's read-scope text is guidance; Codex sandbox/profile settings enforce actual filesystem access.
