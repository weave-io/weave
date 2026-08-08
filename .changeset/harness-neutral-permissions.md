---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
---

Add harness-neutral permissions to the CLI-bundled engine API: `PermissionService` session activation, registered-tool authorization, durable project grants, single-use permits that return a frozen execution snapshot, coverage proof, and registered `beforeTool` lifecycle compatibility (no legacy one-capability aliases). Runtime Store migration v3 persists grant allowlists only, re-verifies the live schema on open, and keeps an internal wall-clock high-water so durable expiry cannot resurrect after clock rollback.
