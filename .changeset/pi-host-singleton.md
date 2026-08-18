---
"@weaveio/weave-adapter-pi": minor
---

Load exactly one copy of the Pi host runtime, and choose which Pi extensions Weave children load.

- A thin extension loader redirects `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` to the running host's own copies before the adapter is imported. It proves the host package root first and fails open on every skip reason, so a redirect it cannot prove preserves the previous behavior.
- `/weave:health` reports `host runtime: single-copy` or a warning-only `host runtime: duplicate-detected`, and the proven host version wins over a mismatched imported `VERSION`.
- `/weave:pi-config` stores a child-extension selection as one Runtime Store adapter preference. Weave stays enabled and first, entries the live inventory no longer offers are dropped on save, unselected provider extensions supply no models or credentials to children, and the default stays inherit-all.
- A saved selection applies to children spawned after the next session start, never to a running child.
