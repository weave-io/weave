# OpenCode V2 Adapter — User Guide

`@weaveio/weave-adapter-opencode2` is the Weave adapter for **OpenCode V2** — the `opencode2` binary and its `@opencode-ai/plugin` / `@opencode-ai/sdk` / `@opencode-ai/client` / `@opencode-ai/cli` package family. This guide covers installation, configuration, and the abstract-tool-policy-to-V2-permission mapping for users targeting OpenCode V2.

## Independence note

This adapter is a **separate, independent package** with no relation to any other OpenCode adapter beyond consuming the public harness-neutral Weave packages (`@weaveio/weave-core`, `@weaveio/weave-config`, `@weaveio/weave-engine`). It does not share source, types, ownership markers, or runtime state with any other adapter. **There is no auto-selection between adapters** — you explicitly choose this adapter by adding it to your `opencode.jsonc` `plugins` array (or by embedding it via `OpenCode.create`), regardless of what other OpenCode-targeting adapters may also be installed on your machine.

For the normative design and full rationale, see:

- [Spec 34: OpenCode V2 Adapter (Independent Package)](specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md)
- [ADR 0010: OpenCode V2 Adapter as a Separate Independent Package with Transform-Based Reconciliation](adr/0010-opencode2-independent-adapter.md)

## Install

**Current native runtime:** `./server` now loads the catalog-backed core
integration described in the [V2 core guide](adapters/opencode2-core.md).
Use that guide for plugin options, native commands, model selection, skill
attachment, RPC, UI, and current limits. The `OpenCode2Adapter` class and the
older plugin module remain compatibility surfaces; the facade-specific
behavior described below does not select the native server implementation.
Both implementations remain inside this V2 package. V1 is unchanged.

```bash
bun add @weaveio/weave-adapter-opencode2
```

## Usage mode 1 — live plugin via `opencode.jsonc`

Add the adapter's `./server` subpath export to your project's `opencode.jsonc` `plugins` array. This is the entry point the real V2 plugin loader (`ConfigPluginSource.scan()`) accepts — it only resolves `plugins` entries that point at a directory containing a `server.ts`/`index.ts` entry point, not a bare file.

```jsonc
{
  "plugins": ["@weaveio/weave-adapter-opencode2/server"]
}
```

With this in place, running `opencode2 run "<message>" --standalone` (or the interactive TUI) loads the plugin and reconciles your `.weave` config's agents into OpenCode V2 via `ctx.agent.transform`.

## Usage mode 2 — embedded via `OpenCode.create`

For scripts, tests, or tooling that want to drive an OpenCode V2 host programmatically without a config file, import the same plugin entry point and pass it directly to `OpenCode.create`:

```ts
import { OpenCode } from "@opencode-ai/sdk";
import weavePlugin from "@weaveio/weave-adapter-opencode2/server";

const host = await OpenCode.create({ plugins: [weavePlugin] });

// Plugins are registered lazily by the PluginSupervisor and are not
// guaranteed to have run setup() by the time create() resolves.
// awaitActivation() blocks until this plugin's setup effects
// (e.g. agent transforms) are visible.
await host.plugin.awaitActivation();

// ... use host.client / host.plugin / other SDK surfaces here ...

await host.close();
```

Both usage modes load the exact same adapter code — only the invocation surface differs. Neither mode implies or requires the other.

## Configuration

The adapter reads the same `.weave` config that any other Weave adapter reads (project `.weave/config.weave`, merged with global `~/.weave/config.weave`). No V2-specific `.weave` DSL fields are required. Abstract `tool_policy` blocks on your agents are translated into V2's ordered `permissions: Rule[]` array — see the mapping table below.

## Permission mapping table

OpenCode V2 represents an agent's permissions as an **ordered array** of `Rule` values — not a singular `permission` field, and not a `tools` denial map. Rules are evaluated **last-match-wins**: later entries override earlier ones for overlapping scope.

Weave's abstract `tool_policy` has five dimensions (`read`, `write`, `execute`, `delegate`, `network`), each with three possible values (`allow`, `deny`, `ask`). The adapter maps every one of the 15 possible cells to a V2 `Rule`:

| Dimension | `allow` | `deny` | `ask` |
| --- | --- | --- | --- |
| `read` | Emits a permissive `Rule` scoped to read-oriented V2 tool/action categories (file read, search, list). | Emits a denying `Rule` scoped to the same read-oriented categories. | Emits an ask-mode `Rule` scoped to the same read-oriented categories, requiring interactive confirmation in harnesses that support it. |
| `write` | Emits a permissive `Rule` scoped to write-oriented categories (file write, edit, create, delete). | Emits a denying `Rule` scoped to the same write-oriented categories. | Emits an ask-mode `Rule` scoped to the same write-oriented categories. |
| `execute` | Emits a permissive `Rule` scoped to shell/process-execution categories. | Emits a denying `Rule` scoped to the same execution categories. | Emits an ask-mode `Rule` scoped to the same execution categories. |
| `delegate` | Emits a permissive `Rule` scoped to subagent/delegation-invocation categories. | Emits a denying `Rule` scoped to the same delegation categories. | Emits an ask-mode `Rule` scoped to the same delegation categories. |
| `network` | Emits a permissive `Rule` scoped to outbound-network-capable categories (fetch, webfetch-equivalent). | Emits a denying `Rule` scoped to the same network categories. | Emits an ask-mode `Rule` scoped to the same network categories. |

Rules are emitted in a stable, documented order (`read`, `write`, `execute`, `delegate`, `network`), so if you or another plugin append further overrides after this adapter runs, last-match-wins semantics stay predictable. See [Spec 34, Section 4](specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md#4-abstract-tool-policy--v2-permissions-rule-mapping) for the full normative mapping and testing requirements.

## Verification

To confirm the plugin loaded correctly in live-plugin mode:

- `opencode2 debug agents` after a `run --standalone` invocation should list your `.weave`-declared agents, each carrying the adapter's ownership marker in its description.
- `opencode2 plugin list` reflects registered plugins (note: this command does not itself trigger project-plugin loading — use `run --standalone` or the interactive TUI to exercise the full path).

In embedded mode, after `awaitActivation()` resolves, call `host.client` RPC methods such as `agent.list` (unwrap the `{ location, data }` envelope) to confirm your agents are present.

## Troubleshooting

- **Plugin doesn't seem to load**: confirm the `plugins` entry points at the package subpath (`@weaveio/weave-adapter-opencode2/server`), not a bare file — the V2 loader only accepts a resolvable directory entry point.
- **Agents missing right after `OpenCode.create()`**: transforms are applied lazily; call `await host.plugin.awaitActivation()` before inspecting agent state.
- **Command that "should" trigger plugin loading does nothing**: only `run --standalone` and the interactive TUI trigger project-plugin loading; `serve`, `models`, `debug agents`, and `plugin list` do not load plugins themselves (though `debug agents` can be used afterward to inspect state from a prior `run`).

## Cross-references

- [Spec 34: OpenCode V2 Adapter (Independent Package)](specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md) — normative design, full permission mapping, reconciliation semantics, and testing requirements.
- [ADR 0010: OpenCode V2 Adapter as a Separate Independent Package with Transform-Based Reconciliation](adr/0010-opencode2-independent-adapter.md) — the decision record for packaging, lifecycle, and reconciliation-model questions.
