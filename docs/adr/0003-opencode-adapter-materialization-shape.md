# ADR 0003: OpenCode Adapter Materialization Shape

**Status**: Accepted (amended)
**Date**: 2026-05-26
**Related**: [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Capabilities](../reference/adapter-capabilities.md) · [OpenCode Adapter](../adapters/opencode.md) · [ADR 0001 — Prompt Composition Templates](0001-prompt-composition-templates.md) · [ADR 0002 — Runtime Persistence Store](0002-runtime-persistence-store.md)

## Context

Weave's OpenCode adapter loads normalized `.weave` configuration and projects it into OpenCode's configuration. OpenCode calls a plugin's `config` hook while it assembles that configuration. The hook is the reliable boundary for startup materialization and for `opencode debug config`.

An earlier design also wrapped the OpenCode SDK and attempted to list, create, and update agents after startup. OpenCode exposes no trusted Weave ownership authority for an existing agent. A description marker or copied metadata cannot authorize an overwrite. The SDK path therefore added a second, non-authoritative materialization path and could not safely distinguish a user entry from a Weave entry. The adapter does not need that path: the config hook already receives the config that OpenCode will use.

The adapter must also keep abstract Weave policy separate from OpenCode names. OpenCode's permission schema has named rules for `read`, `glob`, `grep`, `list`, and `task`; the legacy boolean `tools` map cannot represent `ask`.

The config-hook argument is a trusted harness boundary, not a general JavaScript object-sanitization API. OpenCode has already parsed user JSON/JSONC into ordinary configuration records before it calls the hook. The adapter relies on that contract and does not attempt to identify arbitrary proxies, reflection traps, or other values supplied outside the OpenCode contract.

## Decision

### 1. Config-hook-only materialization

`@weaveio/weave-adapter-opencode` is an OpenCode plugin. The plugin:

1. loads Weave config from `input.directory`;
2. materializes normalized descriptors through the engine;
3. resolves and translates each descriptor without SDK calls;
4. returns a `config` hook that projects the translated entries into `cfg.agent` and registers the real Weave slash commands.

The plugin has no event hook for agent materialization. It does not call an SDK client or a persistence API. This makes `opencode debug config` and a live startup use the same path.

Install the plugin through the `./server` subpath or the package's documented plugin entry. The plugin subpath exports only callable values so OpenCode's legacy loader can load it.

### 2. Trusted-boundary same-name handling

The config hook treats every existing own `cfg.agent[name]` entry as user-owned. It skips that name without reading, merging, tagging, or replacing the value. This preserves the entry's exact object identity and shape. The same rule applies to `cfg.command[name]`.

The hook does not inspect descriptions, `options`, or other metadata. A copied Weave-looking marker never grants overwrite authority. If this invocation inserts `loom`, it sets `default_agent` to `loom`; a pre-existing `loom` entry is unchanged and does not cause that selection.

Agent materialization and primary-agent selection are degraded because the config hook does not establish durable ownership across processes. Users can rename a Weave agent or remove a conflicting OpenCode entry before startup. Delegated-specialist readiness has the same limitation.

Command registration uses the trusted parsed-record contract. The hook registers the prompt-based `start-work` and `weave:start` templates only when this invocation inserts `tapestry`. A pre-existing, missing, skipped, or failed Tapestry descriptor cannot become a command target. After Tapestry is inserted, each command name is checked independently: an existing command object remains unchanged, including nested fields, while an absent name receives the Weave-owned prompt command. A collision for one name does not prevent registration of the other absent name. The implementation makes no partial-write rollback or cross-process durable-ownership claim.

The command templates are prompt-only. They require the user to provide a plan argument or ask the user to select one when it is absent. Tapestry must validate a named plan through the repository tools and files available in the session. `.weave/state.json`, if present, is ordinary repository data; it is not system-authorized state and does not prove plan selection, authentication, creation, or resumption. The plugin does not invent or wire a runtime handler.

### 3. Translation-only adapter boundary

`OpenCodeAdapter` translates descriptors for explicit runtime command projections and keeps an in-memory `translatedAgents` snapshot for those callers. `spawnSubagent()` does not register or update a live OpenCode resource. `OpenCodeAdapterOptions` contains project, model-context, and harness-skill inputs only; it has no client option.

OpenCode SDK types used by the adapter remain local to `sdk-types.ts`. The removed SDK facade and reconciliation modules were not needed by the live plugin path. Their former package-root exports are removed as a breaking public-surface change and are covered by a changeset.

### 4. Exact permission projection

`tool-policy-mapping.ts` is the only place that maps abstract Weave capabilities to OpenCode permission names:

- `read` maps to `permission.read`;
- `read` also maps to `permission.glob`, `permission.grep`, and `permission.list`;
- `write` maps to `permission.edit`;
- `execute` maps to `permission.bash`;
- `delegate` maps to `permission.task`;
- `network` maps to `permission.webfetch`.

Each read field preserves `allow`, `deny`, and `ask` exactly. The adapter never omits `ask` and never uses the boolean `tools` map for read policy. Delegation uses `task`, not `doom_loop`.

## Consequences

- Startup config materialization is deterministic and has one live path.
- Existing same-name entries cannot be overwritten, even when their metadata looks like Weave metadata.
- Loom becomes the default only when this hook inserted Loom itself.
- SDK list/create/update calls, the no-op event path, and their facade types are gone.
- Agent materialization, primary-agent selection, and delegated-specialist execution remain degraded because the trusted config hook does not prove durable ownership across processes; exact permission mapping remains native.
- The plugin's only live slash commands are prompt-based `start-work` and `weave:start`; `/weave:run` is not registered.
- The prompt commands require explicit plan input or user selection and repository-file validation. They do not treat `.weave/state.json` as system-authorized state or claim to create/resume work.
- `RuntimeCommandProjection` remains an adapter-library surface for explicit callers, not a live OpenCode command handler. Passive events do not start workflow execution, and command-entrypoint readiness remains degraded until a live runtime delivery path exists.

## References

- [`packages/adapters/opencode/src/plugin.ts`](../../packages/adapters/opencode/src/plugin.ts) — config-hook plugin entry point.
- [`packages/adapters/opencode/src/adapter.ts`](../../packages/adapters/opencode/src/adapter.ts) — translation-only adapter.
- [`packages/adapters/opencode/src/sdk-types.ts`](../../packages/adapters/opencode/src/sdk-types.ts) — local SDK type boundary.
- [`packages/adapters/opencode/src/tool-policy-mapping.ts`](../../packages/adapters/opencode/src/tool-policy-mapping.ts) — exact permission mapping.
- [`packages/adapters/opencode/src/translate-agent.ts`](../../packages/adapters/opencode/src/translate-agent.ts) — descriptor translation.
- [OpenCode Adapter](../adapters/opencode.md) — current runtime contract.
- [Adapter Boundary](../architecture/adapter-boundary.md) — ownership rules.
