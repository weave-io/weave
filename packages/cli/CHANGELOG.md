# @weaveio/weave-cli

## 0.2.0

- `weave init` produces a setup that runs: `--harness opencode` adds the
  pinned adapter to OpenCode 1's `plugin` array (it used to write a comment),
  `--harness claude-code` composes the Claude Code plugin, detection finds
  harness binaries again, and the starter categories no longer pin stale
  models or a `temperature` some models reject.
- `weave init` pins the OpenCode 1 and OpenCode 2 adapter versions released
  with this CLI (`0.2.0`).
- Logs go to stderr at `warn` unless `LOG_LEVEL` is set.

### Added

- Add explicit `opencode2` detection and installation for native
  `opencode.json` and `opencode.jsonc` files.
- Preserve JSONC comments and plugin options while adding one idempotent
  `@weaveio/weave-adapter-opencode` entry.

### Changed

- Parse legacy migration input as JSONC, including comments and trailing
  commas. Reject duplicate or dangerous keys and bound diagnostics.

### Fixed

- `weave init migrate` exits non-zero and writes nothing when the legacy config
  cannot be parsed, and never writes the starter template in its place.
- Migrate custom agent descriptions, and copy custom agent `prompt_file`
  prompts into `.weave/prompts/` instead of emitting agents without a prompt.
- `weave validate` reports agents that harness adapters cannot register.

## 0.1.0

### Minor Changes

- Add the Claude Code adapter and compose command.

### Patch Changes

- Normalize in-memory CLI test paths consistently on Windows.
- Rename the npm scope from `@weave` to `@weaveio` and add the publish pipeline.
