# OpenCode Adapter

`@weaveio/weave-adapter-opencode` is Weave's runtime OpenCode plugin. It loads normalized `.weave` configuration and translates it into OpenCode agents, commands, tools, and explicit runtime command projections.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Capabilities](../reference/adapter-capabilities.md) · [Package README](../../packages/adapters/opencode/README.md)

---

## Ownership

The adapter owns the OpenCode config hook, config shape, tool and command names, harness model and skill discovery, and the mapping from explicit runtime commands to engine lifecycle inputs.

The engine owns normalized descriptors, prompt composition, model and skill intent, policy decisions, workflow state, and lifecycle transitions.

## Installation

Pin the full package version in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@weaveio/weave-adapter-opencode@0.0.1"]
}
```

OpenCode fetches the package. Do not add a separate workspace dependency.

For local development, build the adapter and use an absolute file URL to `packages/adapters/opencode/dist/plugin.js`. See the [package README](../../packages/adapters/opencode/README.md) for an isolated validation environment.

## Materialization

The config hook:

1. loads builtin, global, and trusted project `.weave` layers;
2. materializes descriptors in plan order;
3. resolves each descriptor against the adapter's startup fallback context;
4. maps each valid descriptor to an OpenCode agent;
5. reports descriptor failures without inventing fallback intent;
6. injects only names that are absent from `cfg.agent`.

The hook never calls the OpenCode SDK or a persistence API. It leaves every existing same-name entry unchanged, including entries with copied Weave-looking metadata. It sets `default_agent` to `loom` only when it inserts Loom itself. Agent materialization and primary-agent selection are degraded when a same-name entry blocks projection.

Category shuttles remain ordinary normalized descriptors, routed by their description and ordered trigger strings. Categories have no file patterns, so the adapter performs no deterministic file routing. The adapter never reparses DSL intent or builds prompts itself.

## Provider acceleration is unsupported

A descriptor's `fast true` is neutral intent. OpenCode's plugin surface can mutate a request through `chat.params` and `chat.headers`, but its public plugin event and assistant-message contracts expose no correlated official response-body proof — no OpenAI `service_tier` and no Anthropic `usage.speed` — for a successful call. A successful status, error data, or ordinary token usage is not evidence.

The adapter therefore sends no acceleration control and mutates no request option or header. `provider-fast-activation` declares `unsupported` with runtime status `unsupported` and the bounded reason `response-proof-unavailable`. Materialized agent configuration is never presented as evidence of acceleration.

This is an optional-capability gap: it warns and never blocks descriptor materialization, agent mapping, commands, or lifecycle. Raising OpenCode above `unsupported` requires a plugin contract that exposes correlated official response-body evidence for the same attempt, plus real-harness proof under [Adapter Verification](../testing/adapter-verification.md). Mocked unit coverage is not that proof.

## Commands and execution

OpenCode exposes `/weave:start` and `/start-work` as foreground plan-entry commands. `/start-work` is a compatibility alias for `/weave:start` and is behavior-identical. Durable execution uses explicit engine lifecycle operations where the adapter declares the required effective capabilities. The plugin has no event-driven materialization hook; ordinary chat and passive events do not start work.

## Logging

Plugin logs go to `.weave/weave.log` by default so structured JSON does not appear in the OpenCode UI. `WEAVE_LOG_FILE` overrides the path. Outside the plugin, the engine logger uses its normal sink.

## Verification

Use `opencode debug config` to confirm the generated agent map and `opencode debug info` to confirm plugin execution. Unit and integration tests must mock OpenCode boundaries rather than launch a real harness.
