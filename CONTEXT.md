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

## Relationships

- A **WorkflowInstance** stores active execution metadata and artifacts for one workflow run.
- **Plan Markdown** remains the source for task-list progress in plan-compatible workflows during dogfooding.
- A **WorkflowInstance** may reference **Plan Markdown** as an artifact.

## Example dialogue

> **Dev:** "When deciding whether a plan is complete, do we inspect the **WorkflowInstance**?"
> **Domain expert:** "For dogfooding, inspect the **Plan Markdown** checklist; the **WorkflowInstance** tracks execution metadata around it."

## Flagged ambiguities

- "plan state" can mean either human-visible checklist progress or runtime execution metadata; resolved: use **Plan Markdown** for checklist progress and **WorkflowInstance** for runtime metadata.
