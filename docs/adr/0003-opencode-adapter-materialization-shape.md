# ADR 0003: OpenCode Adapter Materialization Shape

**Status**: Accepted  
**Date**: 2026-05-26  
**Related**: [Adapter Boundary](../adapter-boundary.md) · [Adapter Readiness Status](../adapter-readiness-status.md) · [Spec 20 — OpenCode Adapter Materialization](../specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) · [ADR 0001 — Prompt Composition Templates](0001-prompt-composition-templates.md) · [ADR 0002 — Runtime Persistence Store](0002-runtime-persistence-store.md) · [Legacy Architecture](../legacy-architecture.md)

---

## Context

Weave's `@weave/adapter-opencode` package needed to evolve from a translation-only stub (that populated an in-memory map but made no SDK calls) into a real first-slice materialization path that registers Weave-authored agents into a running OpenCode instance.

Four design questions had to be answered before implementation could proceed:

1. **How does the adapter reach the OpenCode runtime?** OpenCode exposes a plugin API (`@opencode-ai/plugin`) and an SDK client (`@opencode-ai/sdk`). The adapter could either embed its own SDK client construction or accept an injected client from the plugin host.

2. **Where does model discovery live?** The engine owns the abstract `resolveAdapterModelIntent()` helper, but only the adapter knows which models are available in the current OpenCode instance.

3. **Where does skill discovery live?** The engine owns skill matching/filtering, but only the OpenCode harness knows which skills are installed and where they live.

4. **How does the adapter write agents safely?** OpenCode has no separate create/update agent endpoint — both operations are expressed as a `config.update()` patch. The adapter must distinguish Weave-managed agents from manually created ones to avoid silent overwrites.

The reference implementation in `~/projects/opencode-weave` (the legacy alpha) showed the plugin install/runtime story: users add the package to `opencode.json`'s `plugin` array, OpenCode loads it at startup, and the plugin entry point receives a runtime context with an SDK client already constructed.

---

## Decision

### 1. SDK-first, plugin/runtime-first entry path

`@weave/adapter-opencode` is an **OpenCode plugin**. Users install it by adding the package to the `plugin` array in their `opencode.json` config. OpenCode loads the plugin at startup and calls the default-exported `WeavePlugin` function with a runtime context that includes a pre-constructed SDK client.

The package exports a `WeavePlugin` function (and a `server` alias for `PluginModule` compatibility) that:

1. Loads the Weave config from `input.directory` via `loadConfig()`.
2. Calls `materializeAgents()` to compose all agent descriptors.
3. Constructs an `OpenCodeAdapter` with the injected `SdkOpenCodeClient`.
4. Calls `spawnSubagent()` for each descriptor.
5. Returns an empty `Hooks` object — agent materialization is the sole responsibility.

```jsonc
// opencode.json — direct plugin installation
{
  "plugin": ["@weave/adapter-opencode"]
}
```

No user-authored wrapper script is required. The package itself is the plugin entry point.

The `OpenCodeAdapterOptions.client` field is the primary injection point for the SDK client. When omitted, the adapter operates in translation-only mode (no SDK calls), which is useful for config-write-only scenarios and tests that only need translated config snapshots.

### 2. Injected client, adapter-owned SDK facade

All SDK calls flow through the narrow `OpenCodeClientFacade` interface defined in `opencode-client.ts`. This interface exposes only three methods:

- `listAgents()` — wraps `client.app.agents()`
- `createAgent(name, config)` — wraps `client.config.update({ agent: { [name]: config } })`
- `updateAgent(name, config)` — wraps `client.config.update({ agent: { [name]: config } })`

The facade is the **only** place in the adapter that imports SDK types. All other adapter modules import SDK types through `./sdk-types.ts` (re-exports only). This isolates SDK API surface changes to a single file.

`SdkOpenCodeClient` is the production implementation of `OpenCodeClientFacade`. Tests use in-memory mock implementations that satisfy the interface without a live OpenCode process.

### 3. Adapter-owned model resolution with engine helper

Model discovery is adapter-owned. The adapter gathers `OpenCodeModelContext` (available models, UI-selected model, system default) from the OpenCode runtime and passes it to the engine's pure `resolveAdapterModelIntent()` helper. The engine never queries harness state directly.

`model-resolution.ts` adds one adapter-local rule on top of the engine helper: **fail-fast for explicit subagent model intent**. When an agent's `mode` is `"subagent"` and `models` is non-empty, the first declared model must be present in `availableModels`. If it is not, `resolveModelForAgent()` returns `err(ModelNotAvailableError)` rather than falling back silently.

This rule is intentionally strict for subagents: they are typically invoked programmatically with a specific model in mind, and silent fallback would produce unexpected behavior that is hard to debug.

### 4. Harness-owned skill discovery, adapter-forwarded

Skill discovery is harness-owned. The OpenCode SDK/runtime knows which skills are installed and where their files live. The adapter's role is to:

1. Accept the harness-provided `SkillInfo[]` list via `OpenCodeAdapterOptions.availableSkills`.
2. Return it from `loadAvailableSkills()` without any filesystem scanning.
3. Let the engine's `resolveSkillsForAgent()` match declared skill names against the list and emit `MissingSkill` errors for unresolved names.

`skill-discovery.ts` provides only two helpers:
- `buildSkillInfoList(names)` — wraps harness-provided skill names as `SkillInfo[]`.
- `validateDeclaredSkills(declared, available, disabled)` — validates declared names against the harness-provided list; returns `err(string[])` for missing skills.

The module contains no filesystem I/O. When no skills are injected, `loadAvailableSkills()` returns `[]` and the engine hard-errors on any declared skills — no silent skips.

### 5. Ownership-safe upsert via `[weave-managed]` tag

OpenCode has no separate create/update agent endpoint. Both operations write through `client.config.update()` by patching the `agent` map. The adapter must distinguish Weave-managed agents from manually created ones.

The reconciliation flow in `reconcile-agent.ts` is:

```
1. listAgents()       — fetch current agent list from OpenCode
2. find by name       — look for an agent whose name matches descriptor.name
3. ownership check    — if found, verify description contains [weave-managed]
4. create or update   — call createAgent() for new agents, updateAgent() for existing Weave-managed agents
5. collision error    — return CollisionError when a same-named foreign agent is found
```

`descriptor.name` is the **Canonical Agent Name** — the stable harness-neutral internal id used for all matching and durable identity checks. `displayName`, `description`, and other presentation fields are mutable display metadata, not identity.

The `[weave-managed]` ownership tag is embedded in the agent's `description` field. It is:
- Human-readable and visible in the OpenCode UI.
- Idempotent — appended only when not already present.
- Sufficient to distinguish Weave-managed agents without a separate metadata store.

**First-slice constraints (non-goals):**
- No automatic delete, prune, or forced takeover of foreign agents.
- No workflow-lifecycle expansion beyond the existing `run-workflow.ts` helper.
- No engine API drift — the adapter boundary rules in `adapter-boundary.md` are unchanged.

---

## Consequences

### What changes

- `@weave/adapter-opencode` is now a real first-slice materialization path, not a translation-only stub.
- `spawnSubagent(descriptor)` performs the full `list → reconcile → create/update` flow when a client is injected.
- `translatedAgents` is retained as a read-only secondary artifact for test inspection and transitional compatibility; it is not the source of truth.
- `loadAvailableSkills()` returns the harness-injected skill list without filesystem scanning.
- Model resolution fails fast for explicit subagent model intent that cannot be satisfied.

### What is now possible

- Users can install `@weave/adapter-opencode` as an OpenCode plugin and have their `.weave/config.weave` agents materialized into OpenCode at startup.
- Weave-managed agents are protected from accidental overwrite by the `[weave-managed]` ownership check.
- The adapter can be tested end-to-end with mocked clients — no live OpenCode process required.
- Future slices can add prune/delete reconciliation, workflow-lifecycle expansion, and richer model context without changing the core injection and ownership patterns established here.

### Trade-offs accepted

- **`[weave-managed]` tag in description is visible to users.** This is intentional — it signals ownership clearly. The alternative (a hidden metadata field) would require OpenCode to support custom agent metadata, which it does not in the current SDK version.
- **Translation-only mode when no client is injected.** This preserves backward compatibility for callers that construct the adapter without a client. The warning log makes the mode explicit.
- **Fail-fast only for subagent mode.** Primary and `all` mode agents fall through to the engine's standard resolution chain. This is a deliberate asymmetry: subagents are invoked programmatically and need predictable model behavior; primary agents are user-facing and benefit from flexible fallback.
- **No prune/delete in first slice.** Removing Weave-managed agents that are no longer in config requires careful UX design (confirmation prompts, dry-run mode) and is deferred to a future slice.

---

## References

- [`packages/adapters/opencode/src/index.ts`](../../packages/adapters/opencode/src/index.ts) — Package barrel: re-exports all public API including `WeavePlugin`, `OpenCodeAdapter`, and helpers.
- [`packages/adapters/opencode/src/plugin.ts`](../../packages/adapters/opencode/src/plugin.ts) — `WeavePlugin` OpenCode plugin entry point; default export loaded by OpenCode at startup.
- [`packages/adapters/opencode/src/adapter.ts`](../../packages/adapters/opencode/src/adapter.ts) — `OpenCodeAdapter` class with injected client and constructor options.
- [`packages/adapters/opencode/src/opencode-client.ts`](../../packages/adapters/opencode/src/opencode-client.ts) — `OpenCodeClientFacade` interface and `SdkOpenCodeClient` implementation.
- [`packages/adapters/opencode/src/reconcile-agent.ts`](../../packages/adapters/opencode/src/reconcile-agent.ts) — Ownership-safe upsert reconciliation logic.
- [`packages/adapters/opencode/src/model-resolution.ts`](../../packages/adapters/opencode/src/model-resolution.ts) — Adapter-local model resolution with fail-fast rule.
- [`packages/adapters/opencode/src/skill-discovery.ts`](../../packages/adapters/opencode/src/skill-discovery.ts) — Harness-injection-based skill validation helpers.
- [`packages/adapters/opencode/src/sdk-types.ts`](../../packages/adapters/opencode/src/sdk-types.ts) — Sole SDK import surface for the adapter.
- [Spec 20 — OpenCode Adapter Materialization](../specs/20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) — Normative spec for this work.
- [Adapter Boundary](../adapter-boundary.md) — Ownership rules that this ADR must not violate.
- [Legacy Architecture](../legacy-architecture.md) — Alpha/OpenCode-era reference for the plugin install/runtime story.
