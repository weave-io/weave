# @weaveio/weave-adapter-opencode2

## 0.2.0

First stable release for OpenCode 2. Add
`"plugins": ["@weaveio/weave-adapter-opencode2@0.2.0"]` to `opencode.jsonc`;
OpenCode 2 installs it on start, and the builtin agents load with no `.weave`
config. `npm latest` was `0.1.0`, which registers no agents on OpenCode
2.0.x. Verified on `@opencode/cli` 2.0.16 and 2.0.21.

- A partial or partly broken `.weave` config no longer registers zero agents.
  An agent whose `prompt_file` cannot be read is left out on its own and
  `status` names it (`materialization_failed`); before, one missing file failed
  the whole catalog. A config that does not parse or validate still loads
  nothing, but `status` now reports `config_invalid` and the plan panel says
  "Weave config is invalid; run `weave validate`" instead of only "refresh
  failed". Creating or fixing the missing prompt file brings the agent back on
  the next refresh.

- A Weave agent now runs on its configured model even when the client selects
  none. OpenCode 2 runs a turn on the session's model and falls back to the
  host default, not the agent's model, so `opencode2 run` without `-m` (and API
  clients) ran Loom and Tapestry on the host default. When a session has no
  model and its agent is Weave's, the prompt hook now selects that agent's
  model. A session started without an agent resolves to the host's default
  agent. A model the user chose is never replaced, and the TUI already
  selected the agent's model itself.

- The builtin agents default to the models GitHub Copilot offers, and an
  OpenCode 2 host signed in to Copilot now selects them: Loom, Tapestry and
  Pattern on `claude-opus-5.5`, Weft and Warp on `gpt-6-sol`, Shuttle on
  `claude-sonnet-5.5`, Spindle on `gpt-6-luna` and Thread on
  `claude-haiku-4.5`. Copilot spells Claude versions with a dot, and the
  defaults used only Anthropic's dashed spelling, so on Copilot Loom,
  Tapestry and Pattern ran on `gpt-6-sol` and Thread on `gpt-6-luna`. Each
  Claude model is now listed in both spellings, Copilot's first.

- An agent-level `variant` the selected model does not offer no longer costs
  the agent its model. `variant none` on a Claude model (Claude models offer no
  `none` variant, GPT models do) rejected every entry, so the agent fell to a
  builtin fallback model or to no model at all, and a subagent then ran on its
  parent's model. The agent now keeps the model it names, runs without the
  variant, and `status` reports a `variant_unavailable` issue. A `#variant`
  written on a model entry still has to exist for that entry to be used.
- New sessions start on Loom. `defaultAgent` now defaults to `loom`, so a
  plugin entry without options no longer leaves OpenCode 2 on `build`. Your
  own `default_agent` in the OpenCode config still wins, because OpenCode
  applies it after every package plugin. If another plugin holds `loom`, or
  Loom is not registered, Weave sets no default.

- Delegation: Loom and Tapestry are offered only agents that reached the host.
  The catalog build reads OpenCode's agent list and reports Weave agents whose
  id another plugin already holds (for example `shuttle-web`) as `name_taken`;
  those, and categories whose prompt failed to compose, are left out of the
  delegation targets and logged at warn. The held set is part of the catalog
  revision. See [ADR 0013](../../../docs/adr/0013-delegation-targets-from-materialized-agents.md).

- Target OpenCode `2.0.16` (`@opencode/cli`) instead of the `0.0.0-beta-19151` pin.
  The host renamed its packages to the `@opencode/*` scope and, from 2.0.4,
  removed the `ctx.catalog` plugin domain in favour of `ctx.model` and
  `ctx.provider`. On 2.0.4+ the previous release activated but silently
  registered no agents and no `/weave:start` command because
  `ctx.catalog.model.list()` threw before the catalog was built. The adapter
  now reads models through `ctx.model.list()`, listens for `model.updated`
  instead of `catalog.updated`, applies temperature through the session
  context `options` field, and no longer expects a `workspaceID` on session
  location refs.
- Port the Podman verify harness to the 2.0.x host: `host.plugin.awaitActivation()`
  no longer exists, so activation is observed through `plugin.list()` state;
  the layer-5 fixture moves to `verify/fixtures-layer5` because the host now
  rejects the duplicate plugin ID it inherited from the ancestor config;
  fixtures raise the proof model context limit so the run no longer trips
  automatic compaction; the `opencode` binary check accepts the V2 host
  (`@opencode/cli` links both `opencode` and `opencode2`); and the standalone
  cleanup marker is reported rather than asserted because the 2.0.x CLI
  terminates its standalone server with SIGTERM before plugin cleanup runs.

- Windows: plan reads no longer depend on the POSIX `test`/`realpath` binaries.
  `listPlanNames` and `@weaveio/weave-config`'s `BunPlanTaskFileReader` now use
  `node:fs`, so `/weave:start` no longer answers "Weave could not list plans"
  (or "missing, invalid, or unavailable") on hosts launched outside a POSIX
  shell. The started plan is stored with the normalized scope directory so the
  plan RPC no longer rejects it as another Location on native `C:\` paths,
  and `projectConfig: false` now matches the project config path on Windows.

- TUI: the plan panel read theme tokens that 2.0.x renamed (`text.status.running`,
  `text.subdued`, `feedback.*.default`), which crashed the `weave.tui` plugin in
  the composer slot. It now uses `text.feedback.*.base`, `text.feedback.info.base`
  and `text.muted`, and `@opencode/theme` is a dev dependency so the TUI code is
  typechecked against the real theme shape.

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
