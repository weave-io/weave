# Weave Context

Weave is a harness-agnostic prompt and agent-configuration system that turns declarative agent intent into concrete harness behavior.

## Language

**WorkflowInstance**:
A durable record of a workflow run's execution state, coordination metadata, and artifact references.
_Avoid_: Run state, workflow state blob, plan progress

**Paused Workflow**:
A workflow run that intentionally stops at a resumable point while waiting for user or policy direction.
_Avoid_: Blocked workflow, failed workflow

**Blocked Workflow**:
A workflow run that cannot proceed because a required input, artifact, or harness capability is unavailable.
_Avoid_: Paused workflow, failed workflow

**Completion Signal**:
A normalized declaration that a workflow step with subjective completion criteria has finished or produced a verdict.
_Avoid_: Message marker, done text, assistant flag

**Plan Markdown**:
A human-readable plan document whose task list is the authoritative user-visible plan progress during dogfooding.
_Avoid_: Rendered plan, generated view, workflow state

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

## Relationships

- A **WorkflowInstance** stores active execution metadata and artifacts for one workflow run.
- **Plan Markdown** remains the source for task-list progress in plan-compatible workflows during dogfooding.
- A **WorkflowInstance** may reference **Plan Markdown** as an artifact.
- An **Adapter Capability Contract** describes adapter readiness independently of any specific workflow run.
- **Capability Readiness** qualifies each behavior in an **Adapter Capability Contract**.
- A **Readiness Profile** evaluates an **Adapter Capability Contract** for a particular use case.
- The **Core Readiness Profile** is the canonical **Readiness Profile** for adapter readiness checks.
- An **Adapter Health Report** complements an **Adapter Capability Contract** by describing current runtime usability.
- **TOON Output** presents Weave status data without replacing JSON as the machine-readable interchange format.
- **Safe Adapter Init** precedes an **Adapter Health Report** when doctor checks adapter readiness.

## Example dialogue

> **Dev:** "When deciding whether a plan is complete, do we inspect the **WorkflowInstance**?"
> **Domain expert:** "For dogfooding, inspect the **Plan Markdown** checklist; the **WorkflowInstance** tracks execution metadata around it."

## Flagged ambiguities

- "plan state" can mean either human-visible checklist progress or runtime execution metadata; resolved: use **Plan Markdown** for checklist progress and **WorkflowInstance** for runtime metadata.
- "dogfood" is issue-tracking context, not a canonical readiness term; resolved: use **Core Readiness Profile** for adapter readiness gates.
