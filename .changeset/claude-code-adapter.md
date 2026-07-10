---
"@weaveio/weave-adapter-claude-code": minor
"@weaveio/weave-cli": minor
---

Add Claude Code adapter with compose CLI command

- New `@weaveio/weave-adapter-claude-code` package: generates a Claude Code plugin directory from Weave config
- New `weave compose --adapter claude-code` CLI command drives the full pipeline (load config → materialize agents → write plugin)
- `--init` flag scaffolds the bootstrap plugin for automatic SessionStart regeneration
- Model alias mapping (claude-sonnet-4-5 → sonnet, claude-opus-4 → opus, etc.)
- Tool policy mapping to Claude Code's tools frontmatter arrays
- Bootstrap plugin with SessionStart hook and /weave:compose skill
