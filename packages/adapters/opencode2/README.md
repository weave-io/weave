# @weaveio/weave-adapter-opencode2

OpenCode V2 plugin adapter for the [Weave](https://github.com/weave-io/weave) orchestration framework.

This package is developed and released independently from `@weaveio/weave-adapter-opencode` (V1) —
see [`docs/opencode2-adapter.md`](https://github.com/weave-io/weave/blob/main/docs/opencode2-adapter.md)
for the adapter's design, boundaries, and migration notes.

This is a beta release. The public API may change before `1.0.0`.

The native `./server` entry provides catalog-backed agents, native delegation,
config refresh, and read-only plan RPC. The optional `./tui` entry displays plans.
The root `OpenCode2Adapter` facade remains available for compatibility.

See the [current core integration guide](../../../docs/adapters/opencode2-core.md)
for installation and limits, and the [verification procedure](../../../docs/testing/opencode2-verification.md).
This release targets OpenCode `0.0.0-beta-19151`. `fast` and delegation
concurrency fields are configuration intent only, not enforced runtime controls.
