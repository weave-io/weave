# Weave Context

Weave is a harness-agnostic prompt and agent-configuration system that turns declarative agent intent into concrete harness behavior.

## Language

**WorkflowInstance**:
A durable record of a workflow run's execution state, coordination metadata, and artifact references.
_Avoid_: Run state, workflow state blob, plan progress

**ExecutionLease**:
A coordination record that grants one actor permission to actively drive a workflow run.
_Avoid_: Workflow status, active flag, lock file

**Execution Contract**:
A harness-agnostic engine-owned semantic contract for starting, resuming, pausing, inspecting, and advancing Weave execution.
_Avoid_: Adapter command set, harness hook shape, executor persona

**Canonical Execution Command**:
A product-level command name that exposes part of the **Execution Contract** through a harness command surface when that harness supports commands.
_Avoid_: Legacy alias, adapter-private shortcut, workflow definition

**Default Workflow**:
The effective workflow Weave starts when execution begins without an explicitly named workflow.
_Avoid_: Legacy plan mode, executor agent, adapter alias

**Workflow Extension Point**:
A stable location in a workflow definition where additional steps may be composed in without replacing the whole workflow.
_Avoid_: Full workflow override, adapter preflight, hidden hook slot

**Specification Artifact**:
A user-reviewable artifact produced before planning that sharpens requirements and can be consumed as input to a planning step.
_Avoid_: Plan Markdown, implementation notes, workflow state

**Artifact Approval State**:
The workflow-owned state that records whether a named artifact has been approved for downstream consumption.
_Avoid_: Gate side effect, chat assumption, implicit review memory

**Artifact Identity**:
A stable logical identifier for a workflow artifact that persists across revisions and does not depend on file path alone.
_Avoid_: Raw file path, transient filename, prompt snippet

**Artifact Revision**:
A monotonic version of an **Artifact Identity** used to track approval and downstream consumption across revisions.
_Avoid_: Raw hash identity, opaque store token, file timestamp

**Normative Artifact Input**:
An explicit workflow step input whose approved contents constrain downstream behavior and must be obeyed.
_Avoid_: Optional hint, incidental context, unreviewed draft

**Informational Artifact Input**:
An explicit workflow step input that may inform downstream behavior without overriding normative constraints.
_Avoid_: Binding requirement, approved constraint, hidden prompt memory

**Step Prompt Append**:
Workflow-owned prompt text appended to a workflow step's base prompt so step behavior can be composed without replacing the whole step.
_Avoid_: Hidden adapter injection, full step replacement, incidental chat context

**Workflow Prompt Append**:
Workflow-owned prompt text appended at the workflow scope to express run-wide execution guidance without replacing step-local prompts.
_Avoid_: Step-local override, adapter injection, structural workflow change

**Runtime Store**:
The Weave-owned durable state space for workflow execution records, coordination records, and runtime observations.
_Avoid_: Harness storage, adapter storage, config state

**Runtime Journal**:
A chronological record of runtime observations used for debugging, audit, and correlation.
_Avoid_: Event-sourced state, replay log, source of truth

**SessionSnapshot**:
A normalized record of Weave-visible harness session observations associated with runtime execution.
_Avoid_: Raw harness dump, transcript archive, prompt log

**Paused Workflow**:
A workflow run that intentionally stops at a resumable point while waiting for user or policy direction.
_Avoid_: Blocked workflow, failed workflow

**Blocked Workflow**:
A workflow run that cannot proceed because a required input, artifact, or harness capability is unavailable.
_Avoid_: Paused workflow, failed workflow

**Cancelled Workflow**:
A workflow run that was intentionally stopped before completion and should not be resumed.
_Avoid_: Paused workflow, failed workflow

**Completion Signal**:
A normalized declaration that a workflow step with subjective completion criteria has finished or produced a verdict.
_Avoid_: Message marker, done text, assistant flag

**Plan Markdown**:
A human-readable plan document whose task list is the authoritative user-visible plan progress during dogfooding.
_Avoid_: Rendered plan, generated view, workflow state

**Execution Contract**:
A harness-agnostic engine-owned semantic contract for starting, resuming, pausing, inspecting, and advancing Weave execution.
_Avoid_: Adapter command set, harness hook shape, executor persona

**Execution Operation**:
One of the five explicit engine-owned operations that drive durable workflow execution: `start`, `resume`, `pause`, `inspect`, or `advance`. Modeled as the `ExecutionOperationKind` discriminated union in `@weave/engine`. `observeSession` and `beforeTool` are NOT execution operations — they are passive observations and policy evaluations that cannot start or advance execution.
_Avoid_: Lifecycle event, adapter hook, session observation

**inspectExecution**:
A read-only lifecycle method that returns a point-in-time snapshot of a `WorkflowInstance`'s current execution state without modifying any state, creating instances, acquiring leases, or emitting `LifecycleEffect` values. Safe to call from any adapter context including idle hooks and continuation hooks.
_Avoid_: startExecution, resumeExecution (which have side effects)

**Canonical Execution Command**:
A product-level command name that exposes part of the **Execution Contract** through a harness command surface when that harness supports commands.
_Avoid_: Legacy alias, adapter-private shortcut, workflow definition

**Artifact Approval State**:
Workflow-owned state recording whether a named artifact revision has been approved for downstream consumption.
_Avoid_: Gate side effect, chat assumption, implicit review memory

**Artifact Identity**:
A stable logical identifier for a workflow artifact that persists across revisions and does not depend on file path alone.
_Avoid_: Raw file path, transient filename, prompt snippet

**Artifact Revision**:
A monotonic version of an **Artifact Identity** used to track approval, integrity verification, and downstream consumption across revisions. A new revision always resets approval state to `pending`, invalidating any prior approval on the same artifact name.
_Avoid_: Raw hash identity alone, opaque store token, file timestamp

**Artifact Integrity Metadata**:
The engine-owned record (`ArtifactIntegrityMetadata`) stored inside an `ArtifactRef` that holds a SHA-256 digest for tamper detection. Contains only the hash algorithm identifier and a lowercase hex digest — never raw artifact contents, prompts, credentials, or private paths. Stored in the Runtime Store alongside the artifact reference; never in adapter-owned storage or harness session state.
_Avoid_: Raw artifact content, file hash stored outside the Runtime Store, adapter-computed integrity record

**Artifact Digest**:
A lowercase hex-encoded SHA-256 hash of an artifact's current file contents, computed by the adapter immediately before calling `dispatchStep`. Passed via `DispatchStepInput.artifactDigests` so the engine can compare it against the stored `ArtifactIntegrityMetadata.digest`. The engine never reads artifact file contents — digest computation is adapter-owned.
_Avoid_: Engine-computed hash, stored file content, raw artifact bytes

**Adapter Capability Contract**:
A harness-neutral declaration of which Weave behaviors a harness adapter can provide and with what level of readiness.
_Avoid_: Adapter feature list, harness support matrix

**Capability Readiness**:
The declared support level of an adapter behavior: native, emulated, degraded, or unsupported.
_Avoid_: Supported flag, feature status

**Readiness Profile**:
A named policy for deciding whether an adapter is ready for a specific Weave use case.
_Avoid_: Required flag, support tier

**Core Readiness Profile**:
The built-in readiness policy for the minimum adapter behavior Weave expects from a core harness integration.
_Avoid_: Dogfood profile, default profile

**Adapter Health Report**:
A runtime account of whether a harness adapter is currently usable in its environment.
_Avoid_: Capability declaration, support matrix

**TOON Output**:
A compact, deterministic text representation of Weave status data for LLM-oriented consumption.
_Avoid_: JSON, prose report, general serialization format

**Safe Adapter Init**:
A read-only preparation pass that lets an adapter verify local readiness without performing run side effects.
_Avoid_: Full adapter init, harness launch, deep health check

**Composed Prompt**:
The final prompt text produced by the engine from an agent's prompt source (inline `prompt` or `prompt_file`) plus any generated sections such as the `## Delegation` block and appended `prompt_append` text.
_Avoid_: System prompt, raw prompt, assembled prompt

**Prompt Template**:
A prompt source that contains placeholders resolved by Weave during prompt composition before it becomes a **Composed Prompt**.
_Avoid_: Prompt syntax, dynamic prompt, Handlebars prompt

**Template Context**:
The bounded data object Weave exposes to a **Prompt Template** for placeholder resolution.
_Avoid_: Prompt globals, runtime state, agent internals

**Delegation Diagram**:
A Mermaid representation of the delegation routes available from the current agent to eligible target agents.
_Avoid_: Delegation table, routing chart, agent map

**Canonical Agent Name**:
The stable logical identifier Weave uses to refer to an agent across composition, materialization, and reconciliation.
_Avoid_: Display name, UI label, rendered agent title

**Weave-managed Agent**:
An adapter-visible harness agent whose configuration lifecycle is owned by Weave rather than authored manually in the harness.
_Avoid_: Any same-named agent, UI alias, unmanaged agent

## Relationships

- A **WorkflowInstance** stores active execution metadata and artifacts for one workflow run.
- An **ExecutionLease** controls active ownership of a **WorkflowInstance** without replacing its lifecycle state.
- An **Execution Contract** defines execution semantics independently of the harness-specific command, skill, hook, or script mechanism that delivers them.
- A **Canonical Execution Command** is one possible adapter-visible projection of the **Execution Contract** and should be evaluated through adapter capability/readiness policy rather than assumed to exist in every harness.
- A **Default Workflow** is resolved by configuration and executed through the **Execution Contract** rather than implied by ordinary chat behavior.
- A **Workflow Extension Point** lets configuration compose additional workflow steps around a baseline workflow while preserving the baseline workflow's identity.
- A **Workflow Extension Point** is declared by name plus an explicit contract, not as an untyped merge slot.
- Workflow-level extension-point publication should use an explicit structured declaration rather than a bare name list or flag.
- Workflow-level extension-point publication should use a dedicated DSL block rather than a generic metadata field.
- The initial built-in **Workflow Extension Point** contract set contains only `before-plan`.
- A **Specification Artifact** may be produced in a `before-plan` extension step and reviewed before the planning step creates **Plan Markdown**.
- A `before-plan` extension band may produce multiple named artifacts, provided they use the standard artifact identity, revision, and approval model.
- A workflow has exactly one canonical planning step; `before-plan` steps may enrich its inputs but do not replace it.
- The canonical planning step should declare both its planning role and the reconciliation reasons it handles on the step itself.
- The planning step must explicitly declare which approved `before-plan` artifacts it consumes.
- In v1, `before-plan` steps may pause, retry, and revise artifacts, but they do not participate in reconciliation semantics.
- Post-plan approval attaches to a specific **Plan Markdown** artifact revision rather than to planning completion in the abstract.
- **Artifact Approval State** determines whether a named artifact may be consumed by downstream workflow steps.
- **Artifact Approval State** attaches to an **Artifact Identity** and is revision-sensitive rather than path-sensitive.
- An **Artifact Revision** is tracked per **Artifact Identity** and provides the human-visible version boundary for approval and consumption.
- A **Normative Artifact Input** constrains downstream planning or execution behavior.
- An **Informational Artifact Input** may assist downstream behavior but cannot override a **Normative Artifact Input**.
- All workflow steps, including planning and execution steps, may declare **Normative Artifact Inputs** and **Informational Artifact Inputs** explicitly.
- Workflow steps should record consumed **Artifact Revisions** for all explicit artifact inputs, not only normative ones.
- Step retries should reuse the same consumed **Artifact Revisions** by default rather than silently rebinding to newer revisions.
- Rebinding to newer approved **Artifact Revisions** requires an explicit workflow transition rather than automatic latest-approved lookup.
- Step re-entry versus new-attempt semantics should be workflow-defined, with planning reconciliation as the default special case that re-enters the same logical planning step.
- Reconciliation reasons are workflow-wide runtime semantics, while individual workflow steps explicitly declare which reasons they handle.
- When a reconciliation reason occurs, the workflow runtime should resolve the nearest explicitly declared handler step; if none exists, the workflow should pause or block rather than guessing.
- The initial built-in reconciliation reason set is: `execution-mismatch`, `user-revision-request`, `review-rejection`, and `security-rejection`.
- A **Workflow Prompt Append** applies run-wide execution guidance, while a **Step Prompt Append** applies step-local guidance.
- **Workflow Prompt Appends** follow the same ordered-multiple, final-merged-configuration ordering model as **Step Prompt Appends**.
- When **Workflow Prompt Appends** and **Step Prompt Appends** conflict, step-local guidance wins.
- A **Step Prompt Append** composes step-specific behavior explicitly within workflow configuration rather than through adapter-side prompt injection, and steps may support ordered multiple appends.
- Ordered multiple **Step Prompt Appends** are applied in final merged configuration order rather than by explicit priority or weight.
- When **Step Prompt Appends** conflict, later appends win for instruction emphasis, but tooling/inspection should surface the composition risk.
- A `before-plan` extension point composes workflow steps, not raw skills as first-class runtime nodes.
- The planning step should consume approved pre-plan artifacts explicitly rather than depending on incidental chat history.
- During execution, **Plan Markdown** governs executable task sequencing, while approved pre-plan artifacts remain normative constraints and context.
- During planning reconciliation, completed **Plan Markdown** tasks are immutable history and may not be revised.
- A **Cancelled Workflow** is terminal, while a **Paused Workflow** is intentionally resumable.
- The **Runtime Store** contains **WorkflowInstance** records and related runtime coordination data.
- A **Runtime Journal** records observations about **WorkflowInstance** execution without replacing repository state.
- A **SessionSnapshot** may describe harness session context for a **WorkflowInstance** without storing raw harness-private state.
- **Plan Markdown** remains the source for task-list progress in plan-compatible workflows during dogfooding.
- A **WorkflowInstance** may reference **Plan Markdown** as an artifact.
- An **Execution Contract** defines execution semantics independently of the harness-specific command, skill, hook, or script mechanism that delivers them.
- A **Canonical Execution Command** is one possible adapter-visible projection of the **Execution Contract** and should be evaluated through adapter capability/readiness policy rather than assumed to exist in every harness.
- **Artifact Approval State** attaches to an **Artifact Identity** and a specific **Artifact Revision** rather than to a file path alone.
- An **Artifact Revision** may carry **Artifact Integrity Metadata** without storing raw artifact contents in the Runtime Store.
- **Artifact Integrity Metadata** lives inside `ArtifactRef` in the Runtime Store; it is engine-owned and never stored in adapter-owned storage or harness session state.
- An **Artifact Digest** is computed by the adapter (by reading the artifact file) and passed to the engine at dispatch time; the engine compares it against the stored **Artifact Integrity Metadata** and fails closed on mismatch.
- An **Adapter Capability Contract** describes adapter readiness independently of any specific workflow run.
- **Capability Readiness** qualifies each behavior in an **Adapter Capability Contract**.
- A **Readiness Profile** evaluates an **Adapter Capability Contract** for a particular use case.
- The **Core Readiness Profile** is the canonical **Readiness Profile** for adapter readiness checks.
- An **Adapter Health Report** complements an **Adapter Capability Contract** by describing current runtime usability.
- **TOON Output** presents Weave status data without replacing JSON as the machine-readable interchange format.
- **Safe Adapter Init** precedes an **Adapter Health Report** when doctor checks adapter readiness.
- A **Composed Prompt** is the output of the engine's prompt composition step; it is what adapters write into the harness, not the raw prompt source.
- A **Prompt Template** is rendered with a **Template Context** during prompt composition to produce prompt text that participates in the **Composed Prompt**.
- Delegation data inside a **Composed Prompt** is computed from agent `triggers`; a **Prompt Template** may decide where and how that delegation guidance is rendered.
- A **Delegation Diagram** starts as a current-agent star: the current agent points to each eligible delegation target.
- A **Weave-managed Agent** is reconciled by its **Canonical Agent Name**, while display-oriented fields may change without changing identity.

## Prompt Composition Templates

Prompt composition templates are a first-class engine feature. Every agent `prompt`, `prompt_file`, and `prompt_append` value is a **Prompt Template** rendered with a bounded **Template Context** before adapters receive the final **Composed Prompt**. The Template Context exposes agent identity, effective tool policy, and generated delegation data — including `delegation.section` (a Mermaid diagram plus compact bullets) and `delegation.mermaid` (the diagram alone). Prompt authors use `{{{delegation.section}}}` to control where delegation guidance appears; prompts that omit any `delegation.*` reference receive the fallback delegation section automatically. Static prompts without Mustache tags are unaffected.

See [Prompt Composition Guide](docs/prompt-composition.md) and [ADR 0001](docs/adr/0001-prompt-composition-templates.md) for the full specification and rationale.

## Workflow-First Execution Contract

The **Execution Contract** is engine-owned and harness-agnostic. `startExecution` is the sole authorized entry point for durable execution — ordinary Loom conversation, session idle events, continuation hooks, and lifecycle observations (`observeSession`) are explicitly forbidden from implicitly starting durable execution. Adapters expose the contract through harness-appropriate delivery mechanisms (commands, skills, hooks, scripts, or UI) and call `startExecution` only after an explicit user-authorized trigger.

This replaces the legacy `/start-work` → Tapestry flow, which was OpenCode-specific and could silently resume execution on `session.idle` events. The new model requires an explicit user-authorized transition at the execution boundary.

See [ADR 0004 — Workflow-First Execution Contract](docs/adr/0004-workflow-first-execution-contract.md) and [Spec 22 — Workflow-First Execution](docs/specs/22-spec-workflow-first-execution/22-spec-workflow-first-execution.md) for the full rationale and ownership matrix.

## Example dialogue

> **Dev:** "When deciding whether a plan is complete, do we inspect the **WorkflowInstance**?"
> **Domain expert:** "For dogfooding, inspect the **Plan Markdown** checklist; the **WorkflowInstance** tracks execution metadata around it."

## Flagged ambiguities

- "plan state" can mean either human-visible checklist progress or runtime execution metadata; resolved: use **Plan Markdown** for checklist progress and **WorkflowInstance** for runtime metadata.
- "dogfood" is issue-tracking context, not a canonical readiness term; resolved: use **Core Readiness Profile** for adapter readiness gates.
- "runtime storage" can sound harness-owned; resolved: use **Runtime Store** for Weave-owned durable execution state, distinct from adapter-owned harness resources.
- "active execution pointer" suggests a separate concept; resolved: a valid **ExecutionLease** identifies the actively driven **WorkflowInstance**.
- "event log" can imply event sourcing; resolved: use **Runtime Journal** for observational runtime history that is not the source of truth.
- "session runtime snapshot" can imply raw harness state capture; resolved: use **SessionSnapshot** for normalized Weave-visible observations only.
- "agent name" can mean either a stable identifier or a UI-facing label; resolved: use **Canonical Agent Name** for identity and treat display text as presentation only.
