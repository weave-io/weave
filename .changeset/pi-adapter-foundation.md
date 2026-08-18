---
"@weaveio/weave-adapter-pi": minor
---

Add the Pi adapter package with a compiled extension entry point.

- Exact host compatibility checks run before the adapter touches a session, and initialization fails safe.
- Controllers are generation-scoped, so a reload leaves no stale state behind.
- Capability health reports are normalized, and an unsupported required capability drops the session into health-only mode instead of activating.
- An isolated fake host makes the adapter testable without a live Pi process.
