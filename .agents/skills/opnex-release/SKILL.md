---
name: opnex-release
description: Build and distribute Opnex desktop releases for Windows and macOS when the user explicitly requests a specific release or asset replacement.
---

# Opnex desktop release

Use this skill for a specifically authorized Opnex Windows/macOS release build or replacement of existing release downloads. A code fix, CI completion, prior release request, or loading this skill does not authorize a build, tag, publication, or asset replacement. Confirm the user named the intended version and whether this is a new release or replacement before any release mutation.

Read the current [`release.yml`](../../../.github/workflows/release.yml), [`electron-builder.yml`](../../../electron-builder.yml), [`package.json`](../../../package.json), Windows installer smoke, and matching `docs/releases/vX.Y.Z.md` before acting. Treat the workflow as publishing: tag pushes trigger it automatically; `workflow_dispatch` requires an existing target tag and its publish job overwrites matching release assets after package jobs pass. Do not dispatch or push a `v*` tag unless the user explicitly authorized that particular release. The project decision `DEC-0006` records this boundary.

Keep source integration separate from release authorization. Review the intended source against `main`; stage only release code and docs, excluding untracked QA, local state, databases, logs, credentials, and build outputs. Use normal fast-forward source pushes and preserve published tag history. Package version, target tag, source ref, and release notes must agree. For a replacement, retain the existing tag and page, state the exact corrected source SHA in the notes, and do not remove prior downloads until verified replacements are ready.

The current targets are Windows x64 NSIS and macOS x64/arm64 ZIP. The Windows installer requests UAC elevation and installs per-machine; the app itself runs as the signed-in user. Keep clean-install, per-user 1.1.1 to per-machine upgrade, uninstall, and saved user-data retention checks. The migration baseline is rebuilt from the immutable `v1.1.1` tag because its public installer asset is replaceable; never trust an old hash against a mutable download URL.

The packaged skills and AgentMem MCP helpers require the pinned official Node runtime for the package OS/architecture, its license, and unpacked helper code/dependencies. Keep Electron's `runAsNode` fuse disabled; packaged-helper smoke must prove the actual runtime and MCP calls work without a global Node installation. Retain canonical/isolation test fixtures on macOS. Distinguish packaged helper verification from live model calls and native manual app checks.

Do not claim signing or notarization unless separately provisioned and verified. Current release notes state packages are unsigned and macOS builds are not notarized. Verify successful platform jobs, exact asset names/version/architectures, nonzero sizes and published digests, tag, source SHA, and release URL. Stop after a bounded diagnosis if CI fails; fix source and rerun only within the user's authorization for that release. Return commit/ref, version/tag, release URL, asset links and evidence, tests, and unverified platform/signing limits.
