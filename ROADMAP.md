# Roadmap

These are recorded as future requests, not release promises or completed features.

## Custom approval policies

Let users define and review custom Codex approval policies beyond the supported presets. The current app only exposes app-server's built-in `on-request`, `untrusted`, and `never` modes. Any future policy editor must preserve the separate sandbox/write-root boundary and make the effect of each rule explicit.

## Multimodal task input

Support user task inputs beyond plain text, including attached images and other media formats where Codex app-server supports them. This release accepts text only and does not claim to inspect attachments or media.
