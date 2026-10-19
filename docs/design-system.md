# Design system

This desktop-only interface uses a familiar developer-tool layout without Codex or OpenAI logos or claims of affiliation. Visual concept and QA images are kept outside the public source tree.

## Layout and hierarchy

- Desktop application shell: compact left navigation rail, central conversation workspace, optional right assignment/session inspector. Target desktop first at 1440 × 1000.
- Sidebar: Pseudoharness wordmark, one prominent New task action, recent task list, project identity, AgentMem and Settings entries. Task counts and connection states come from real data.
- Top bar: current project, selected task, app-server state, AgentMem state, inspector toggle, settings.
- Main area: user message, collapsible assignment, worker or orchestrator response, visible phase label, anchored multiline composer.
- Receipt state: compact expandable outcome with acceptance, verification, risk, and review state. Blocked states use a calm warning surface with a real retry or settings action.
- Desktop resizing: the inspector can collapse and is hidden at smaller desktop widths so the conversation retains usable space. There is no mobile client or mobile-specific navigation.

## Tokens

Approximate from the generated concepts and refined only where required for contrast:

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#11161D` | App canvas |
| `--sidebar` | `#171D26` | Navigation |
| `--surface` | `#1A222D` | Assignment and composer surfaces |
| `--surface-raised` | `#202A37` | Hover, selected, and grouped detail |
| `--border` | `#2B3544` | Thin separators and outlines |
| `--text` | `#EDF0F7` | Primary text |
| `--muted` | `#A4AEC0` | Secondary text |
| `--subtle` | `#778396` | Timestamps and helper text |
| `--accent` | `#7587FF` | Primary action, selected navigation, focus |
| `--success` | `#55C99A` | Verified completion |
| `--warning` | `#E8AD54` | Connection and user-action warnings |
| `--danger` | `#E97882` | Cancelled or failed status |

## Typography, spacing, and components

- UI text uses `Inter` where available, then system sans-serif. User and agent messages use the same sans family; only code/dense identifiers use `ui-monospace`.
- Compact chrome: 12–14 px; body: 14–15 px; section title: 16 px; page/task title: 18–20 px. Use 1.45–1.6 body line-height.
- Spacing follows a 4 px base: 4, 8, 12, 16, 24, 32. Borders are 1 px. Component radius is 6 px; the composer and assignment panel can use 8 px.
- Icons are small outline symbols from Lucide with muted slate strokes. Status uses text plus a small colored dot so color is never the only signal.
- Focus rings are visible and accent-colored. Buttons, navigation, disclosure rows, select fields, and dialogs provide keyboard and hover states.
- Motion is limited to short (120–180 ms) opacity/rotation transitions for disclosure and streaming status; reduced-motion preference disables it.

## Visible copy rules

Use concrete task language and honest states such as “Planning”, “Worker running · orchestrator idle”, “Reviewing receipt”, “Blocked before worker start”, and “AgentMem unavailable”. Never display fabricated model replies, progress, task counts, connection success, or verification results. The model catalog populates model selectors; the worker remains pinned to `gpt-6-luna` at `high` and blocks visibly when unavailable.
