# @weaveio/weave-cli

## Unreleased

### Added

- Add explicit `opencode2` detection and installation for native
  `opencode.json` and `opencode.jsonc` files.
- Preserve JSONC comments and plugin options while adding one idempotent
  `@weaveio/weave-adapter-opencode` entry.

### Changed

- Parse legacy migration input as JSONC, including comments and trailing
  commas. Reject duplicate or dangerous keys and bound diagnostics.

## 0.1.0

### Minor Changes

- Add the Claude Code adapter and compose command.

### Patch Changes

- Normalize in-memory CLI test paths consistently on Windows.
- Rename the npm scope from `@weave` to `@weaveio` and add the publish pipeline.
