# @weaveio/weave-adapter-opencode2

OpenCode V2 plugin adapter for the [Weave](https://github.com/weave-io/weave) orchestration framework.

This package is developed and released independently from `@weaveio/weave-adapter-opencode` (V1) —
see [`docs/opencode2-adapter.md`](https://github.com/weave-io/weave/blob/main/docs/opencode2-adapter.md)
for the adapter's design, boundaries, and migration notes.

This is a beta release. The public API may change before `1.0.0`.

## Install

Add the package to the `plugins` array (plural) in the project's
`opencode.jsonc`, or in `~/.config/opencode/opencode.jsonc`:

```json
{
  "plugins": ["@weaveio/weave-adapter-opencode2@0.2.0"]
}
```

OpenCode 2 installs the package when it starts, and the builtin agents appear
once it has loaded, with no `.weave` config needed. Pin the version: before
`0.2.0`, npm `latest` was `0.1.0`, which registers no agents on OpenCode 2.0.x.
`weave init --harness opencode2` writes the same entry.

The native `./server` entry provides catalog-backed agents, native delegation,
config refresh, `/weave:start` execution, and read-only plan RPC including
plan-name listing. The optional `./tui` entry displays plans and owns the
interactive `/weave:start` picker, which calls a Location-bound `start` RPC
that uses the server command executor.
The root `OpenCode2Adapter` facade remains available for compatibility.

See the [current core integration guide](../../../docs/adapters/opencode2-core.md)
for installation and limits, and the [verification procedure](../../../docs/testing/opencode2-verification.md).
This release is built against OpenCode `2.0.16` (`@opencode/cli`) and verified
on `2.0.16` and `2.0.21`. `fast` and delegation
concurrency fields are configuration intent only, not enforced runtime controls.
