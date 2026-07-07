# 22-spec-workflow-first-execution.md

**Related**: [Context Glossary](../../../CONTEXT.md) · [Product Vision](../../product-vision.md) · [Adapter Boundary](../../adapter-boundary.md) · [ADR 0004 — Workflow-First Execution Contract](../../adr/0004-workflow-first-execution-contract.md) · [Spec 07: Adapter Capability Contract](../07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md) · [Spec 17: Workflow Extension](../17-spec-workflow-extension/17-spec-workflow-extension.md) · [Spec 19: Plan State Provider](../19-spec-plan-state-provider/19-spec-plan-state-provider.md)

## Introduction/Overview

This feature defines a workflow-first execution model for Weave so execution semantics no longer depend on a legacy OpenCode-only `/start-work` → Tapestry flow. The goal is to make planning, execution, artifact approval, reconciliation, and workflow extension explicit engine-owned concepts that adapters can expose through harness-appropriate commands, skills, hooks, scripts, or UI.

## Goals

- Define an engine-owned execution contract that works across harnesses without assuming same-session agent switching.
- Make the default workflow explicitly plan-oriented, with one canonical planning step and an optional `before-plan` extension surface.
- Make artifact identity, revision, approval, and consumption explicit workflow semantics rather than incidental chat context.
- Support workflow-level and step-level prompt composition without requiring full step replacement.
- Keep adapter responsibilities clear: adapters deliver the contract, but the engine owns the semantics.

## User Stories

- **As a Weave maintainer**, I want execution to be modeled as a workflow contract so that core behavior is portable across OpenCode, Claude Code, Pi, and future harnesses.
- **As a workflow author**, I want to extend the default planning flow with reviewed pre-plan steps so that I can add specification or requirement-sharpening work without replacing planning itself.
- **As an adapter author**, I want the engine to define start/resume/pause/reconciliation semantics so that I only need to map them into my harness's delivery mechanisms.
- **As a user running Weave**, I want planning and execution to consume approved artifacts explicitly so that workflow behavior is inspectable and reproducible.

## Demoable Units of Work

### Unit 1: Workflow-first execution contract

**Purpose:** Define the portable execution semantics that replace legacy harness-specific assumptions.

**Functional Requirements:**
- The system shall define execution as an engine-owned workflow contract for starting, resuming, pausing, inspecting, and advancing durable execution.
- The system shall require an explicit, user-authorized execution boundary rather than allowing ordinary Loom chat to silently become durable execution.
- The system shall forbid agents, idle hooks, continuation hooks, or lifecycle events from implicitly starting durable execution without an explicit user-authorized transition.
- The system shall define adapters as delivery layers that expose the execution contract through harness-specific commands, skills, hooks, scripts, or UI.
- The system shall keep execution state grounded in engine-owned runtime concepts such as `WorkflowInstance` and `ExecutionLease`.

**Proof Artifacts:**
- Document: spec section describing the execution contract demonstrates the portable runtime model.
- Document: companion ADR records the architectural decision and why legacy Tapestry behavior is no longer the core model.
- Validation artifact: future schema or validation notes demonstrate ordinary chat does not implicitly start execution.

### Unit 2: Plan-oriented default workflow with `before-plan` extension

> **⚠ Partial supersession** — The phrase "effective default workflow" in this unit originally implied that ordinary Weave usage is driven by an implicit builtin workflow. [Spec 29 — Default Usage Is Not Workflow-Driven](../29-spec-default-usage-not-workflow-driven/29-spec-default-usage-not-workflow-driven.md) supersedes that implication: ordinary usage is Loom-led, and workflows are explicit, user-invoked constructs. The `before-plan` extension surface, `role planning` step, and `extension_points { before-plan }` publication syntax defined in this unit remain valid for named workflow execution. Read "effective default workflow" below as "the canonical named workflow (`plan-and-execute`) when a user explicitly invokes it."

**Purpose:** Define the baseline workflow shape so users can extend planning without replacing it.

**Functional Requirements:**
- The system shall treat the effective default workflow as plan-oriented.
- The system shall require exactly one canonical planning step per workflow.
- The system shall allow selected workflows to publish a workflow-level `before-plan` extension point through a dedicated DSL block.
- The system shall publish `before-plan` through a thin workflow-level block using dedicated publication syntax such as `extension_points { before-plan }`, while keeping composition syntax distinct from publication syntax.
- The system shall treat generic workflow derivation (`extends`, `insert_before`, `insert_after`) as a config-merge concern, while treating `before-plan` publication as an engine-visible workflow contract for selected workflows.
- The system shall allow composed steps to target the published slot through separate composition syntax such as `extend before-plan [ ... ]` after generic config-merge resolution.
- The system shall define `before-plan` as an extension surface that may enrich planning inputs but shall not replace the planning step.
- The system shall allow `before-plan` steps to produce multiple named artifacts and to consume artifacts from earlier `before-plan` steps.
- The system shall limit the initial built-in extension-point contract set to `before-plan`.
- The system shall allow `before-plan` steps to pause, retry, and revise artifacts in v1, but it shall not allow `before-plan` steps to participate in reconciliation semantics.

**Proof Artifacts:**
- DSL example: workflow definition with one planning step and a published `before-plan` extension block demonstrates the structural model.
- Validation rule: workflow validation rejects missing or duplicated planning steps and invalid `before-plan` publication.
- Example artifact flow: reviewed specification artifact feeding planning demonstrates pre-plan extensibility without replacing planning.

### Unit 3: Artifact approval, provenance, and reconciliation

**Purpose:** Make planning and execution inputs explicit, approved, and reproducible.

**Functional Requirements:**
- The system shall model workflow artifacts with a logical identity separate from file path.
- The system shall assign monotonic revisions to each artifact identity.
- The system shall bind each artifact revision to immutable content or a verifiable integrity fingerprint without storing raw artifact contents in runtime state.
- The system shall track first-class approval state bound to a specific artifact revision.
- The system shall invalidate approval automatically when a new artifact revision is created.
- The system shall forbid artifact producers from self-approving the artifacts they produce.
- The system shall require planning and execution steps to declare explicit normative and informational artifact inputs.
- The system shall record consumed revisions for all explicit artifact inputs on each step attempt.
- The system shall verify the current artifact contents against the bound immutable revision or integrity fingerprint at consumption time and fail closed on mismatch.
- The system shall reuse the same consumed artifact revisions on retry by default.
- The system shall require an explicit workflow transition to rebind a step to newer approved artifact revisions.
- The system shall define reconciliation as workflow semantics with a closed initial built-in reason set: `execution-mismatch`, `user-revision-request`, `review-rejection`, and `security-rejection`.
- The system shall require reconciliation reasons and artifact approvals to come from authorized sources: `user-revision-request` from explicit user action, `review-rejection` from the review gate, `security-rejection` from the security gate, and `execution-mismatch` from runtime validation or execution checks.
- The system shall route reconciliation to the nearest explicitly declared upstream handler step in workflow order and pause or block if no handler exists.
- The system shall require review and security gates to re-run after reconciliation resolves a review- or security-originated rejection.
- The system shall prevent reconciliation from revising completed `Plan Markdown` tasks; corrective work shall be expressed as follow-up tasks.

**Proof Artifacts:**
- Validation rule: planning or execution step definitions missing explicit artifact input declarations fail schema or validation checks.
- Example runtime record: consumed artifact identity + revision provenance demonstrates reproducible execution inputs.
- Example reconciliation flow: plan revision triggered by review rejection demonstrates handler routing and immutable completed tasks.

### Unit 4: Prompt composition and adapter-readiness alignment

**Purpose:** Allow composable workflow guidance while preserving adapter-boundary clarity.

**Functional Requirements:**
- The system shall allow workflow-level prompt appends for run-wide guidance.
- The system shall allow step-level prompt appends for step-local guidance.
- The system shall express workflow-level and step-level prompt appends through `prompt_append` and `prompt_append_file`, preserving the existing mutual-exclusion convention at each scope.
- The system shall allow ordered multiple prompt appends at both scopes using final merged configuration order.
- The system shall define step-local guidance as taking precedence when workflow-level and step-level prompt appends conflict, while same-scope conflicts remain last-append-wins in final merged configuration order.
- The system shall define last-append-wins for conflicting appends at the same scope while surfacing conflicts in tooling or inspection.
- The system shall treat workflow- and step-level prompt appends as trusted config-authored prompt text rendered against bounded template context, and it shall not interpolate untrusted artifact contents or incidental chat text into append instructions.
- The system shall align adapter readiness and capability modeling with the canonical execution command concept through the existing Spec 07 `command-entrypoints` capability, with `workflow-step-dispatch` as supporting execution context.

**Proof Artifacts:**
- DSL example: workflow + step prompt append composition demonstrates both scopes and precedence rules.
- Inspection artifact: composed prompt output demonstrates merged append order and step-local precedence.
- Capability/readiness note: adapter capability guidance demonstrates canonical execution command support is evaluated explicitly rather than assumed.

## Non-Goals (Out of Scope)

1. **Full adapter implementation**: This spec does not implement OpenCode, Claude Code, or Pi runtime delivery paths.
2. **Legacy command preservation**: This spec does not require `/start-work` or Tapestry to remain the architectural center of execution.
3. **Arbitrary extension contracts**: This spec does not introduce user-defined extension-point rule languages in the first version.
4. **Raw-skill runtime nodes**: This spec does not allow skills to execute as first-class workflow nodes outside workflow steps.
5. **Automatic latest-artifact rebinding**: This spec does not allow silent rebinding to newer approved artifacts during retry or reconciliation.
6. **`before-plan` reconciliation handlers**: This spec does not allow `before-plan` steps to participate directly in reconciliation semantics in the first version.

## Design Considerations

No specific visual design requirements identified. The main UX consideration is conceptual clarity: ordinary Loom conversation remains conversational, while execution begins only through an explicit execution transition and runs against visible workflow structure, approved artifacts, and inspectable prompt composition.

## Repository Standards

- Follow `docs/product-vision.md` and `docs/adapter-boundary.md`; engine owns harness-agnostic semantics, adapters own harness delivery.
- Keep the DSL-first design principle: built-ins and user-authored workflows use the same `.weave` language surface.
- Use Bun-only assumptions; do not introduce Node runtime APIs.
- Use `neverthrow`-based error handling for fallible internal logic where repository rules permit.
- Preserve the repository's documentation-first workflow by updating specs, ADRs, and related docs in the same change set.
- Keep validation rules explicit and junior-readable rather than relying on hidden runtime conventions.
- Follow existing spec patterns under `docs/specs/` with demoable units, proof artifacts, and clear out-of-scope boundaries.

## Technical Considerations

- No latest-standards research was needed. This feature is an internal workflow/DSL architecture change rather than a library-, framework-, or vendor-API-driven feature.
- The repository already distinguishes engine-owned semantics from adapter-owned delivery; this spec should build on that boundary rather than reintroducing legacy OpenCode assumptions.
- Existing runtime concepts such as `WorkflowInstance`, `ExecutionLease`, `Runtime Store`, `Runtime Journal`, and `Plan Markdown` should remain the vocabulary for execution semantics.
- Existing workflow capabilities in `packages/engine/src/execution-lifecycle.ts` and `docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md` provide a base for explicit workflow execution without depending on harness-specific session control.
- `docs/specs/17-spec-workflow-extension/17-spec-workflow-extension.md` already defines generic workflow derivation and anchor-based insertion as a `@weaveio/weave-config` merge concern. This spec does not replace that mechanism; it adds an engine-visible semantic contract for selected workflows that publish a `before-plan` extension surface after config merge resolution.
- The dedicated publication syntax for `before-plan` should stay thin: publication declares that the selected workflow exposes the slot, while separate composition syntax provides the inserted steps. The two roles should not be conflated in one DSL form.
- The spec should preserve the invariant that plan-oriented workflows produce and consume `Plan Markdown`, while allowing approved pre-plan artifacts such as specification artifacts to constrain planning and execution explicitly.
- The initial version should prefer closed built-in workflow semantics over open-ended rule systems so validation, tooling, and adapter readiness remain deterministic.
- Adapter capability/readiness work should build on the existing vocabulary in `docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md`, especially `native`, `emulated`, `degraded`, and `unsupported`, rather than inventing a parallel readiness model for execution commands.
- Workflow- and step-level prompt append DSL should mirror existing prompt conventions by using `prompt_append` / `prompt_append_file` rather than inventing a parallel append vocabulary.
- Canonical execution-command support in non-command harnesses should be modeled through Spec 07 `command-entrypoints` readiness values: `native` for direct command support, `emulated` for equivalent explicit skill/script/UI delivery, `degraded` for incomplete or inconsistent explicit delivery, and `unsupported` when no reliable explicit start path exists.
- Integrity verification should persist metadata only: runtime records may store a revision-bound integrity fingerprint or equivalent verification token, but they shall not store raw artifact contents.

## Security Considerations

- The system shall not treat incidental chat history as an implicit source of approved execution inputs.
- The system shall require explicit authorization for crossing the durable execution boundary and shall not allow agents, hooks, or lifecycle events to self-start execution.
- Artifact approval and revision tracking shall make it clear which reviewed content was consumed by planning or execution.
- Artifact approval shall bind to a specific immutable revision or integrity-verified fingerprint so approved content cannot be swapped after approval without invalidation.
- Approval state and reconciliation reasons shall be attributable to authorized actors or gate outcomes rather than free-form runtime text.
- Reconciliation shall fail closed by pausing or blocking when no explicit handler exists for a reconciliation reason.
- Reconciliation that originates from review or security rejection shall require the corresponding gate to re-run before execution may continue.
- Workflow- and step-level prompt appends shall not ingest untrusted artifact contents as prompt instructions.
- Proof artifacts for future implementation shall avoid exposing secrets, tokens, private prompts, or sensitive local paths.
- Adapter delivery of the execution contract shall not require engine code to inspect harness-owned secrets or runtime-private state.

## Success Metrics

1. **Portable execution model**: the spec clearly defines execution semantics that another adapter can implement without assuming OpenCode-only runtime behavior.
2. **Explicit workflow inputs**: planning and execution requirements rely on declared artifacts, approvals, and revisions rather than incidental chat context.
3. **Spec usability**: a junior developer can derive schema, validation, runtime, and adapter follow-up tasks from the demoable units without needing hidden design context.

## Open Questions

No open questions at this time.
