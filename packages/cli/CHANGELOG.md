# @weaveio/weave-cli

## 0.1.0

### Minor Changes

- f6d1ae0: Add Claude Code adapter with compose CLI command
  
  - New `@weaveio/weave-adapter-claude-code` package: generates a Claude Code plugin directory from Weave config
  - New `weave compose --adapter claude-code` CLI command drives the full pipeline (load config → materialize agents → write plugin)
  - `--init` flag scaffolds the bootstrap plugin for automatic SessionStart regeneration
  - Model alias mapping (claude-sonnet-4-5 → sonnet, claude-opus-4 → opus, etc.)
  - Tool policy mapping to Claude Code's tools frontmatter arrays
  - Bootstrap plugin with SessionStart hook and /weave:compose skill

### Patch Changes

- 9ae688c: Rename npm scope from `@weave` to `@weaveio` and add publish pipeline
- 2d401d0: Normalize in-memory CLI test paths consistently on Windows.
- Updated dependencies
- Updated dependencies [f6d1ae0]
- Updated dependencies [9ae688c]
- Updated dependencies [2d401d0]
  - @weaveio/weave-config@0.1.0
  - @weaveio/weave-adapter-claude-code@0.1.0
  - @weaveio/weave-core@0.1.0
  - @weaveio/weave-engine@0.1.0
