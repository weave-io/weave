---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
---

Authorize registered tools through harness-neutral permissions.

- `PermissionService` activates a session, authorizes registered tools, and issues single-use permits that return a frozen execution snapshot.
- Durable project grants persist across sessions, and coverage proof states which registered tools a policy actually covers.
- Registered `beforeTool` lifecycle compatibility replaces the legacy one-capability aliases.
- Runtime Store migration v3 persists grant allowlists only, re-verifies the live schema on open, and keeps an internal wall-clock high-water so a durable expiry cannot resurrect after a clock rollback.
