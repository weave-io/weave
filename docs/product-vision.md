# Product Vision

Weave is a harness-agnostic agent orchestration framework and API for building agent-harness experiences. Users provide a single `.weave` configuration that describes the agent system once; supported harnesses consume that same normalized config through adapters.

It is closer to Neovim's API layer than to a finished editor: Weave defines the primitives, config model, prompt/delegation structure, and policy intent that adapters compose into concrete harness integrations.

**Related:** [System Architecture](system-architecture.md) · [Adapter Boundary](adapter-boundary.md) · [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Spec 04 — Agent Model Resolution](specs/04-spec-agent-model-resolution/04-spec-agent-model-resolution.md) · [Spec 05 — Skill Resolution](specs/05-spec-skill-loader/05-spec-skill-loader.md) · [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Legacy Architecture](legacy-architecture.md)

---

## Core Mental Model

```txt
.weave DSL
    ↓
parsed + validated config
    ↓
normalized agent descriptors + prompt/delegation intent
    ↓
adapter translation
    ↓
harness runtime/plugin/config
(OpenCode, Pi, Claude Code, Codex, ...)
```

Weave's responsibility is to describe **what agent system should exist** and provide **APIs that compose harness-provided context with declared config** to produce normalized output:

- agent topology and names
- prompts and prompt appendices
- delegation metadata for Loom/Tapestry
- categories and generated category shuttle descriptors
- abstract tool/capability policy
- ordered model preferences
- skill references and resolution
- workflow intent
- **composition APIs** that accept harness context (available models, loaded skills, etc.) and return resolved agent descriptors, prompts, and configurations

Adapters are responsible for deciding **how that intent becomes harness behavior** and for **supplying harness-owned context to Weave's APIs**:

- enabling Weave inside a specific harness
- harness plugin/config generation
- filling feature gaps when a harness lacks native functionality
- UI-selected model lookup and interpretation
- available model discovery and passing it to Weave's resolution APIs
- **skill discovery** — scanning harness skill directories, loading skill content, and passing it to Weave's skill resolution API
- concrete model field selection
- harness-specific tool names and permissions
- command/event/hook registration
- display-name mapping
- runtime-specific lifecycle wiring

---

## Boundary Rules

### Weave Does

- Parse and validate `.weave` files.
- Merge builtin, global, and project config layers.
- Resolve prompt file paths and produce normalized config.
- Build or describe prompts and delegation instructions.
- Generate descriptors for declared agents and category shuttles.
- **Accept harness-provided context** (available skills, available models, etc.) and **return resolved/composed output** (resolved skills for an agent, composed prompts, resolved models).
- Expose adapter-facing helpers for common translation policies when useful.

### Weave Does Not

- Query a harness user's currently selected UI model.
- Require harnesses to expose a selected model or available model registry.
- **Discover or load skills from disk** — skill file discovery is a harness/adapter concern; Weave receives skill data and resolves it against agent config.
- Mutate harness runtime state directly.
- Decide how a specific harness represents agents, commands, tools, or display names.
- Treat legacy OpenCode plugin behavior as universal core behavior.

---

## Adapter-to-Weave API Pattern

Weave’s engine exposes **pure composition APIs** that adapters call by pushing harness-owned context in and receiving normalized output back. This is the fundamental interaction pattern between adapters and core Weave:

```txt
Adapter                          Weave API                        Output
──────────────────────────────────────────────────────────────────────────────────
 availableModels      ──▶  resolveAdapterModelIntent()  ──▶  resolved model
 uiSelectedModel

 availableSkills      ──▶  resolveSkillsForAgent()      ──▶  matched skills
 agentConfig

 resolvedSkills       ──▶  composeAgentPrompt()         ──▶  final prompt string
 agentConfig             (future — #6)
 promptFileContent
```

Key principles:

- **Adapters own discovery.** The harness knows where skills live, what models are available, and what the user has selected. The adapter gathers this context and passes it to Weave.
- **Weave owns composition.** Given harness context + declared config, Weave resolves, matches, filters, and composes the output. This logic is pure, testable, and harness-agnostic.
- **No harness-specific side effects in core.** Weave’s resolution and composition APIs must not query harness UI state, scan harness-owned resource directories, register concrete harness hooks, or mutate harness runtime state. They accept explicit input and return `Result<T, E>` or normalized output.

This pattern ensures the same Weave API works identically regardless of whether the adapter is for OpenCode, Pi, Claude Code, or any future harness. See [Adapter Boundary](adapter-boundary.md) for ownership rules, correct data-flow examples, and anti-patterns.

---

## Project Halves

Weave has two equally important halves:

1. **Core Weave API** — the DSL parser, config loader, merge logic, normalized config types, prompt/delegation builders, and shared policies. This half answers: "What agent system did the user declare?"
2. **Adapters** — harness-specific packages for OpenCode, Pi, Claude Code, Hermes, and future targets. This half answers: "How do we make this declared system work inside this harness?"

The core API should provide all functions needed to read, validate, merge, and normalize config from the DSL. Adapters should contain the harness-specific logic needed to turn that config into a working harness integration.

---

## Adapter Ownership

Adapters consume Weave's normalized intent and produce a concrete harness integration. If a harness supports concepts such as a UI-selected model, model registry, default agent, plugin lifecycle hooks, or display-name remapping, those are adapter concerns.

Adapters also own feature parity work. When a harness lacks functionality that Weave needs, the adapter should provide it when possible. For example, if Pi does not have native sub-agent behavior, the Pi adapter may need to implement sub-agent orchestration itself. If OpenCode already has native or plugin-friendly equivalents, the OpenCode adapter can map to those. If Claude Code lacks some non-essential capability, the adapter can document the missing behavior and still support the subset that works.

A shared helper may exist to make adapter behavior consistent, but it must accept harness state as explicit input. It must not reach from core Weave into UI state or runtime APIs.

---

## Harness Support Strategy

Weave's target is broad harness portability, but support should grow from the harnesses the project actively uses and can validate:

1. **OpenCode first** — highest priority because it is the legacy implementation target and the clearest migration path.
2. **Pi next** — high priority because it is actively used and may require adapter-built features such as sub-agent behavior.
3. **Claude Code / Hermes / others later** — explore once the core API and first adapters stabilize. These adapters may start with partial support if a harness lacks non-critical capabilities.

A harness adapter does not need perfect feature parity on day one. It must clearly document supported, emulated, degraded, and unsupported capabilities so users understand what the single `.weave` config can do in that harness.

---

## Adapter Capability Contract

Adapters do not need perfect feature parity on day one, but they must make
partial support **explicit and structured**. The **Adapter Capability Contract**
(Spec 07) provides the vocabulary:

| Readiness level | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `native`        | The harness implements the capability directly.                          |
| `emulated`      | The adapter provides equivalent behavior; satisfies required capabilities. |
| `degraded`      | Partial support only; behavior may be incomplete or unreliable.          |
| `unsupported`   | The harness does not support this capability at all.                     |

The **Core Readiness Profile** evaluates these declarations:

- Required + `native` or `emulated` → **pass**
- Required + `degraded` or `unsupported` → **fail** (blocks readiness)
- Optional + `degraded` or `unsupported` → **warning** (non-blocking)
- Missing required capability → **fail**
- Missing optional capability → **warning**

This replaces the binary `HarnessInstaller.supported: boolean` signal in
`packages/cli/src/installers/index.ts`. That boolean is a legacy installer
signal that capability readiness complements now and may supersede for richer
status reporting in future adapter work.

See [Spec 07 — Adapter Capability Contract](specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md)
and [Adapter Boundary](adapter-boundary.md) for implementation details.

---

## Legacy Architecture Guidance

[`docs/legacy-architecture.md`](legacy-architecture.md) documents the old OpenCode-specific system. It is useful as a source of implementation ideas and migration context, but it is not the product vision for the harness-agnostic successor.

When legacy behavior conflicts with this document, prefer this document. In particular, legacy model-resolution behavior that depended on OpenCode's UI-selected model should be treated as OpenCode adapter translation behavior, not core Weave behavior.
