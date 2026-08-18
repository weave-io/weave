---
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-claude-code": patch
"@weaveio/weave-adapter-pi": patch
---

Observe runtime usage and capabilities without harness-specific bookkeeping.

- Bounded retention settings cap how long runtime records live.
- Usage observations and rollups are idempotent, so a retried step never double-counts.
- Probe results lower effective capabilities, so a report states what the live harness supports.
- A rotating log sink keeps runtime logs bounded on disk.

Bundled-source: @weaveio/weave-engine
