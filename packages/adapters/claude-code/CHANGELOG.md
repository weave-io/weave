# @weaveio/weave-adapter-claude-code

## 0.2.0

First stable release alongside `@weaveio/weave-cli@0.2.0`, whose
`weave compose --adapter claude-code` and `weave init --harness claude-code`
bundle this adapter.

- The builtin agents' models map to Claude Code's aliases, including the
  Opus 5.5 and Sonnet 5.5 defaults (`claude-sonnet-5-5` → `sonnet`).
- Verified on Claude Code 2.1.285: every builtin and category shuttle loads
  as `weave:<name>`, Loom is the main agent, and Loom delegates to a category
  shuttle.

## 0.1.0

### Minor Changes

- f6d1ae0: Add Claude Code adapter with compose CLI command
  
  - New `@weaveio/weave-adapter-claude-code` package: generates a Claude Code plugin directory from Weave config
  - New `weave compose --adapter claude-code` CLI command drives the full pipeline (load config → materialize agents → write plugin)
  - `--init` flag scaffolds the bootstrap plugin for automatic SessionStart regeneration
  - Model alias mapping (claude-sonnet-4-5 → sonnet, claude-opus-4 → opus, etc.)
  - Tool policy mapping to Claude Code's tools frontmatter arrays
  - Bootstrap plugin with SessionStart hook and /weave:compose skill
