---
"@weaveio/weave-adapter-opencode2": minor
---

New sessions on OpenCode 2 start on Loom. The plugin's `defaultAgent` option now defaults to `loom`; before, Weave set a default only when the option was passed, so a plain plugin entry left new sessions on OpenCode's `build` agent. A `default_agent` in your OpenCode config still wins, because OpenCode applies it after every package plugin. If another plugin already holds `loom`, Weave sets no default.
