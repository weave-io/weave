---
"@weaveio/weave-cli": minor
"@weaveio/weave-adapter-claude-code": minor
---

Generate a Claude Code plugin from Weave configuration.

- The new `@weaveio/weave-adapter-claude-code` package writes a Claude Code plugin directory from a loaded `.weave` config.
- `weave compose --adapter claude-code` runs the whole pipeline: load config, materialize agents, write the plugin.
- `weave compose --adapter claude-code --init` scaffolds the bootstrap plugin that regenerates the plugin on session start.
- Agent models map to Claude Code aliases, and tool policy maps to the `tools` frontmatter array.
