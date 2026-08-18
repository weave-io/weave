# OpenCode Adapter

`@weaveio/weave-adapter-opencode` is Weave's runtime OpenCode plugin. It loads normalized `.weave` configuration and translates it into OpenCode agents, commands, tools, and lifecycle behavior.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Capabilities](../reference/adapter-capabilities.md) · [Package README](../../packages/adapters/opencode/README.md)

---

## Ownership

The adapter owns OpenCode plugin hooks, config shape, tool and command names, harness model and skill discovery, and all mapping between OpenCode events and engine lifecycle inputs.

The engine owns normalized descriptors, prompt composition, model and skill intent, policy decisions, workflow state, and lifecycle transitions.

## Installation

Add the package name to the `plugin` array in `opencode.json` or
`opencode.jsonc`:

```json
{
  "plugin": [
    "@weaveio/weave-adapter-opencode@<exact-version>"
  ]
}
```

The package name is the canonical OpenCode plugin spec. OpenCode resolves the
package's `server` export to `dist/plugin.js`; do not point the plugin at the
library bundle (`dist/index.js`) or at a source file. Use an exact version for
reproducible installs. The package also supports the `latest`, `next`, and
`nightly` npm channel tags when you explicitly want a mutable channel.

OpenCode fetches the package at startup. There is no separate `npm install`
step. Restart OpenCode after changing the plugin version. For local
development, build the adapter and use an absolute file URL to
`packages/adapters/opencode/dist/plugin.js`. See the [package
README](../../packages/adapters/opencode/README.md) for an isolated validation
environment.

## Release channels and host support

The adapter is published on `latest` (stable), `next`, and `nightly`. Its
package declares `@opencode-ai/plugin` and `@opencode-ai/sdk` `~1.15.9`; no
separate OpenCode version floor is encoded. Use an OpenCode release compatible
with those APIs.

## Materialization

The config hook:

1. loads builtin, global, and trusted project `.weave` layers;
2. asks OpenCode for harness-owned model and skill context;
3. materializes descriptors in plan order;
4. maps each valid descriptor to an OpenCode agent;
5. reports descriptor failures without inventing fallback intent.

Category shuttles remain ordinary normalized descriptors, routed by their description and ordered trigger strings. Categories have no file patterns, so the adapter performs no deterministic file routing. The adapter never reparses DSL intent or builds prompts itself.

## Provider acceleration is unsupported

A descriptor's `fast true` is neutral intent. OpenCode's plugin surface can mutate a request through `chat.params` and `chat.headers`, but its public plugin event and assistant-message contracts expose no correlated official response-body proof — no OpenAI `service_tier` and no Anthropic `usage.speed` — for a successful call. A successful status, error data, or ordinary token usage is not evidence.

The adapter therefore sends no acceleration control and mutates no request option or header. `provider-fast-activation` declares `unsupported` with runtime status `unsupported` and the bounded reason `response-proof-unavailable`. Materialized agent configuration is never presented as evidence of acceleration.

This is an optional-capability gap: it warns and never blocks descriptor materialization, agent mapping, commands, or lifecycle. Raising OpenCode above `unsupported` requires a plugin contract that exposes correlated official response-body evidence for the same attempt, plus real-harness proof under [Adapter Verification](../testing/adapter-verification.md). Mocked unit coverage is not that proof.

## Commands and execution

OpenCode exposes `/weave:start` and `/start-work` as foreground plan-entry commands. `/start-work` is a compatibility alias for `/weave:start` and is behavior-identical. Durable execution uses explicit engine lifecycle operations where the adapter declares the required effective capabilities. Ordinary chat and passive hooks do not start work.

## Logging

Plugin logs go to `.weave/weave.log` by default so structured JSON does not appear in the OpenCode UI. `WEAVE_LOG_FILE` overrides the path. Outside the plugin, the engine logger uses its normal sink.

## Verification

Use `opencode debug config` to confirm the generated agent map and `opencode debug info` to confirm plugin execution. Unit and integration tests must mock OpenCode boundaries rather than launch a real harness.
