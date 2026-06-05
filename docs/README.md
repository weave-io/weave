# Weave Documentation

This is the top-level entry point for Weave's documentation corpus. Start here to navigate guides, architecture decision records (ADRs), and formal specs.

---

## Conceptual Guides

| Guide | What it covers |
| --- | --- |
| [Product Vision](product-vision.md) | Harness-agnostic architecture, core mental model, boundary rules |
| [Adapter Boundary](adapter-boundary.md) | Engine/adapter ownership matrix, correct data-flow examples, anti-patterns |
| [Adapter Bootstrap Guide](adapter-bootstrap.md) | `loadConfig` → `materializeAgents` → adapter loop pattern |
| [Config Loading](config-loading.md) | Three-layer merge, builtin agents, config discovery, prompt file resolution |
| [Model Resolution](model-resolution.md) | Model intent, adapter responsibility, category shuttle model preferences |
| [Prompt Composition](prompt-composition.md) | Mustache templates, delegation section, template context fields |
| [Tool Policy Evaluation](tool-policy-evaluation.md) | Abstract capabilities, `EffectiveToolPolicy`, adapter mapping |
| [Workflow Schema](workflow-schema.md) | Workflow fields, step types, completion methods, artifact passing |
| [CLI](cli.md) | `weave validate`, `weave init`, `weave init migrate`, harness detection |
| [DSL Reference](dsl-reference.md) | Canonical `.weave` DSL syntax reference (agents, categories, workflows, settings) |
| [System Architecture](system-architecture.md) | Package structure, layer responsibilities |
| [Claude Code Adapter](claude-code-adapter.md) | Claude Code adapter materialization |
| [Adapter Readiness Status](adapter-readiness-status.md) | Per-adapter capability readiness declarations |
| [Harness Agent Surface Patterns](harness-agent-surface-patterns.md) | Patterns for adapter-side agent surface materialization |
| [Legacy Architecture](legacy-architecture.md) | Alpha / OpenCode-era reference (read-only history) |

---

## Architecture Decision Records (ADRs)

ADRs record decisions with meaningful trade-offs. They are durable — once accepted, they are not rewritten.

| ADR | Decision |
| --- | --- |
| [ADR 0001 — Prompt Composition Templates](adr/0001-prompt-composition-templates.md) | Mustache as the prompt template engine |
| [ADR 0002 — Runtime Persistence Store](adr/0002-runtime-persistence-store.md) | SQLite-backed Runtime Store under `.weave/runtime/` |
| [ADR 0003 — OpenCode Adapter Materialization Shape](adr/0003-opencode-adapter-materialization-shape.md) | OpenCode plugin materialization contract |
| [ADR 0004 — Workflow-First Execution Contract](adr/0004-workflow-first-execution-contract.md) | `startExecution` as the sole authorized execution entry point |
| [ADR 0005 — Remediation Decisions for Specs 24–28](adr/0005-five-spec-remediation-decisions.md) | Accepted answers to open questions across Specs 24–28 |
| [ADR 0006 — End-to-End Orchestration Flow](adr/0006-end-to-end-orchestration-flow.md) | Full Loom → Pattern → Tapestry → Weft/Warp flow; legacy vs. current model; where issue #52 fits. **Note:** the "add default_workflow" guidance in the "Where Issue #52 Fits" section is superseded by [Spec 29](specs/29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) — ordinary usage is Loom-led, not workflow-driven. |

---

## Formal Specs

Numbered specs define subsystem requirements with acceptance criteria. See [docs/specs/README.md](specs/README.md) for the full index.

---

## Artifact Policy

Proof artifacts, audit trails, and validation checklists are non-normative historical records. They live under [`docs/artifacts/`](artifacts/README.md) and are governed by the [Documentation Policy](documentation-policy.md).

---

## Documentation Policy

See [docs/documentation-policy.md](documentation-policy.md) for the classification of durable vs. non-normative artifacts and the rules for where each type belongs.
