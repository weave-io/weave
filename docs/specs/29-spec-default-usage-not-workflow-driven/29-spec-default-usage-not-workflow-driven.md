# 29-spec-default-usage-not-workflow-driven.md

**Related**: [Issue #52](https://github.com/jose/weave/issues/52) · [Product Vision](../../product-vision.md) · [Adapter Boundary](../../adapter-boundary.md) · [ADR 0004 — Workflow-First Execution Contract](../../adr/0004-workflow-first-execution-contract.md) · [ADR 0006 — End-to-End Orchestration Flow](../../adr/0006-end-to-end-orchestration-flow.md) · [Workflow Schema](../../workflow-schema.md) · [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md)

## Introduction/Overview

This feature redefines Weave's ordinary default usage so it is not driven by an implicit builtin workflow. The goal is to make the default path easy to reason about: Loom handles ordinary orchestration and pre-plan guidance, Pattern creates a plan artifact when needed, and `/start-work` begins execution only after a plan already exists.

## Goals

- Make default Weave usage Loom-led instead of workflow-led.
- Keep workflows explicit, user-invoked constructs rather than hidden default behavior.
- Separate plan creation from plan execution so users can inspect and approve a plan before execution starts.
- Move default pre-plan behavior into Loom configuration and prompt composition rather than workflow extension machinery.
- Align docs, builtins, runtime guidance, and tests around one clear default mental model.

## User Stories

- **As a Weave user**, I want ordinary chat with Loom to stay conversational so that planning and execution do not start implicitly.
- **As a Weave maintainer**, I want the default path to be clearly separated from explicit workflows so that the architecture is easier to document, test, and evolve.
- **As an adapter author**, I want `/start-work` to operate on an existing plan artifact so that execution entry remains explicit and portable across harnesses.
- **As a workflow author**, I want workflows to remain optional, named tools so that default orchestration does not depend on workflow internals.

## Demoable Units of Work

### Unit 1: Default orchestration model is Loom-led

**Purpose:** Define the ordinary Weave path so users and maintainers can distinguish normal orchestration from explicit workflow execution.

**Functional Requirements:**
- The system shall define ordinary Weave usage as Loom-led orchestration rather than an implicit builtin workflow.
- The system shall treat workflows as explicit, user-invoked constructs rather than the default behavior of ordinary chat.
- The system shall forbid builtin configuration, docs, or adapter guidance from describing a hidden default workflow that silently owns standard planning behavior.

**Proof Artifacts:**
- Document: updated spec and ADR language demonstrates the default path is Loom-led.
- Documentation diff: updated README or architecture guidance demonstrates that workflows are explicit rather than implicit defaults.
- Test or validation note: assertions around builtin defaults demonstrate no implicit default workflow is selected for ordinary usage.

### Unit 2: Plan creation and execution are separate user-visible stages

**Purpose:** Ensure users can create a plan before execution begins, preserving an explicit approval boundary.

**Functional Requirements:**
- The system shall define Pattern plan creation as a pre-execution step that can occur during ordinary Loom orchestration.
- The system shall define `/start-work` as operating on an existing plan artifact rather than as the command that creates the plan.
- The system shall keep plan creation and plan execution as separate concepts in runtime guidance, adapter behavior, and documentation.

**Proof Artifacts:**
- Document: sequence description or diagram demonstrates Loom → Pattern plan creation → user runs `/start-work` → Tapestry execution.
- CLI or UX artifact: `/start-work` help text or command contract demonstrates it expects an existing plan or existing plan context.
- Test: adapter or runtime test demonstrates execution does not begin until an explicit start action occurs after plan creation.

### Unit 3: Default pre-plan behavior belongs to Loom, not workflow extension

**Purpose:** Keep the default architecture simple by placing pre-plan policy in Loom configuration and prompt composition.

**Functional Requirements:**
- The system shall place default pre-plan guidance in Loom configuration, Loom prompt text, or other Loom-owned orchestration surfaces.
- The system shall not require workflow extension points such as `before-plan` to describe ordinary default behavior.
- The system shall preserve explicit workflows and workflow extensions as optional capabilities that users invoke intentionally.

**Proof Artifacts:**
- Builtin config artifact: Loom prompt or config diff demonstrates pre-plan guidance lives in Loom-owned configuration.
- Documentation artifact: workflow schema or architecture docs demonstrate `before-plan` is optional workflow machinery, not the ordinary default path.
- Test: builtin config or prompt-composition test demonstrates the default pre-plan route is available without selecting a workflow.

### Unit 4: Existing architecture docs and specs are reconciled to one model

**Purpose:** Remove conflicting guidance so junior developers can follow one clear source of truth.

**Functional Requirements:**
- The system shall update durable docs that currently describe default usage as workflow-driven so they match the Loom-led model.
- The system shall explicitly mark any superseded default-workflow guidance in older docs or specs to prevent conflicting architectural interpretation.
- Older workflow-first or default-workflow docs shall receive a targeted supersession note where their default-workflow guidance conflicts with this spec.
- The system shall preserve the distinction between explicit workflow execution semantics and ordinary default orchestration semantics.

**Proof Artifacts:**
- Documentation diff: ADR 0006, Spec 22 follow-up language, and related guides demonstrate removal of conflicting default-workflow wording.
- Review artifact: linked spec references demonstrate one consistent mental model across docs/specs.
- Test or validation note: repository checks demonstrate updated docs and builtin expectations stay aligned.

## Non-Goals (Out of Scope)

1. **New workflow engine semantics**: This feature does not redesign the explicit workflow runtime established by existing execution specs.
2. **Full adapter implementation rewrite**: This feature does not require every harness adapter UX detail to be rebuilt in one step.
3. **Automatic workflow removal**: This feature does not remove explicit workflows such as `plan-and-execute`; it only removes their role as the hidden default path.

## Design Considerations

No specific visual design requirements identified. The main UX requirement is conceptual clarity: users should understand when they are chatting with Loom, when a plan is being created, and when execution begins.

## Repository Standards

- Follow the harness-agnostic engine/adapter boundary in [docs/adapter-boundary.md](../../adapter-boundary.md).
- Preserve the repository's DSL-first design: builtin behavior should be described through `.weave` config and prompt composition where appropriate.
- Keep docs as first-class deliverables by updating affected durable artifacts in `docs/`, ADRs, and specs together.
- Follow existing spec structure under `docs/specs/` with clear goals, demoable units, proof artifacts, and out-of-scope boundaries.
- Use Bun-only assumptions and repository-standard `neverthrow` error handling when follow-up implementation work touches fallible logic.
- Keep requirements junior-readable and explicit rather than relying on implied legacy behavior.

## Technical Considerations

- No latest-standards research was needed. This issue is an internal architecture and documentation change, not a library-, framework-, or vendor-API-driven feature.
- The issue body is the primary source of truth: default usage is not workflow-driven; workflows are explicit; pre-plan behavior belongs to Loom config/prompt composition; `/start-work` acts on an existing plan artifact.
- Existing docs create tension that follow-up work must reconcile, especially [ADR 0006](../../adr/0006-end-to-end-orchestration-flow.md), [Spec 22](../22-spec-workflow-first-execution/22-spec-workflow-first-execution.md), and [Workflow Schema](../../workflow-schema.md), which currently describe a workflow-first default path.
- Follow-up implementation should prefer clarifying or narrowing existing builtin behavior over adding new hidden workflow selection mechanisms such as an implicit `default_workflow` contract for ordinary usage.
- Explicit workflows, including workflow extension surfaces like `before-plan`, remain valid for named workflow execution, but they shall not be required to explain the default path.
- `plan-and-execute` should remain the preferred explicit named workflow example, but it shall not be treated as the hidden default path.
- Adapter behavior should continue to treat execution start as explicit and user-authorized, consistent with the existing workflow-first execution contract.
- For command-capable adapters, `/weave:start` should be preferred when feasible as the concrete explicit start command; however, concrete command names remain adapter-owned and the core contract stays harness-agnostic.

## Security Considerations

- The system shall preserve the explicit execution boundary so ordinary chat does not silently become durable execution.
- The system shall avoid any design that lets hooks, prompts, or adapters auto-start execution without a user-visible trigger.
- Plan artifacts used by `/start-work` shall remain inspectable and user-reviewable before execution begins.
- Proof artifacts for this work shall not include secrets, tokens, private prompts, or sensitive local-only data.

## Success Metrics

1. **Architectural clarity**: durable docs and builtin guidance describe one consistent default path with no conflicting hidden-workflow model.
2. **Explicit execution boundary**: `/start-work` is documented and validated as execution over an existing plan, not as implicit plan creation.
3. **Spec usability**: a junior developer can identify the required doc, builtin, and test follow-up work from this spec without needing issue-tracker context.

## Open Questions

No open questions at this time.
