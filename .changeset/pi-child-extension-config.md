---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-opencode": minor
---

Store harness-neutral adapter preferences and read them back from the CLI.

- `AdapterPreferenceRepository` offers bounded `get`, `set`, `list`, `listAll`, and `remove` over opaque valid JSON values, with a 64-character namespace, a 128-character key, a 16 KiB value, and a 100-row default and maximum listing. The engine never interprets a stored value, and preferences must never hold secrets.
- Runtime Store migration v6 adds the backing `adapter_preferences` table in place on an existing v5 database.
- `weave runtime preferences [--namespace <ns>] [--limit <n>]` lists stored rows in deterministic `(namespace, key)` order, bounds each value preview to one line, and stays read-only: it never creates, migrates, or writes a store.
