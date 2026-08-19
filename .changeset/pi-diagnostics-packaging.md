---
"@weaveio/weave-adapter-pi": minor
---

Report bounded Pi diagnostics and keep the packed adapter artifact honest.

- Usage projection is exact-once, and retention plus rotating-log cleanup bound what stays on disk.
- Packed-artifact policy checks and offline fake-host consumption prove the published tarball loads without a live host.
