# ADR 0008: OpenCode V2 Adapter as a Separate Independent Package with Transform-Based Reconciliation

**Status**: Accepted
**Date**: 2026-09-05
**Related**: [Spec 33: OpenCode V2 Adapter (Independent Package)](../specs/33-spec-opencode2-adapter/33-spec-opencode2-adapter.md) · [Adapter Boundary](../adapter-boundary.md) (read-only reference; no changes proposed) · [Feasibility Decision](../artifacts/opencode2-feasibility/DECISION.md) · [Plan: opencode2-adapter](../../.weave/plans/opencode2-adapter.md)

---

## Context

OpenCode ships a second, incompatible product line — the `opencode2` binary and its `@opencode-ai/plugin` / `@opencode-ai/sdk` / `@opencode-ai/client` / `@opencode-ai/cli` package family — alongside the existing V1 product that `@weaveio/weave-adapter-opencode` already targets. V2 coexists with V1 on a user's machine rather than replacing it, and its plugin/config surface differs materially from V1's:

- V2 has no `config.update({ agent })` mutation model; agents are created and updated only through `ctx.agent.transform(editor => ...)`, whose `AgentEditor` has just `list`, `get`, `default`, `update`, `remove` — no `add`/`create`.
- V2 agents use `system` instead of `prompt`, drop the singular `permission` field and `tools` denial map in favor of ordered `permissions: Rule[]`, and have no top-level `temperature`, `top_p`, `tools`, `disable`, or `maxSteps`.
- V2's RPC list APIs return `{ location, data }` envelopes, its event subscription is an `AbortSignal`-cancelled `AsyncIterable` with no callback or `Registration`, and its `transform()` callbacks are lazily applied rather than synchronously visible on promise resolution.

A Podman-based feasibility investigation (Phase A of the plan; see the [feasibility decision](../artifacts/opencode2-feasibility/DECISION.md) and [learnings](../../.weave/learnings/opencode2-adapter.md)) confirmed these V2 primitives exist and behave as required, including that `editor.update(id, fn)` has upsert semantics sufficient to create agents, and that `Registration.dispose()` removes only the effect it owns. This cleared the gate for designing the production adapter (Spec 33).

Three design questions had to be settled before any V2 adapter code could be written:

1. **Packaging**: should V2 support live inside the existing `@weaveio/weave-adapter-opencode` package (as a mode, a submodule, or a shared base class), or as an entirely separate package?
2. **Lifecycle**: does the arrival of a V2 adapter imply V1 is deprecated, sunset, or superseded?
3. **Reconciliation model**: given V2's transform-only mutation surface, how does the adapter create, update, and safely dispose of agents it owns without corrupting agents owned by other plugins or by static config?

Getting these wrong would either couple two independently-evolving, beta-versioned harness surfaces through a shared abstraction that neither team fully controls, or would produce reconciliation code that assumes V1-style synchronous mutation and silently corrupts foreign agents.

---

## Decision

### 1. Separate independent package, zero shared code

`@weaveio/weave-adapter-opencode2` ships as its own workspace package at `packages/adapters/opencode2/`, independent from `@weaveio/weave-adapter-opencode` (V1) at `packages/adapters/opencode/`. The two packages:

- Share no adapter-specific source, types, classes, facades, utilities, constants, ownership markers, fixtures, mocks, test helpers, docs, registries, lifecycle hooks, or runtime state.
- Do not import from one another in either direction.
- Are not unified under a shared "OpenCode" base class, abstraction, or common module of any kind.
- Consume only the public harness-neutral Weave packages already shared by every adapter: `@weaveio/weave-core`, `@weaveio/weave-config`, `@weaveio/weave-engine`. No new methods are added to `HarnessAdapter`; the engine/adapter boundary defined in `docs/adapter-boundary.md` is unchanged.

**Explicitly rejected**: a shared "OpenCode" abstraction (base class, common facade, shared ownership-marker constant, or shared test fixtures) spanning V1 and V2. V1 and V2 are different products with different plugin models, different mutation semantics, and independent beta/stability lifecycles; a shared abstraction would force one to bend around the other's constraints and would make a breaking V2 beta release a breaking V1 release too.

### 2. Explicit, manual adapter selection — no auto-detection

Users select an adapter by listing its package explicitly in their `opencode.jsonc` `plugins` array (e.g. `"plugins": ["@weaveio/weave-adapter-opencode2/server"]`). Neither adapter probes for the presence of the other's binary, package, or config, and neither infers which OpenCode product is running from environment, `PATH`, or installed packages.

**Explicitly rejected**: auto-detection or auto-selection of installed binaries (e.g. checking for `opencode` vs. `opencode2` on `PATH` and loading the matching adapter automatically). Auto-detection would hide adapter choice from the user, complicate testing (behavior would depend on host environment rather than declared config), and blur the "separate independent package" boundary by requiring one adapter to know the other exists.

### 3. V1 remains fully supported — no sunset implied

`@weaveio/weave-adapter-opencode` continues to ship, continues to be supported, and is out of scope for the V2 work. The existence of `@weaveio/weave-adapter-opencode2` does not deprecate, sunset, or imply eventual replacement of V1. No file under `packages/adapters/opencode/` is modified as part of delivering V2 (a purely additive documentary cross-reference, such as a package-index row, is the only permitted touch, and is independently justified rather than assumed).

**Explicitly rejected**: any framing of V1 as a stepping stone, legacy path, or migration source superseded by V2. There is no migration tooling from V1 config to V2 config, and none is implied by this decision.

### 4. V1 is not a normative reference for V2 design or implementation

The V2 adapter's only authoritative external sources are the OpenCode V2 docs (`https://opencode.ai/v2/docs/build/`), the exact pinned V2 package types/runtime (`@opencode-ai/plugin`, `@opencode-ai/sdk`, `@opencode-ai/client`, `@opencode-ai/cli`, pinned together at a single beta version), and the observed behavior of the real `opencode2` binary as recorded in the Phase A feasibility evidence. Where a V2 algorithm happens to resemble a V1 algorithm, that resemblance must be coincidental and independently derived from these sources — never ported, mirrored, mapped 1:1, or otherwise copied from V1 source, tests, or docs.

**Explicitly rejected**: using the V1 adapter as a design template, reference implementation, or "prior art" for V2 modules, even informally. V2's mutation model (transform-only, upsert via `editor.update`), field mapping (`system` not `prompt`, ordered `permissions: Rule[]` not `tools` denial map), and event model (`AsyncIterable` + `AbortSignal`, not callback + `Registration`) are structurally different enough that treating V1 as normative would produce incorrect V2 code.

### 5. Reconciliation model: `ctx.agent.transform` + `Registration.dispose()`

Because V2 has no direct "set agent" mutation API, the V2 adapter's only creation/update path is `ctx.agent.transform(editor => ...)`:

- `reconcileAgent(facade, agentInfo)` calls `editor.update(id, updateFn)` for every agent the adapter owns. `editor.update` has upsert semantics — it seeds a fresh draft when `id` is absent and mutates in place when present — so there is exactly one code path for both create and update, distinguished only by whether `id` was already present in `editor.list()`.
- Before upserting, `reconcileAgent` classifies any existing same-id entry by presence of a Weave ownership marker in its `description`. A collision with an entry lacking the marker (a foreign agent) is a hard error — no mutation of foreign entries — checked against both the synchronous `editor.list()`/`editor.get()` (covers other transform-registered agents) and the async `ctx.agent.list()` RPC (covers config-only agents, which are invisible inside the synchronous editor; see Spec 33 §12.6).
- The adapter accumulates every `Registration` returned by `ctx.agent.transform()` (and by `command`/`skill` transforms) and disposes all of them during adapter cleanup. `Registration.dispose()` is confirmed by the Phase A feasibility harness to remove only the effect it owns, leaving other registrants' agents and commands untouched.
- Reconciliation code must not assume the editor callback has executed synchronously by the time `transform()`'s promise resolves; `agent.transform`/`catalog.transform` effects are lazily applied and must be confirmed via the corresponding async RPC read when synchronous confirmation is required (unlike `command.transform`, whose effect is visible immediately via `ctx.command.list()`).

This model is fully specified in [Spec 33, Section 5](../specs/33-spec-opencode2-adapter/33-spec-opencode2-adapter.md#5-transform-based-reconciliation-semantics).

---

## Consequences

### What changes

- A new workspace package, `@weaveio/weave-adapter-opencode2` at `packages/adapters/opencode2/`, is added. No existing package's source changes as a result.
- Root package index, `docs/README.md`, and `docs/specs/README.md` gain additive-only navigation entries listing the new package alongside the V1 adapter, without implying shared code or a migration relationship.

### What is now possible

- Users running OpenCode V2 can adopt Weave by adding `@weaveio/weave-adapter-opencode2/server` to their `opencode.jsonc` `plugins` array, independently of whether the V1 adapter is also installed.
- The V2 adapter can evolve independently against V2's beta package cadence without risk of destabilizing the V1 adapter, and vice versa.
- Agent reconciliation is safe under V2's transform-only mutation model: creation and update share one code path, foreign agents are never silently overwritten, and every registered effect is disposed cleanly on adapter teardown.

### What is now forbidden

- No shared "OpenCode" abstraction, base class, facade, ownership marker, or test fixture may span `packages/adapters/opencode/` and `packages/adapters/opencode2/`.
- Neither adapter may probe for or react to the other's installed binary, package, or config; adapter selection remains entirely explicit via `opencode.jsonc`.
- No V1 sunset, deprecation notice, or migration-path framing may be attached to the existence of the V2 adapter.
- V2 adapter code, tests, and docs may not treat V1 source as a reference, template, or normative input, even when a resulting algorithm happens to resemble V1's.
- V2 reconciliation code may not assume synchronous visibility of `agent.transform`/`catalog.transform` editor effects, and may not use any mutation path other than `editor.update(id, updateFn)` for agent creation or update.
