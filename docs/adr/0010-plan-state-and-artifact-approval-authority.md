# ADR 0010 — Plan State and Artifact Approval Authority

**Status:** Accepted

**Related:** [Execution Lifecycle](../reference/execution-lifecycle.md) · [Pi Adapter](../adapters/pi.md) · [Adapter Boundary](../architecture/adapter-boundary.md)

## Context

A boolean `planExists`/`isPlanComplete` interface cannot represent nested tasks, detect stale updates, or tell the TUI which transitions are valid. Artifact approval that stores only an agent name cannot express a human approver, prove agent authority, prevent self-approval, or bind approval to the reviewed revision.

Plan file formats and artifact bytes are concrete resource concerns. Plan transition rules and artifact approval policy are portable workflow semantics.

## Decision

`PlanStateProvider` will expose revisioned snapshots and compare-and-swap transitions:

- `readSnapshot(planName)` parses a provider-owned plan into a normalized task tree;
- `applyTransition(input)` requires `expectedRevision` and returns the new snapshot;
- the engine validates transition authority and resulting completion semantics;
- the provider validates safe plan names and performs atomic durable replacement.

Visible task identifiers are deterministic and two levels deep. Checkboxes encode pending, in-progress, and complete state. Canonical plans carry Weave metadata. Legacy plans remain readable, but transition support may be read-only when safe metadata is absent.

Only the active workflow coordinator may request plan transitions. Workers report structured completion candidates; they do not edit plan files directly.

Artifact approval will use the closed `ArtifactApprovalActor` union:

- `{ kind: "user", provenance: SafeMetadata }`;
- `{ kind: "agent", agentName, gate: "review" | "security" }`.

The engine authorizes actors from the active workflow and gate context. The adapter proves concrete artifact presence and digest at the boundary. Approval binds the workflow instance, artifact identity, exact artifact revision/digest, producer identity, actor, and time. A producer may not approve its own artifact. A changed artifact invalidates prior approval.

## Consequences

- Stale concurrent plan updates fail instead of overwriting newer state.
- TUI plan rendering and engine completion use one normalized snapshot.
- Plan I/O remains provider-owned and therefore adapter-owned in concrete implementations.
- Approval records can distinguish user, review-agent, and security-agent authority.
- Artifact mutation after review cannot inherit approval.
- Legacy plans remain inspectable without unsafe blind rewriting.

## Rejected alternatives

### Let child agents edit Markdown directly

This bypasses coordinator authority, revision checks, and atomic transition rules.

### Store only an approver name

A string cannot prove actor kind, gate authority, or self-approval constraints.

### Move plan file I/O into the engine

The engine would then discover and mutate harness/project resources, which violates the adapter boundary.
