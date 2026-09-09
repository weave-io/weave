# @weaveio/weave-adapter-opencode2

## Unreleased

- Route the native `./server` entry through the catalog-backed core integration.
  Preserve the root `OpenCode2Adapter` facade and the V1 package independently.
- Add config refresh, native foreground/background delegation, and read-only
  plan RPC with an optional Solid TUI contribution.
- Retain the exact `0.0.0-beta-19151` host pin. Root server/RPC/TUI wrappers
  support directory-based plugin loading.
- Accept fast and delegation concurrency configuration intent without claiming
  runtime enforcement. See the [core guide](../../../docs/adapters/opencode2-core.md).

## 0.1.2

Real-CLI Loom check — closes the seam left open by 0.1.1.

- 0.1.1's layer 5 proved Loom materializes and is visible via
  `host.agent.list()` on the *embedded* `OpenCode.create({ plugins })`
  path. The real `opencode2` CLI path was only proven up to
  `setup()`/cleanup via marker files (layer 4); the CLI's own view of
  agents was never asserted.
- New **verify layer 6 — real-CLI agent materialization** closes that
  seam. It reuses the same real-CLI trigger (`opencode2 run hi
  --standalone --print-logs`) but against a new fixture whose
  `plugin-wrapper/server.ts`, after the real adapter's `setup(ctx)`
  resolves, calls `ctx.agent.list()` (envelope-unwrapped per A4) and
  writes the observed agents to a marker JSON file. Layer 6 reads that
  marker and asserts the CLI-observed `loom` entry's description starts
  with the V2-package-local `WEAVE_OWNERSHIP_MARKER`.
- The signal is strictly CLI-side: no embedded `OpenCode.create` host is
  spawned; the observation comes from the exact `ctx` the real V2 loader
  delivered to the plugin subprocess.
- No new dependency on model output — assertions never depend on the
  CLI's response text; the LLM call is only used to trigger project-
  plugin loading (the harness's one sanctioned exception, unchanged
  since 0.1.0 layer 4).
- Layer 5 (embedded materialization) is preserved unchanged. `run.sh`
  now advertises 9 layers total (up from 8) with the JSON summary and
  numbering updated accordingly.
- New fixture `verify/fixtures-layer6/` (sibling of `verify/fixtures/`,
  intentionally outside it to avoid the real V2 CLI's ancestor-config
  plugin merging picking up the layer-4 wrapper) — its own
  `opencode.jsonc`, `plugin-wrapper/server.ts` (extended with a single
  post-`setup` `ctx.agent.list()` call and a `location.marker.json`
  probe for the learnings writeup), and an empty
  `.weave/config.weave`.

## 0.1.1

Agent materialization wired into `Plugin.define({ setup })`.

- `setupWeavePlugin(facade, options?)` now loads the Weave config from the
  resolved project directory (via `@weaveio/weave-config`'s `loadConfig`),
  composes descriptors via `@weaveio/weave-engine`'s `materializeAgents`, and
  calls `adapter.spawnSubagent(descriptor)` for every plan agent — so Loom
  and the other built-in agents are now visible in a running `opencode2`
  instance the moment the plugin activates.
- Injection points: `SetupWeavePluginOptions` accepts `directory`,
  `loadConfig`, and `materializeAgents` overrides so unit tests can drive
  the setup path against `MockPluginContext` without touching the disk or
  the real engine.
- `Plugin.define({ setup })` reads the project directory from
  `ctx.location.directory` (V2's `Location.Info` shape).
- Failure paths degrade gracefully: a failing `loadConfig` logs at
  info-level and skips materialization; per-agent `spawnSubagent` failures
  are logged with `{ agent, err }` context and never abort the loop.
- Verify harness: new **layer 5 — agent-materialization** in
  `verify/run.sh` and `verify/container-smoke.ts` asserts that after
  `OpenCode.create({ plugins: [weavePlugin] }).plugin.awaitActivation()`,
  `host.agent.list()` reports a `loom` entry whose description begins with
  the V2-package-local `WEAVE_OWNERSHIP_MARKER` (now re-exported from the
  package's `./server` subpath alongside the plugin default).
- New fixture `verify/fixtures/agent-materialization/.weave/config.weave`
  provides the minimum config needed to compose the built-in Loom agent.

## 0.1.0

Initial beta release of the independent OpenCode V2 adapter package.
