# @weaveio/weave-adapter-opencode

## Unreleased

### Changed

- Replace the live plugin entry with the native OpenCode 2 `Plugin.define` ABI
  pinned to host `0.0.0-beta-19086`.
- Keep legacy SDK library helpers while adding separate server, RPC, and Solid
  TUI package entries.

### Added

- Location-scoped agent materialization, live model/variant and skill matching,
  native tool policy, last-valid refresh, bounded health RPC, `/weave:start`,
  read-only plan progress, and native subagent routing.

### Known limits

- The reserved `/weave:start` name can replace a same-name foreign command on
  the pinned host.
- Configured available skills attach without native prompt-admission permission
  validation.
- Durable workflows and other documented follow-ups are not part of this
  release.

## 0.1.0

### Minor Changes

- Align all packages to v0.1.0 for the initial public release.

### Patch Changes

- Rename the npm scope from `@weave` to `@weaveio` and add the publish pipeline.
