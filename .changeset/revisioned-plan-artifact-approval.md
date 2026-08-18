---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
---

Approve plan artifacts against an exact revision instead of a name.

- Plan snapshots are revisioned, and coordinator-authorized transitions compare and swap on the revision, backed by atomic Bun plan-file replacement.
- Artifact approvers are structured user or gate-agent actors instead of strings, and every decision binds to the exact revision and digest.
- Immutable actor snapshots persist with atomic self-approval and stale-revision guards.
