# @weaveio/weave-adapter-opencode2

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
