# Weave Documentation

This is the top-level entry point for Weave's documentation corpus. Start here to navigate guides, architecture decision records (ADRs), and formal specs.

The published docs site is built from the Astro + Starlight package at [`packages/docs/`](../packages/docs/README.md). That package is for **public documentation** and the marketing landing page. This `docs/` directory remains the **internal documentation corpus** for architecture, ADRs, specs, and implementation guidance.

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
| [CLI](cli.md) | `weave validate`, `weave init`, `weave init migrate`, `weave eval run`, harness detection |
| [DSL Reference](dsl-reference.md) | Canonical `.weave` DSL syntax reference (agents, categories, workflows, settings) |
| [System Architecture](system-architecture.md) | Package structure, layer responsibilities |
| [Claude Code Adapter](claude-code-adapter.md) | Claude Code adapter materialization |
| [Copilot Adapter](copilot-adapter.md) | GitHub Copilot adapter status, context, decision, and consequences |
| [Copilot Adapter Guide](adapters/copilot.md) | Practical install path (`--add-dir`), generated layout, `weave compose --adapter copilot` status, known deprecations |
| [OpenCode V2 Adapter](opencode2-adapter.md) | `@weaveio/weave-adapter-opencode2` — independent V2 adapter package (no shared code with V1); see [Spec 34](specs/34-spec-opencode2-adapter/34-spec-opencode2-adapter.md) and [ADR 0010](adr/0010-opencode2-independent-adapter.md) |
| [Claude Code Adapter Guide](adapters/claude-code.md) | Two-plugin model, installation, tool policy mapping, model aliases, edge cases |
| [Adapter Readiness Status](adapter-readiness-status.md) | Per-adapter capability readiness declarations |
| [Harness Agent Surface Patterns](harness-agent-surface-patterns.md) | Patterns for adapter-side agent surface materialization |
| [Agent Evals](agent-evals.md) | Eval architecture, the shared eight-suite text-only registry surface plus the Phase 1 harness trajectory track (Spec 33, ADR 0008), fixture layout, CLI usage, dry-run validation behavior, filter semantics, forbidden text-only assertion shapes, prompt snapshot coverage, registry-driven sync tests, recommended case-authoring pattern, prompt-hash provenance, immutable run bundle schema, `schemaVersion` mandate, dashboard index derivation, sanitization rules, raw-artifact policy, CI model, and the 2026-06-30 phase-1 fairness-gate plus phase-2 prompt-quality-gate decisions |
| [Eval Sanitization and Publish Pipeline](eval-sanitization-and-publish-pipeline.md) | Allowlist sanitizer, deterministic bundle writer, raw artifact writer, token-gated publish policy, `schemaVersion` and freshness rules, website data flow, `/evals/` legacy coexistence |
| [Eval XSS Policy](eval-xss-policy.md) | Markdown and report rendering XSS policy, `explanation` field schema-level blocking, `escapeHtml()` requirements, banned rendering paths, defence-in-depth layers, test coverage |
| [Category Routing Findings](category-routing-findings.md) | Phase 1 prompt-enrichment eval results, acceptance gate outcomes, token cost, scaling data, and Phase 2 deterministic matcher decision |
| [Legacy Architecture](legacy-architecture.md) | Alpha / OpenCode-era reference (read-only history) |
| [Release Runbook](../RELEASING.md) | Tag-based release procedure and npm publishing workflow |

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
| [ADR 0007 — Artifact-First OIDC Releases](adr/0007-artifact-first-oidc-releases.md) | **Superseded** — Bundled public packs, OIDC channels, immutable release records, and no-unpublish policy. See [`RELEASING.md`](../RELEASING.md) for the current tag-based release system. |
| [ADR 0008 — Harness Trajectory Evals via Two-Channel Observation](adr/0008-harness-trajectory-evals.md) | **Accepted (2026-09-03)** — Adds a runtime-backed trajectory eval track alongside the text-only surface; adapters observe via runtime log parsing (Channel A) or plugin hooks (Channel B). Phase 1 shipped Channel A only. See [Spec 33](specs/33-spec-harness-trajectory-evals/33-spec-harness-trajectory-evals.md) for the formal contract. |
| [ADR 0010 — OpenCode V2 Adapter as a Separate Independent Package](adr/0010-opencode2-independent-adapter.md) | Separate independent V2 adapter package, no auto-selection, V1 remains fully supported, `ctx.agent.transform` + `Registration.dispose()` reconciliation |
| [ADR 0011 — Model Recommendation Manifest](adr/0011-model-recommendation-manifest.md) | Model recommendation manifest format and resolution semantics for the opencode2 adapter |

---

## Formal Specs

Numbered specs define subsystem requirements with acceptance criteria. See [docs/specs/README.md](specs/README.md) for the full index.

---

## Artifact Policy

Proof artifacts, audit trails, and validation checklists are non-normative historical records. They live under [`docs/artifacts/`](artifacts/README.md) and are governed by the [Documentation Policy](documentation-policy.md).

---

## Documentation Policy

See [docs/documentation-policy.md](documentation-policy.md) for the classification of durable vs. non-normative artifacts and the rules for where each type belongs.
