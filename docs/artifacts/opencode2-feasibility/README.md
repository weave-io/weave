# opencode2 Feasibility Evidence — Non-Normative

This directory is a **promoted, non-normative copy** of the evidence
gathered during Tasks A1–A6 of the `opencode2-adapter` feasibility plan
([`.weave/plans/opencode2-adapter.md`](../../../.weave/plans/opencode2-adapter.md)).
It exists so that **Spec 33** (the opencode2 adapter spec) can link to
concrete go/no-go evidence without embedding proof output in a durable spec
file, per [`docs/documentation-policy.md`](../../documentation-policy.md).

**Decision: GO.** See [`DECISION.md`](DECISION.md) for the full criteria
table, evidence pointers, and the list of runtime deviations that Spec 33
must codify as normative adapter behavior before/alongside Phase B.

## Contents

| File | Description |
| --- | --- |
| [`DECISION.md`](DECISION.md) | Go/no-go decision note: criteria, evidence pointers, required Spec 33 revisions |
| [`results.json`](results.json) | Machine-readable pass/fail results for tasks A1–A5 |
| [`results.schema.json`](results.schema.json) | JSON Schema describing `results.json` |
| [`notes/agent-editor-findings.md`](notes/agent-editor-findings.md) | Detailed `AgentEditor` create/foreign-classification investigation (Task A5, hard blocker) |

## Provenance

These files are copies. The live harness that produced them, and the source
of truth for re-running the proofs, lives at
[`.weave/feasibility/opencode2/`](../../../.weave/feasibility/opencode2/)
(gitignored working tree, force-added for these specific files). Related
consolidated learnings are recorded in
[`.weave/learnings/opencode2-adapter.md`](../../../.weave/learnings/opencode2-adapter.md).

## Classification

Per [`docs/documentation-policy.md`](../../documentation-policy.md), this is
**non-normative** evidence: a historical snapshot, not maintained as the
system evolves. The normative adapter behavior derived from this evidence
belongs in Spec 33 itself, not here.
