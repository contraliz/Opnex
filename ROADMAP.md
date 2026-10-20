# Roadmap

These are recorded as future requests, not release promises or completed features.

## Custom approval policies

Let users define and review custom Codex approval policies beyond the supported presets. The current app only exposes app-server's built-in `on-request`, `untrusted`, and `never` modes. Any future policy editor must preserve the separate sandbox/write-root boundary and make the effect of each rule explicit.

## Multimodal task input

Support user task inputs beyond plain text, including attached images and other media formats where Codex app-server supports them. This release accepts text only and does not claim to inspect attachments or media.

## Worker-session access and viewer

The runtime already creates separate Codex threads for the orchestrator and worker. Add a user-facing way to inspect and switch to the worker's session, then return to the orchestrator context, with conversation and activity kept visibly isolated. Explore a right-side session rail or a clickable worker-activity row/button styled like Codex's session controls. Do not merge worker transcripts or reasoning into orchestrator input. This is a future UI feature; no session viewer is implemented in this release.
