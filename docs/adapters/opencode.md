# OpenCode Adapter

`@weaveio/weave-adapter-opencode` is Weave's runtime OpenCode plugin. It loads normalized `.weave` configuration and translates it into OpenCode agents, commands, tools, and lifecycle behavior.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Capabilities](../reference/adapter-capabilities.md) · [Package README](../../packages/adapters/opencode/README.md)

---

## Ownership

The adapter owns OpenCode plugin hooks, config shape, tool and command names, harness model and skill discovery, and all mapping between OpenCode events and engine lifecycle inputs.

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
2. asks OpenCode for harness-owned model and skill context;
3. materializes descriptors in plan order;
4. maps each valid descriptor to an OpenCode agent;
5. reports descriptor failures without inventing fallback intent.

Category shuttles remain ordinary normalized descriptors. The adapter never reparses DSL intent or builds prompts itself.

## Commands and execution

OpenCode exposes `/weave:start` and `/start-work` as foreground plan-entry commands. `/start-work` is a compatibility alias for `/weave:start` and is behavior-identical. Durable execution uses explicit engine lifecycle operations where the adapter declares the required effective capabilities. Ordinary chat and passive hooks do not start work.

## Logging

Plugin logs go to `.weave/weave.log` by default so structured JSON does not appear in the OpenCode UI. `WEAVE_LOG_FILE` overrides the path. Outside the plugin, the engine logger uses its normal sink.

## Verification

Use `opencode debug config` to confirm the generated agent map and `opencode debug info` to confirm plugin execution. Unit and integration tests must mock OpenCode boundaries rather than launch a real harness.
