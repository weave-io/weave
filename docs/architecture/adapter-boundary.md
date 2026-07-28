# Adapter Boundary

Weave has two cooperating halves:

1. Core, config, and engine packages parse `.weave`, normalize intent, compose portable behavior, and own Weave runtime state.
2. Adapters discover harness resources, register concrete surfaces, and translate normalized behavior into OpenCode, Claude Code, Pi, or another harness.

The boundary exists so a new harness does not force harness assumptions into the engine.

**Related:** [Product Vision](product-vision.md) · [System Overview](system-overview.md) · [Adapter Development](../guides/adapter-development.md) · [Capabilities](../reference/adapter-capabilities.md) · [Execution Lifecycle](../reference/execution-lifecycle.md) · [Runtime Store](../reference/runtime.md)

---

## Boundary rule

Ask one question when placing a responsibility:

> Does this code need to know how a particular harness represents, discovers, registers, or executes something?

If yes, it belongs in an adapter. Engine-to-adapter calls are fine when they exchange normalized, harness-neutral data. They are wrong when the engine needs a harness path, callback type, UI object, model registry, session payload, or tool name.

## Ownership matrix

| Concern | Weave layer | Adapter layer |
| --- | --- | --- |
| `.weave` language | Core parses and validates | None |
| Config | Config discovers trusted Weave layers, merges intent, resolves prompt paths | Supplies project trust and harness context when needed |
| Agent descriptors | Engine builds stable normalized descriptors | Converts descriptors into harness agents/config |
| Prompts | Engine renders templates and delegation context | Delivers composed text through the harness's prompt surface |
| Models | Engine resolves ordered intent against explicit candidates | Discovers candidates and selected model; activates the result |
| Skills | Engine matches declared names, disables, and policy | Discovers, reads, and normalizes harness skill files |
| Categories | Engine carries declared category metadata | Maps patterns into concrete harness routing, if supported |
| Tool policy | Engine evaluates abstract capabilities | Maps real tool identities, inputs, interception, and approval UI |
| Permissions | Engine owns requests, grants, challenges, permits, and coverage evaluation | Supplies tool inventory and enforces the returned decision |
| Capabilities | Engine owns IDs, schemas, profile evaluation, and health reports | Declares static ceilings and supplies safe runtime probes |
| Lifecycle | Engine validates transitions, mutates Runtime Store state, returns abstract effects | Registers hooks/commands, maps events, applies effects |
| Runtime Store | Engine owns `.weave/runtime/**` and its repositories | Calls engine APIs; never receives a database mutation surface |
| Plans | Engine owns the `PlanStateProvider` contract and plan semantics | Supplies safe concrete plan discovery and file I/O |
| Artifacts | Engine owns references, revisions, approval, and digest comparison | Proves containment, reads files, computes SHA-256 digests |
| Delegation | Core/config/engine own portable budgets and authorization | Owns live queues, process/task counts, spawn, cancellation, child UI, and recovery orchestration |
| Logging | Engine supplies structured pino logging | Routes output where the harness will not corrupt its UI |
| Feature gaps | Defines the portable behavior | Emulates missing hooks, commands, subagents, or UI honestly |

## Normalized data flows

### Models

The adapter supplies the current catalog and selected model. The engine resolves ordered model intent without querying a UI or registry:

```ts
const result = resolveAdapterModelIntent({
  agentName,
  agentMode,
  agentModels,
  uiSelectedModel,
  availableModels,
  systemDefault,
});
```

The adapter decides how to activate `result`; the engine does not call a harness model API.

### Skills

The adapter discovers and loads skill descriptors, then passes them to the engine matcher. The engine never scans OpenCode, Claude Code, Pi, XDG, or home-directory skill paths.

### Lifecycle

The adapter maps a concrete event into a normalized lifecycle input. The engine returns a typed result and zero or more abstract effects. The adapter applies those effects through concrete harness APIs.

Ordinary chat, passive observations, and tool previews do not silently start or advance durable execution. See [Execution Lifecycle](../reference/execution-lifecycle.md).

### Runtime state

The Runtime Store is a narrow engine I/O exception because `.weave/runtime/**` is Weave-owned state. The engine may use Bun filesystem and database APIs there; it may not inspect harness-owned storage or session history.

Pi private-child transcripts and control state are adapter-owned, including child UI, RPC framing and transport, session discovery/path selection, session file I/O, and recovery orchestration. The Pi adapter may pass only bounded normalized observations into engine APIs. See [Pi](../adapters/pi.md).

### Plans and artifacts

The engine defines plan and artifact semantics but does not read arbitrary project files. An adapter-provided plan or artifact port proves containment and performs I/O. For artifact dispatch, the adapter computes the current digest; the engine compares it with stored revision metadata and fails closed on mismatch.

## Stable contracts

### Descriptor naming

Use `*Decl` for declarative DSL types in core and `*Ref` for persisted runtime handles in engine. Do not reuse one type name for both layers.

An `AgentDescriptor` contains the final harness-neutral agent identity, composed prompt, model intent, skills, category metadata, effective tool policy, and delegation metadata. Adapters consume it; they do not reinterpret the DSL or rebuild prompts.

### Materialization

The engine creates a `MaterializationPlan` with ordered descriptors and typed per-entry failures. An adapter projects valid descriptors in plan order and reports failures. It must not invent fallback agents, reorder intent, or hide descriptor errors.

### Capabilities

Static declarations are ceilings. Adapter probes may lower effective readiness, never raise it. A required effective gap activates health-only mode. See [Adapter Capabilities](../reference/adapter-capabilities.md).

### Safe metadata

Data crossing the boundary uses closed, bounded shapes. Never put raw prompts, completions, transcripts, provider payloads, credentials, headers, environment dumps, arbitrary harness objects, or private paths into lifecycle metadata, errors, journals, or health reports.

The engine owns the sensitive-key policy. Adapters sanitize at collection time and must not rely on log filtering as the only defense.

## Interfaces that are not precedent

Earlier designs placed `loadSkill()` and `registerHook()` on `HarnessAdapter`. They are not part of the current interface.

- Skills now arrive through adapter-provided catalog context.
- Lifecycle registration is adapter-owned; adapters call typed engine lifecycle functions.

Do not restore broad discovery or hook-registration methods merely because an adapter needs them internally.

## Anti-patterns

```ts
// Wrong: engine discovers a harness resource.
const skills = await scanOpenCodeSkillDirectories(projectRoot);

// Wrong: engine reads concrete UI state.
const selected = await opencodeClient.model.selected();

// Wrong: engine registers a harness callback.
opencodePlugin.on("session.idle", handler);

// Correct: adapter supplies normalized context.
const availableSkills = await adapterContext.loadAvailableSkills();
const resolved = resolveSkillsForAgent({ agentName, agentSkills, availableSkills, disabledSkills });
```

Other boundary violations:

- engine APIs that accept a harness client or plugin object;
- engine code that scans a harness-owned directory;
- adapters that parse `.weave` independently;
- adapters that compose their own version of an agent prompt;
- capability claims based only on package intent rather than runtime probes;
- tests that launch a real harness instead of mocking the boundary.

## API design checklist

Before adding or changing an engine API:

1. Can the input be expressed without a harness type, path, callback, or payload?
2. Is discovery performed by the adapter and passed explicitly?
3. Does the engine return normalized data or abstract effects?
4. Could another adapter implement the same contract without emulating this harness's internals?
5. Are failures a typed `Result` / `ResultAsync` value?
6. Does an isolated test prove the boundary with a mock adapter or fixture context?

If any answer is no, narrow the API or move the responsibility into the adapter.

## Source map

- [`packages/engine/src/adapter.ts`](../../packages/engine/src/adapter.ts) — adapter interface
- [`packages/engine/src/descriptors.ts`](../../packages/engine/src/descriptors.ts) — normalized descriptors
- [`packages/engine/src/materialization.ts`](../../packages/engine/src/materialization.ts) — materialization plan
- [`packages/engine/src/model-resolution.ts`](../../packages/engine/src/model-resolution.ts) — pure model intent helper
- [`packages/engine/src/skill-resolution.ts`](../../packages/engine/src/skill-resolution.ts) — pure skill matcher
- [`packages/engine/src/capability-contract.ts`](../../packages/engine/src/capability-contract.ts) — readiness contract
- [`packages/engine/src/execution-lifecycle/`](../../packages/engine/src/execution-lifecycle/) — lifecycle surface
- [`packages/engine/src/runtime/`](../../packages/engine/src/runtime/) — Weave-owned persistence
