# OpenCode Adapter

`@weaveio/weave-adapter-opencode` is Weave's runtime OpenCode plugin. It loads normalized `.weave` configuration and translates it into OpenCode agents, prompt-based commands, and tools. Its `RuntimeCommandProjection` remains a library surface for explicit callers, not a live plugin entrypoint.

**Related:** [Adapter Boundary](../architecture/adapter-boundary.md) · [Adapter Capabilities](../reference/adapter-capabilities.md) · [Package README](../../packages/adapters/opencode/README.md)

---

## Ownership

The adapter owns the OpenCode config hook, config shape, tool and prompt-command names, harness model and skill discovery, and the library mapping from explicit runtime commands to engine lifecycle inputs.

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
2. materializes descriptors in plan order;
3. resolves each descriptor against the adapter's startup fallback context;
4. maps each valid descriptor to an OpenCode agent;
5. reports descriptor failures without inventing fallback intent;
6. injects only names that are absent from `cfg.agent`.

The hook never calls the OpenCode SDK or a persistence API. It leaves every existing same-name entry unchanged, including entries with copied Weave-looking metadata. It sets `default_agent` to `loom` only when it inserts Loom itself. Agent materialization and primary-agent selection are degraded when a same-name entry blocks projection.

Command registration uses the same trusted config-hook contract. OpenCode has already parsed user JSON/JSONC into ordinary config records; the adapter does not attempt to detect arbitrary JavaScript proxies or prove ownership with reflection. The hook registers Weave's prompt-based commands only when this invocation inserts `tapestry`. A pre-existing or skipped `tapestry`, including a descriptor that failed materialization, cannot become a command target. When `tapestry` is inserted, `start-work` and `weave:start` are checked independently: an existing own command entry is preserved as the exact object with all nested fields unchanged, while an absent name receives the Weave prompt template. No rollback or cross-process durable-ownership claim is made. Agent, primary-agent, and delegated-specialist readiness remain degraded when the host contract cannot prove durable ownership across processes.

Category shuttles remain ordinary normalized descriptors, routed by their description and ordered trigger strings. Categories have no file patterns, so the adapter performs no deterministic file routing. The adapter never reparses DSL intent or builds prompts itself.

## Provider acceleration is unsupported

A descriptor's `fast true` is neutral intent. OpenCode's plugin surface can mutate a request through `chat.params` and `chat.headers`, but its public plugin event and assistant-message contracts expose no correlated official response-body proof — no OpenAI `service_tier` and no Anthropic `usage.speed` — for a successful call. A successful status, error data, or ordinary token usage is not evidence.

The adapter therefore sends no acceleration control and mutates no request option or header. `provider-fast-activation` declares `unsupported` with runtime status `unsupported` and the bounded reason `response-proof-unavailable`. Materialized agent configuration is never presented as evidence of acceleration.

This is an optional-capability gap: it warns and never blocks descriptor materialization, agent mapping, commands, or lifecycle. Raising OpenCode above `unsupported` requires a plugin contract that exposes correlated official response-body evidence for the same attempt, plus real-harness proof under [Adapter Verification](../testing/adapter-verification.md). Mocked unit coverage is not that proof.

## Commands and execution

OpenCode exposes `/weave:start` and `/start-work` as prompt-based plan-entry commands. `/start-work` is a compatibility alias for `/weave:start` and is behavior-identical. The plugin registers either command only after it inserts `tapestry` in this config-hook invocation; it never overwrites a pre-existing command, and one colliding name does not block the other absent name. If Tapestry is missing, skipped, collides, or fails materialization, neither Weave command is added. The command prompt requires an explicit user plan argument, asks the user to select one when the argument is absent, and validates a named plan through the repository tools and files available in the session. `.weave/state.json`, if present, is ordinary repository data; the prompt does not treat it as system-authorized state or claim that it created or resumed work. This plugin does not register `/weave:run` and does not wire the library-only `RuntimeCommandProjection` handlers. The `command-entrypoints` capability is therefore degraded, not a claim of live durable runtime-command delivery. The plugin has no event-driven materialization hook; ordinary chat and passive events do not start work.

## Logging

Plugin logs go to `.weave/weave.log` by default so structured JSON does not appear in the OpenCode UI. `WEAVE_LOG_FILE` overrides the path. Outside the plugin, the engine logger uses its normal sink.

## Verification

Use `opencode debug config` to confirm the generated agent map and `opencode debug info` to confirm plugin execution. Unit and integration tests must mock OpenCode boundaries rather than launch a real harness.
