---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
"@weaveio/weave-adapter-opencode2": minor
"@weaveio/weave-adapter-claude-code": minor
---

Declare optional delegation concurrency intent in configuration.

- `settings.delegation.max_concurrency` accepts a positive safe integer and follows the usual config merge rules.
- The intended limit covers live foreground and background children separately for each parent session.
- Enforcement is adapter-owned. The pinned OpenCode V2 adapter accepts the setting but does not enforce it; its public host API cannot satisfy the live-child admission contract. Configuration support does not establish a runtime resource or cost limit.
