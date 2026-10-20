# Desktop design system

The approved Codex-inspired concepts define the visual direction for the local Pseudoharness app. The interface uses neutral graphite surfaces, thin separators, and a restrained violet action accent. It is an independent product and does not use official Codex or OpenAI branding.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#141414` | Main conversation background |
| Sidebar | `#191919` | Navigation and task list |
| Surface | `#1B1B1B` | Details and dialog surfaces |
| Raised surface | `#202020` | Composer, selected items, code blocks |
| Divider | `#303030` | Hairline borders and separators |
| Primary text | `#ECECEC` | Conversation copy |
| Secondary text | `#A6A6A6` | Labels and supporting text |
| Accent | `#A99AFF` | Primary actions, selected navigation, focus |
| Success | `#88C9A5` | Small completion status indicators |
| Radius | `6–9px` | Compact controls and dialog corners |
| Spacing | `4 / 8 / 12 / 16 / 24px` | Consistent layout scale |

Use a system sans-serif stack, with 14–15px conversation text and 11–12px chrome labels. Lucide outline icons use restrained strokes. Semantic states use text as well as color.

## Layout

- A 330px left sidebar holds the app name, New task, recent tasks, project identity, service status, and bottom-pinned Settings. The main top-bar control fully collapses it to zero width and stays at the left edge of the chat pane so it can reopen in place.
- A 68px top bar shows the selected project and task, Codex connection state, Stop while active, and a Details toggle.
- The conversation and optional 292px task inspector share the workspace above the composer. The inspector closes to zero width, allowing the conversation to expand without covering the composer.
- A 210px composer dock stays anchored to the bottom of the central chat column. It contains the multiline prompt, actual model/effort/approval selectors, Luna availability, and send control; it does not extend beneath the task inspector.
- The centered Settings dialog configures project root, optional AgentMem project identity, orchestrator model and effort, approval preset, and real connection status.

## Behavior and accessibility

Conversation content scrolls independently of the sidebar, inspector, and anchored composer. Task history and long sidebar lists have their own scroll areas. Scrollbars use a slim muted charcoal thumb on a transparent track; forced-colors mode follows system colors. Markdown, code blocks, and tables remain bounded by the conversation width.

Reasoning groups contain only provider-supplied readable summaries, separately labeled by role and turn. Empty, waiting, and unavailable states are truthful. Raw reasoning is never shown. Assignment and receipt disclosures remain bound to the pass that produced them.

Controls provide visible keyboard focus, native selector behavior, and concise labels. The left sidebar toggle stays in the main top bar in either state. The New task action has no macOS shortcut badge; the existing Ctrl+N keyboard action remains available on Windows. Sidebar, inspector, assignment, and receipt transitions use short opacity/position or grid-size animations; `prefers-reduced-motion` minimizes them. Settings closes with Escape or Cancel; forced-colors preferences are respected. The layout is desktop-first and has no mobile client.

The approved visual concepts and local fidelity record are development-only review artifacts and are not included in the public source tree.
