---
"@weaveio/weave-cli": patch
"@weaveio/weave-adapter-opencode": patch
"@weaveio/weave-adapter-claude-code": patch
"@weaveio/weave-adapter-pi": patch
---

Keep Runtime Store writes durable and step attempts inspectable.

- Persisted step attempts back retry-stable artifact pins.
- The store holds no-follow descriptors, bounds its locking, and writes atomic serialized SQLite snapshots.

Bundled-source: @weaveio/weave-engine
