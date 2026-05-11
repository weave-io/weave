# Product Vision

Weave is a harness-agnostic agent orchestration framework and API for building agent-harness experiences. Users provide a single `.weave` configuration that describes the agent system once; supported harnesses consume that same normalized config through adapters.

It is closer to Neovim's API layer than to a finished editor: Weave defines the primitives, config model, prompt/delegation structure, and policy intent that adapters compose into concrete harness integrations.

**Related:** [Model Resolution](model-resolution.md) · [Config Loading](config-loading.md) · [Spec 04 — Agent Model Resolution](specs/04-spec-agent-model-resolution/04-spec-agent-model-resolution.md) · [Legacy Architecture](legacy-architecture.md)

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

Weave's responsibility is to describe **what agent system should exist**:

- agent topology and names
- prompts and prompt appendices
- delegation metadata for Loom/Tapestry
- categories and generated category shuttle descriptors
- abstract tool/capability policy
- ordered model preferences
- workflow intent

Adapters are responsible for deciding **how that intent becomes harness behavior**:

- enabling Weave inside a specific harness
- harness plugin/config generation
- filling feature gaps when a harness lacks native functionality
- UI-selected model lookup and interpretation
- available model discovery
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
- Expose adapter-facing helpers for common translation policies when useful.

### Weave Does Not

- Query a harness user's currently selected UI model.
- Require harnesses to expose a selected model or available model registry.
- Mutate harness runtime state directly.
- Decide how a specific harness represents agents, commands, tools, or display names.
- Treat legacy OpenCode plugin behavior as universal core behavior.

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

## Legacy Architecture Guidance

[`docs/legacy-architecture.md`](legacy-architecture.md) documents the old OpenCode-specific system. It is useful as a source of implementation ideas and migration context, but it is not the product vision for the harness-agnostic successor.

When legacy behavior conflicts with this document, prefer this document. In particular, legacy model-resolution behavior that depended on OpenCode's UI-selected model should be treated as OpenCode adapter translation behavior, not core Weave behavior.
