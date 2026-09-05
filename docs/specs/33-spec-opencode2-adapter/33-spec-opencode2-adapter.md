# Spec 33: OpenCode V2 Adapter (Independent Package)

**Status**: Active
**Related package**: `@weaveio/weave-adapter-opencode2` at `packages/adapters/opencode2/` (implemented in Phase C of this spec's plan; not yet scaffolded as of this writing)
**Related plan**: [`.weave/plans/opencode2-adapter.md`](../../../.weave/plans/opencode2-adapter.md)
**Related specs**:
- [Spec 16: Stable Adapter Descriptor Contract](../16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md) — source of the `AgentDescriptor` fields mapped in Section 3
- [Spec 08: Abstract Tool Policy Evaluation](../08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md) — source of the `ToolPolicyEffective` type mapped in Section 4
- [Spec 20: OpenCode Adapter Materialization](../20-spec-opencode-adapter-materialization/20-spec-opencode-adapter-materialization.md) — the V1 adapter's materialization spec; **not** a normative input to this spec (see Section 1.2)
- [Spec 30: Minimal Runtime Command Lifecycle](../30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md) — reusable command-operation semantics this spec's command surface projects
**Related docs**:
- [`docs/adapter-boundary.md`](../../adapter-boundary.md) — engine/adapter ownership rules (unchanged by this spec)
- OpenCode V2 upstream docs: <https://opencode.ai/v2/docs/build/>

---

## 1. Purpose and Scope

### 1.1 What this spec defines

This spec is the normative design for **`@weaveio/weave-adapter-opencode2`**, a `HarnessAdapter` implementation targeting the OpenCode V2 product line (the `opencode2` binary and its `@opencode-ai/plugin` / `@opencode-ai/sdk` / `@opencode-ai/client` / `@opencode-ai/cli` package family). It covers:

- V2-only authority and the V1 surfaces this adapter must never assume (Section 2).
- `AgentDescriptor` → V2 `Agent.Info` field mapping (Section 3).
- Abstract tool policy → ordered V2 `permissions: Rule[]` mapping, with the full 15-cell permission table (Section 4).
- Transform-based reconciliation semantics using `ctx.agent.transform` + `Registration.dispose()` (Section 5).
- Ownership marker handling (Section 5.4).
- The `request` field and why it is not used to encode temperature (Section 6).
- Embedded (`OpenCode.create`) vs. live-plugin (`Plugin.define`) construction paths, including the directory-based plugin entry point requirement and `awaitActivation()` timing (Section 7).
- Command-surface mapping for `/weave:start` and workflow commands (Section 8).
- Skill discovery via `ctx.skill.list` / `ctx.skill.transform` (Section 9).
- Catalog-based model context via `ctx.catalog.*` and envelope unwrapping (Section 10).
- Event subscription shape (`AsyncIterable`, `AbortSignal`-only cancellation) (Section 11).
- Transform timing semantics and foreign-agent classification rules (Section 12).
- Beta-version pinning policy (Section 13).
- Feasibility evidence, linked as non-normative (Section 14).

### 1.2 Independent-adapter invariant

**`@weaveio/weave-adapter-opencode2` is a separate, independent package from `@weaveio/weave-adapter-opencode` (the V1 adapter).** The two packages:

- Share no adapter-specific source, types, classes, facades, utilities, constants, ownership markers, fixtures, mocks, test helpers, docs, registries, lifecycle hooks, or runtime state.
- Do not import from one another in either direction.
- Are not unified under a shared "OpenCode" base class, abstraction, or common module.
- Consume only the public harness-neutral Weave packages in common: `@weaveio/weave-core`, `@weaveio/weave-config`, `@weaveio/weave-engine`.

**V1 remains fully supported.** This spec does not sunset, deprecate, or imply replacement of `@weaveio/weave-adapter-opencode`. No sunset is implied by this spec or by the existence of the V2 adapter.

**Adapter selection is explicit and manual.** Users choose which adapter(s) to load by listing the corresponding package(s) in their `opencode.jsonc` `plugins` array, e.g.:

```jsonc
{
  "plugins": ["@weaveio/weave-adapter-opencode2/server"]
}
```

**There is no auto-detection or auto-selection.** Neither adapter probes for the presence of the other's binary, package, or config. Neither adapter infers which OpenCode product is running. If a user wants V2 behavior, they add the V2 plugin entry to their `opencode.jsonc`; if they want V1 behavior, they use the V1 adapter's existing configuration path (unchanged, out of scope for this spec).

This spec, and the package it describes, contain no recommendation to modify V1 docs, V1 source, or any file under `packages/adapters/opencode/`.

---

## 2. V2-Only Authority and Prohibited V1 Surfaces (Normative)

### 2.1 Authoritative sources

The V2 adapter's only authoritative external sources are:

1. `https://opencode.ai/v2/docs/build/` and its V2 subpages.
2. The exact pinned V2 package types and runtime behavior for `@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode-ai/client`, and `@opencode-ai/cli` (see Section 13 for the pin).
3. The observed behavior of the actual `opencode2` binary, as recorded in the feasibility evidence (Section 14).

**When pinned package types and prose documentation disagree, the pinned package types are authoritative.** Every such discrepancy discovered during implementation must be documented (in this spec or in code comments) and covered by a test. Section 12 records every discrepancy discovered during the Phase A feasibility investigation.

V1 source, V1 tests, and V1 documentation are **not** authoritative inputs to this spec or to the V2 adapter implementation, even where a V2 algorithm happens to resemble a V1 algorithm. Any such resemblance must be coincidental and independently derived from the sources in this section — never copied, "ported", "carried forward", "mirrored", or "mapped 1:1" from V1.

### 2.2 Prohibited V1 surfaces

V2 adapter code, tests, and documentation must not assume, reference, emulate, or reuse identifiers from any of the following V1-only surfaces:

| # | Prohibited V1 surface | V2 replacement (normative in this spec) |
| - | --- | --- |
| 1 | V1 plugin config/event hook shape | V2 `Plugin.define({ id, setup(ctx) })` with the `ctx` sub-domain facade described in Section 7 |
| 2 | `config.update({ agent })` mutation model | `ctx.agent.transform(editor => ...)` + `Registration.dispose()` (Section 5) |
| 3 | V1 `AgentConfig.prompt` field | V2 `Agent.Info.system` (Section 3) |
| 4 | Singular `permission` field | V2 ordered `permissions: Rule[]`, last-match-wins (Section 4) |
| 5 | `tools` denial map | V2 has no `tools` denial map; abstract `execute`/`network` policy maps into `permissions` rules only (Section 4) |
| 6 | Top-level agent `temperature`, `top_p`, `tools`, `disable`, `maxSteps` | None of these fields are set by this adapter; V2's `request` field exists but is deliberately left unset (Section 6) |
| 7 | Any V1-only identifier or helper name reused in V2 source | V2 identifiers must be derived independently from V2 types/docs; naming overlap with V1 is acceptable only when independently justified by V2 semantics, never by copying |

Any test, source file, or doc under `packages/adapters/opencode2/` that references a prohibited surface above is a spec violation.

---

## 3. Schema Mapping — `AgentDescriptor` → V2 `Agent.Info`

The engine hands adapters a normalized `AgentDescriptor` (per [Spec 16](../16-spec-stable-adapter-descriptor-contract/16-spec-stable-adapter-descriptor-contract.md)). The V2 adapter's `translateAgent(descriptor): Agent.Info` function is a pure, one-way mapping from that descriptor to V2's `Agent.Info` shape (from `@opencode-ai/schema/agent`).

| `AgentDescriptor` field | V2 `Agent.Info` field | Mapping notes |
| --- | --- | --- |
| `name` | `id` | Stable identifier; used verbatim as the V2 agent id. |
| `displayName` (optional) | — (not mapped) | V2's `Agent.Info` has no separate display-name field in the pinned schema; `name`/`id` is the only identity field surfaced. |
| `composedPrompt` | **`system`** | The composed prompt string becomes the V2 `system` field. **This is a rename, not a reinterpretation**: V1's `AgentConfig.prompt` field name does not exist in V2 at all. |
| `models` (ordered) | `model: { providerID, id, variant? }` | Resolved via `model-resolution.ts` (Section 10) against `ctx.catalog.*`, not set directly from the raw string list. |
| `mode` (`primary`\|`subagent`\|`all`) | `mode` | Passed through; V2's `mode` enum accepts the same three values. |
| `effectiveToolPolicy` | `permissions: Rule[]` | Mapped via `toPermissionRules()` (Section 4); ordered, last-match-wins. |
| `rawToolPolicy` | — (not mapped) | Raw/unresolved policy is adapter-internal input only; V2 receives only the resolved `permissions` array. |
| `description` (optional) | `description` | The engine's description, with the V2-package-local ownership marker (Section 5.4) prepended by the adapter. |
| `delegationTargets` | — (not mapped in this spec) | Delegation/trigger metadata materialization into V2 subagent affordances is out of scope for this spec; see Section 1's scope note. |
| `skills` | — (not mapped by `translateAgent`) | Skill names are consumed by `skill-discovery.ts` (Section 9), not by agent translation. |
| — | `request` | Deliberately left **unset**. See Section 6. |
| — | `hidden`, `color`, `disabled` | Passed through only when the descriptor exposes an equivalent concept; otherwise left at the V2 default. |

**Directionality**: this mapping is one-way, engine → V2. The adapter never reads back V2 `Agent.Info` fields to reconstruct or mutate an `AgentDescriptor`.

---

## 4. Abstract Tool Policy → V2 `permissions: Rule[]` Mapping

### 4.1 V2 permission model

V2 represents an agent's permissions as an **ordered array** of `Rule` values (not a singular `permission` field, and not a `tools` denial map — see Section 2.2). Rules are evaluated **last-match-wins**: later entries in the array override earlier ones for overlapping scope. The adapter's `toPermissionRules(policy: ToolPolicyEffective): Rule[]` function (in `tool-policy-mapping.ts`) is a pure function with deterministic, byte-identical output for identical input.

### 4.2 Abstract policy dimensions

Weave's abstract `ToolPolicyEffective` (per [Spec 08](../08-spec-abstract-tool-policy-evaluation/08-spec-abstract-tool-policy-evaluation.md)) has five dimensions, each with three possible values:

- Dimensions: `read`, `write`, `execute`, `delegate`, `network`
- Values: `allow`, `deny`, `ask`

### 4.3 Full 15-cell permission table

| Dimension | `allow` | `deny` | `ask` |
| --- | --- | --- | --- |
| `read` | Emits a permissive `Rule` scoped to read-oriented V2 tool/action categories (file read, search, list). | Emits a denying `Rule` scoped to the same read-oriented categories. | Emits an ask-mode `Rule` scoped to the same read-oriented categories, requiring interactive confirmation in harnesses that support it. |
| `write` | Emits a permissive `Rule` scoped to write-oriented categories (file write, edit, create, delete). | Emits a denying `Rule` scoped to the same write-oriented categories. | Emits an ask-mode `Rule` scoped to the same write-oriented categories. |
| `execute` | Emits a permissive `Rule` scoped to shell/process-execution categories. | Emits a denying `Rule` scoped to the same execution categories. | Emits an ask-mode `Rule` scoped to the same execution categories. |
| `delegate` | Emits a permissive `Rule` scoped to subagent/delegation-invocation categories. | Emits a denying `Rule` scoped to the same delegation categories. | Emits an ask-mode `Rule` scoped to the same delegation categories. |
| `network` | Emits a permissive `Rule` scoped to outbound-network-capable categories (fetch, webfetch-equivalent). | Emits a denying `Rule` scoped to the same network categories. | Emits an ask-mode `Rule` scoped to the same network categories. |

Each cell above becomes exactly one `Rule` entry (or a small fixed set of entries where a single abstract dimension maps to more than one concrete V2 tool/action category); the rule's scope pattern is derived only from V2 package types and V2 docs, independently of any V1 tool-name table. `toPermissionRules()` must emit rules in a **stable, documented order** (`read`, `write`, `execute`, `delegate`, `network`) so that last-match-wins semantics are predictable when a caller later appends overrides.

### 4.4 Testing requirement

All 15 `{read, write, execute, delegate, network} × {allow, deny, ask}` cells must be covered by explicit unit tests in `tool-policy-mapping.test.ts`, asserting both rule content and array ordering — not just membership.

---

## 5. Transform-Based Reconciliation Semantics

### 5.1 Why transform, not mutation

V2 has no direct "set agent" mutation API. The only way to create or update an agent from a plugin is inside a `ctx.agent.transform(editor => ...)` callback, which:

1. Is registered by calling `ctx.agent.transform(callback)`, returning `Promise<Registration>`.
2. Receives a synchronous, in-process `AgentEditor` with exactly five methods: `list()`, `get(id)`, `default(id)`, `update(id, updateFn)`, `remove(id)`. There is no `add`/`create`/`insert`/`set` method (see Section 12.5 and Section 14).
3. Produces effects that are **not** guaranteed visible synchronously by the time the `transform()` promise resolves (see Section 12.1).

### 5.2 Create-or-update via `editor.update()`

`editor.update(id, updateFn)` has **upsert semantics**:

- If `id` already exists, `updateFn` mutates the existing draft in place.
- If `id` does not exist, the runtime seeds a fresh draft (matching the shape produced by `@opencode-ai/schema`'s `Agent.Info.default(id)` helper), applies `updateFn` to it, and commits it as a new agent on transform flush.

`reconcileAgent(facade, agentInfo): ResultAsync<Registration, OpenCode2AdapterError>` uses `editor.update(id, updateFn)` as the **only** creation and update path. There is no separate code path for "create" versus "update" — the same call handles both, distinguished only by whether `id` was already present in `editor.list()`.

### 5.3 Foreign-agent collision

Before calling `editor.update()` for a given agent id, `reconcileAgent` classifies any existing entry with that id by presence of the ownership marker (Section 5.4) in its `description`:

- **No existing entry, or existing entry carries the Weave ownership marker**: proceed with `editor.update()`.
- **Existing entry present without the Weave ownership marker (a foreign agent)**: `reconcileAgent` returns a discriminated error variant (hard-error default policy) rather than overwriting it. It must not mutate the foreign entry.

Per Section 12.6, `editor.list()`/`editor.get()` inside a `transform()` callback only ever shows agents that were themselves registered via some plugin's own `agent.transform()` call (builtins and other transform-registered agents) — **not** agents declared only in static `config.content`/`opencode.jsonc`. Config-only agents are visible only through the async RPC `ctx.agent.list()`. `reconcileAgent` must therefore treat foreign-agent classification as a two-source check:

1. `editor.list()`/`editor.get()` inside the transform, for transform-registered foreign agents.
2. A separate async `ctx.agent.list()` read, for config-declared foreign agents.

A collision detected through either source is treated identically (hard error, no mutation).

### 5.4 Ownership marker

The Weave ownership marker is a fixed string prepended to the `description` field of every agent the V2 adapter creates or updates. **The marker string is defined exactly once, inside `packages/adapters/opencode2/`, and is not imported from, aliased to, exported to, or otherwise shared with `packages/adapters/opencode/`.** The V1 adapter's own ownership/marker mechanism (if any) is out of scope for this spec and irrelevant to it.

### 5.5 Disposal

`reconcileAgent` returns the `Registration` produced by `ctx.agent.transform()`. The adapter accumulates every `Registration` it receives (agent, command, skill transforms) and disposes all of them in `dispose()` / plugin cleanup. `Registration.dispose()` is confirmed (Section 14) to remove only the effect it owns, leaving other registrants' agents/commands untouched.

---

## 6. The `request` Field Is Not Used for Temperature

V2's `Agent.Info` schema includes a `request` field (`{ settings, headers, body }` per `Agent.Info.default(id)`). **This adapter deliberately leaves `request` unset.** Per the Phase A feasibility findings, `request` is **currently ignored at runtime** by the pinned V2 build — setting per-agent request overrides (including any hypothetical per-agent `temperature`) has no observed runtime effect. Consequently:

- This adapter does not use `request` to encode Weave's `temperature` config field.
- No V2-side mechanism exists in the pinned version for per-agent temperature; this is a documented gap, not an adapter oversight.
- If a future V2 release makes `request` load-bearing, this spec must be revised (with a corresponding version-pin bump per Section 13) before the adapter starts populating it.

---

## 7. Construction Paths: Embedded vs. Live Plugin

### 7.1 Live plugin (`Plugin.define`)

The primary, user-facing construction path. `packages/adapters/opencode2/src/plugin.ts` exports:

```ts
export default Plugin.define({
  id: "weave",
  async setup(ctx) {
    // build PluginContextFacade from ctx, instantiate OpenCode2Adapter, call init()
    return async () => {
      // abort event subscription controller, adapter.dispose()
    };
  },
});
```

**Plugin entry point must be a directory containing `server.ts` or `index.ts`.** The real `opencode2` loader (`ConfigPluginSource.scan()`) silently drops any `plugins` entry that resolves to a single file — only directories with `server.ts` or `index.ts` inside are accepted (`Host.resolve({ directory })` handles the entry point). The package therefore ships its plugin entry as the `./server` subpath export, resolving to a directory, not a bare file. Users configure it as:

```jsonc
{ "plugins": ["@weaveio/weave-adapter-opencode2/server"] }
```

### 7.2 Embedded (`OpenCode.create`)

An alternate, script-friendly construction path using the exact pinned `@opencode-ai/sdk`:

```ts
const host = await OpenCode.create({ plugins: [weavePlugin] });
```

**`OpenCode.create({ plugins })` does not run `setup()` immediately.** Plugins are stored in an SDK-internal registry and activated lazily, per-location, by the `PluginSupervisor`. **Embedded-mode callers that need setup effects to be visible (e.g. agent transforms) must call `host.plugin.awaitActivation()` before observing those effects.** This is normative: any embedded-mode adapter code path or test that reads agent/catalog/skill/command state immediately after `OpenCode.create()` without an intervening `awaitActivation()` call is incorrect and will observe stale or absent state.

`host.close()` triggers cleanup (the plugin's returned dispose function runs).

---

## 8. Command-Surface Mapping

The V2 adapter projects the reusable command-operation semantics defined in [Spec 30](../30-spec-minimal-runtime-command-lifecycle/30-spec-minimal-runtime-command-lifecycle.md) onto V2's command API, independently of how the V1 adapter projects the same operations onto V1's command API.

| Weave command-operation | V2 surface | Notes |
| --- | --- | --- |
| Start plan execution (`/weave:start`) | Registered via `ctx.command.transform(editor => editor.add(...))`; execute callback calls `facade.session.prompt(...)` | `CommandEditor` exposes only `add()` — no `list`/`get`/`remove` on the editor itself (Section 12.4). Reading commands back requires the async `ctx.command.list()`. |
| Named workflow execution | Registered the same way as plan-start, as a separate command; execute callback drives the workflow via `facade.event.subscribe({ signal })` + `facade.session.wait` | Kept separate from plan-start per [Spec 29](../29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md)'s explicit-invocation model. |
| Status / health / abort / advance | Additional commands registered the same way, delegating to the engine's reusable command-operation layer | Out of scope for this spec's per-command detail; see Spec 30. |

Every `Registration` returned by `facade.command.transform` is captured by the adapter for disposal alongside agent and skill registrations (Section 5.5).

---

## 9. Skill Discovery

`loadAvailableSkillsV2(facade): Promise<SkillInfo[]>` reads `facade.skill.list()` (the async RPC `ctx.skill.list()`, unwrapped per Section 10.2) and adapts each `Skill.Info` record into the engine's `SkillInfo` shape (per [Spec 09](../09-spec-adapter-provided-skill-resolution/09-spec-adapter-provided-skill-resolution.md)). This satisfies the `HarnessAdapter.loadAvailableSkills()` contract.

Optionally, `registerWeaveManagedSkills(facade, skills)` uses `facade.skill.transform(editor => ...)` to register Weave-managed skill entries and returns a disposable `Registration`, following the same transform-and-dispose pattern as agent and command registration.

---

## 10. Catalog-Based Model Context

### 10.1 Sources

Model resolution is built from three catalog RPC calls: `facade.catalog.provider.list()`, `facade.catalog.model.list()`, `facade.catalog.model.default()`. These are fed into the engine's pure `resolveAdapterModelIntent` helper, imported unchanged from `@weaveio/weave-engine` — this adapter does not wrap, modify, or reimplement that helper.

### 10.2 Envelope unwrap

**Every V2 list/read RPC in the probed surface — `ctx.agent.list()`, `ctx.catalog.model.list()`, `ctx.catalog.model.default()`, `ctx.skill.list()` — resolves an envelope shape `{ location, data }`, not a bare array or bare value.** The adapter must unwrap `.data` before use; `location` is metadata about where the data was sourced from and is not adapter-facing model or agent state. This is a documented deviation from an assumption of bare-array/bare-value RPC returns (Section 12.2).

### 10.3 Resolution rules

- A subagent with an explicit model absent from the catalog is a fail-fast error (`MissingCatalogEntry` or equivalent discriminated variant).
- A primary agent with no explicit model falls back to the catalog default (`catalog.model.default()`).
- A primary agent with a valid explicit model uses that model.

---

## 11. Event Subscription Shape

`ctx.event.subscribe(options?: { signal?: AbortSignal, headers? })` returns an **`AsyncIterable<V2Event>`** — there is no callback-based subscription form and no `Registration`/unsubscribe function returned from `subscribe()` itself (unlike `agent`/`catalog`/`command`/`skill` `.transform()`, which all return `Promise<Registration>`). This is a documented deviation from an assumption that `event.subscribe` would follow the same `Registration`-returning shape as the other domains (Section 12.3).

**Cancellation is exclusively via `AbortSignal`.** Callers pass a `signal` in the options object; aborting it ends the `for await` loop cleanly (the loop exits without throwing a terminal error). The V2 adapter's workflow runner (`run-workflow.ts`) must construct its own `AbortController`, pass its `signal` into `event.subscribe`, and call `abort()` on plugin cleanup — there is no other cancellation mechanism available.

---

## 12. Transform Timing and Foreign-Agent Classification (Normative Deviations)

This section enumerates every runtime deviation from an initially assumed V2 behavior, discovered during the Phase A feasibility investigation (Section 14) and required by Invariant 4 of the governing plan to be documented here with test coverage.

### 12.1 `agent.transform` / `catalog.transform` callbacks are lazy

Unlike `ctx.command.transform`, whose effect is visible immediately via `ctx.command.list()` after the awaited `transform()` call, **`ctx.agent.transform(editor => ...)` and `ctx.catalog.transform(editor => ...)` callbacks do not run synchronously by the time the `transform()` promise resolves.** Reconciliation code (`reconcile-agent.ts`) must not assume the editor callback has already run once `await facade.agent.transform(...)` returns. Callers that need to confirm effects must perform a subsequent async read (e.g. `await ctx.agent.list()`) and treat that as the point of confirmation, not the resolution of `transform()` itself.

### 12.2 RPC list results are envelopes, not bare values

See Section 10.2. Applies to `agent.list`, `catalog.model.list`, `catalog.model.default`, `skill.list`.

### 12.3 `event.subscribe` has no `Registration`

See Section 11.

### 12.4 `command.transform`'s editor exposes only `add()`

Confirmed by runtime probe: the `CommandEditor` received inside `ctx.command.transform(editor => ...)` exposes only `add(definition)` — no `list`/`get`/`remove`. Reading commands back requires the RPC `ctx.command.list()`.

### 12.5 `AgentEditor` has no create method; `update()` upserts

`AgentEditor`'s pinned type (and confirmed runtime `Object.keys()`) is exactly `{ list, get, default, update, remove }` — there is no `add`/`create`/`insert`/`set`. `editor.update(id, updateFn)` is the sole creation and update path (Section 5.2). This is the resolution to the plan's Task A5 hard blocker.

### 12.6 Config-declared agents are invisible inside the synchronous transform editor

**Agents declared only in static `config.content` / `opencode.jsonc` do not appear in `editor.list()`/`editor.get()` inside `ctx.agent.transform()`.** Only builtins and agents registered via some plugin's own `agent.transform()` call appear in the synchronous editor draft. Config-only agents surface **only** through the async RPC `ctx.agent.list()`. `reconcileAgent` (Section 5.3) must cross-reference both sources — `editor.list()` alone is insufficient to classify a config-declared agent as foreign.

---

## 13. Beta-Version Pinning Policy

`@opencode-ai/cli`, `@opencode-ai/plugin`, `@opencode-ai/sdk`, and `@opencode-ai/client` must resolve to the **exact same pinned version, `0.0.0-beta-19151`**, across the adapter package's `package.json`, its verification harness, and any fixture `opencode.jsonc`. This is a beta pin, not a semver range:

- The adapter must not use caret/tilde ranges for these four packages.
- A version-drift check (executable, part of the adapter's verification harness) must fail loudly if any of the four packages no longer resolves to `0.0.0-beta-19151`.
- Advancing the pin is a deliberate, reviewed action that must re-run the Phase A-equivalent feasibility checks against the new pin and update this spec's Section 12 deviation list if runtime behavior has changed.

---

## 14. Feasibility Evidence (Non-Normative)

The behavioral claims in Sections 5, 7, 10, 11, and 12 were verified empirically in a hermetic, V2-only Podman harness before this spec was written, per the governing plan's Phase A hard gate. The retained evidence is **non-normative** — it documents how the claims above were validated, but this spec's prose (Sections 1–13) is the normative contract adapter code must satisfy.

- [`docs/artifacts/opencode2-feasibility/DECISION.md`](../../artifacts/opencode2-feasibility/DECISION.md) — go/no-go decision and criteria table.
- [`docs/artifacts/opencode2-feasibility/results.json`](../../artifacts/opencode2-feasibility/results.json) — machine-readable pass/fail data for every probed API.
- [`docs/artifacts/opencode2-feasibility/notes/agent-editor-findings.md`](../../artifacts/opencode2-feasibility/notes/agent-editor-findings.md) — detailed `AgentEditor` create/foreign-classification investigation.
- [`docs/artifacts/opencode2-feasibility/README.md`](../../artifacts/opencode2-feasibility/README.md) — artifact classification for this directory.
- [`.weave/learnings/opencode2-adapter.md`](../../../.weave/learnings/opencode2-adapter.md) — per-task learnings (A1–A5) consolidated.

None of the files above are shipped as part of `packages/adapters/opencode2/`; they are retained under `docs/artifacts/` per [`docs/documentation-policy.md`](../../documentation-policy.md).

---

## 15. Acceptance Criteria

| # | Criterion |
| --- | --- |
| AC-1 | The V2 adapter is documented and implemented as a fully independent package sharing no adapter-specific source, tests, docs, or runtime state with the V1 adapter. |
| AC-2 | Adapter selection is exclusively via the `opencode.jsonc` `plugins` array; no code path auto-detects or auto-selects between V1 and V2. |
| AC-3 | `translateAgent` maps every `AgentDescriptor` field listed in Section 3, including the `composedPrompt` → `system` rename. |
| AC-4 | `toPermissionRules` covers all 15 `{read, write, execute, delegate, network} × {allow, deny, ask}` cells with deterministic, ordered output. |
| AC-5 | `reconcileAgent` uses `ctx.agent.transform` + `editor.update(id, updateFn)` for create-or-update, and returns the `Registration` for later `dispose()`. |
| AC-6 | Foreign-agent collisions (transform-registered or config-declared) are detected without mutation and produce a hard-error discriminated variant by default. |
| AC-7 | The ownership marker string is defined exactly once, inside the V2 package only. |
| AC-8 | `request` is never populated by this adapter; Section 6 documents why. |
| AC-9 | The plugin entry point ships as a directory (`./server` subpath) containing `server.ts` or `index.ts`, not a bare file. |
| AC-10 | Embedded-mode adapter code calls `host.plugin.awaitActivation()` before relying on setup effects. |
| AC-11 | All RPC list/read call sites (`agent.list`, `catalog.model.list`, `catalog.model.default`, `skill.list`) unwrap the `{ location, data }` envelope. |
| AC-12 | `event.subscribe` usage relies only on `AsyncIterable` iteration and `AbortSignal` cancellation; no code assumes a `Registration` return from `subscribe()`. |
| AC-13 | The four pinned V2 packages resolve to the exact same version, `0.0.0-beta-19151`, verified by an executable version-drift check. |
| AC-14 | This spec links `docs/artifacts/opencode2-feasibility/` as non-normative evidence and contains no recommendation to modify V1 docs or V1 source. |
