---
"@weaveio/weave-adapter-opencode2": patch
---

Windows hosts: `/weave:start` no longer answers "Weave could not list plans" and the plan panel no longer crashes.

Plan catalog and plan snapshot reads use `node:fs` instead of spawning the POSIX `test`/`realpath` binaries, which are absent when OpenCode is launched outside a POSIX shell (Windows TUI, a managed server). The started plan is stored with the normalized scope directory so the plan RPC recognises it on native `C:\` paths, and `projectConfig: false` now matches the project config path on Windows. The TUI plan panel uses the 2.0.x theme tokens (`text.feedback.*.base`, `text.muted`) instead of the removed `text.status.running`, `text.subdued` and `feedback.*.default`, which crashed `weave.tui` in the composer slot.
