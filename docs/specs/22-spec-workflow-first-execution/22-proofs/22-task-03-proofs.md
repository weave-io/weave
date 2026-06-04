# Task 3.0 Proof Artifact — Artifact Identity, Revisions, Approval, and Consumption Provenance

**Spec**: [Spec 22 — Workflow-First Execution](../22-spec-workflow-first-execution.md), Unit 3  
**Task**: 3.0 Implement artifact identity, revisions, approval, and consumption provenance  
**Sub-tasks completed**: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6  
**Date**: 2026-06-03

---

## Summary

Tasks 3.1–3.6 implement the full artifact provenance model across runtime types, store interfaces, in-memory and SQLite store implementations, execution-lifecycle dispatch logic, and documentation. All acceptance criteria for task 3.0 are met.

---

## 1. Artifact Identity (`ArtifactId`) and Monotonic Revisions

**Requirement**: Each logical artifact has a stable `ArtifactId` that persists across revisions. Revision counter starts at 1 and increments monotonically. A new revision always resets `approvalState` to `pending`.

**Types** (`packages/engine/src/runtime/types.ts`):

```ts
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export interface ArtifactRef {
  readonly id: ArtifactId;          // stable across revisions
  readonly name: string;
  readonly path: string;
  readonly revision: number;        // starts at 1, monotonically incremented
  readonly approvalState: ArtifactApprovalState;  // resets to "pending" on new revision
  readonly producerAgent?: string;
  readonly mimeType?: string;
  readonly description?: string;
  readonly integrity?: ArtifactIntegrityMetadata;
}
```

**Test evidence** — in-memory store (663 pass, 0 fail across 6 test files):

| Test | File | Result |
|------|------|--------|
| `first addArtifact assigns revision 1 and approvalState 'pending'` | `runtime-memory.test.ts` | ✅ pass |
| `second addArtifact with same name increments revision and resets approvalState to 'pending'` | `runtime-memory.test.ts` | ✅ pass |
| `stable ArtifactId is preserved across revisions of the same artifact name` | `runtime-memory.test.ts` | ✅ pass |
| `different artifact names get different ArtifactIds` | `runtime-memory.test.ts` | ✅ pass |

**Test evidence** — SQLite store (durability across close/reopen):

| Test | File | Result |
|------|------|--------|
| `first addArtifact assigns revision 1 and approvalState 'pending'` | `runtime-sqlite.test.ts` | ✅ pass |
| `second addArtifact with same name increments revision and resets approvalState to 'pending'` | `runtime-sqlite.test.ts` | ✅ pass |
| `stable ArtifactId is preserved across revisions of the same artifact name` | `runtime-sqlite.test.ts` | ✅ pass |
| `different artifact names get different ArtifactIds` | `runtime-sqlite.test.ts` | ✅ pass |
| `artifact identity and revision survive store close and reopen` | `runtime-sqlite.test.ts` | ✅ pass |

---

## 2. Approval Invalidation

**Requirement**: A new revision always resets `approvalState` to `pending`, invalidating any prior approval on the same artifact name.

**Implementation** (`packages/engine/src/runtime/memory-store.ts`, `packages/engine/src/runtime/sqlite/store.ts`): When `addArtifact` is called with a name that already exists, the store assigns the next monotonic revision and sets `approvalState: "pending"` regardless of the prior revision's approval state.

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `second addArtifact with same name increments revision and resets approvalState to 'pending'` | `runtime-memory.test.ts` | ✅ pass |
| `approval invalidation: new revision resets approvalState to 'pending' on the new entry` | `runtime-sqlite.test.ts` | ✅ pass |
| `new revision invalidates prior approval — dispatch is blocked again` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `dispatch succeeds after re-approving the new revision` | `artifact-approval-lifecycle.test.ts` | ✅ pass |

---

## 3. Self-Approval Prohibition

**Requirement**: An agent may not approve an artifact it produced (`producerAgent === approverAgent` is rejected).

**Implementation** (`packages/engine/src/execution-lifecycle.ts`): `approveArtifact` checks whether `approverAgent` matches `ArtifactRef.producerAgent`. If they match, it returns a `policy_decision` error before any state change.

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `rejects approval when approverAgent matches producerAgent` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `allows approval when approverAgent differs from producerAgent` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `allows approval when approverAgent is absent (no self-approval check)` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `allows approval when producerAgent is absent (no self-approval check)` | `artifact-approval-lifecycle.test.ts` | ✅ pass |

---

## 4. Normative vs Informational Artifact Inputs

**Requirement**: Steps declare normative (blocking) and informational (advisory) artifact inputs. Normative inputs block dispatch when absent or unapproved; informational inputs produce warnings only.

**Types** (`packages/engine/src/runtime/types.ts`):

```ts
export type ArtifactInputRole = "normative" | "informational";

export interface ArtifactInputDecl {
  readonly name: string;
  readonly description: string;
  readonly role?: ArtifactInputRole;  // defaults to "normative" when omitted
}

export interface ArtifactInputSummary {
  readonly normativeSatisfied: readonly string[];
  readonly informationalPresent: readonly string[];
  readonly informationalAbsent: readonly string[];
}
```

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `ARTIFACT_INPUT_ROLES contains 'normative' and 'informational'` | `execution-lifecycle.test.ts` | ✅ pass |
| `normative input absent: returns not_found error, dispatch blocked` | `execution-lifecycle.test.ts` | ✅ pass |
| `normative input present: dispatch succeeds` | `execution-lifecycle.test.ts` | ✅ pass |
| `informational input absent: dispatch succeeds (advisory only)` | `execution-lifecycle.test.ts` | ✅ pass |
| `all-informational step: dispatch succeeds with no artifacts present` | `execution-lifecycle.test.ts` | ✅ pass |
| `artifactInputSummary: normative satisfied, informational absent` | `execution-lifecycle.test.ts` | ✅ pass |
| `artifactInputSummary: normative satisfied, informational present` | `execution-lifecycle.test.ts` | ✅ pass |
| `input without explicit role defaults to normative (blocks dispatch when absent)` | `execution-lifecycle.test.ts` | ✅ pass |

---

## 5. Consumed-Revision Recording

**Requirement**: Each step attempt records which artifact revisions were consumed at dispatch time. Retries reuse the same consumed revisions by default.

**Types** (`packages/engine/src/runtime/types.ts`):

```ts
export interface ConsumedArtifactRecord {
  readonly artifactId: ArtifactId;
  readonly name: string;
  readonly revision: number;
}

export interface StepAttemptRecord {
  readonly stepName: string;
  readonly attemptNumber: number;
  readonly dispatchedAt: string;
  readonly consumedArtifacts: readonly ConsumedArtifactRecord[];
}
```

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `dispatchStep records a step attempt with consumed artifact revisions` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `dispatchStep records empty consumedArtifacts for steps with no inputs` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `attempt number increments on each dispatch of the same step` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `recordStepAttempt appends a step attempt with consumed artifacts` | `runtime-sqlite.test.ts` | ✅ pass |
| `recordStepAttempt increments attemptNumber for the same step` | `runtime-sqlite.test.ts` | ✅ pass |
| `recordStepAttempt uses independent counters per step name` | `runtime-sqlite.test.ts` | ✅ pass |
| `recordStepAttempt persists consumed artifact identity across store close and reopen` | `runtime-sqlite.test.ts` | ✅ pass |

---

## 6. Default Retry Reuse of Consumed Revisions

**Requirement**: Retries pin to the same consumed artifact revisions from the prior attempt by default, preventing silent drift when an artifact is updated between attempts.

**Implementation** (`packages/engine/src/execution-lifecycle.ts`): `dispatchStep` checks for a prior `StepAttemptRecord` for the same step. If found, it reuses the `consumedArtifacts` from that record as `pinnedArtifactRevisions` unless the caller explicitly provides overrides.

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `retry reuses consumed revisions from prior attempt by default` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `explicit pinnedArtifactRevisions override default retry reuse` | `artifact-approval-lifecycle.test.ts` | ✅ pass |
| `first dispatch (no prior attempt) uses current latest revisions` | `artifact-approval-lifecycle.test.ts` | ✅ pass |

---

## 7. Integrity Verification via Adapter-Supplied Digests

**Requirement**: Consumption-time integrity verification compares current artifact contents to the bound immutable revision or fingerprint and fails closed on mismatch. Adapters compute digests; the engine never reads artifact file contents.

**Implementation**: `dispatchStep` accepts `DispatchStepInput.artifactDigests: Record<string, string>`. For each artifact with stored `ArtifactIntegrityMetadata`, if a digest is supplied, the engine compares it against the stored digest. A mismatch returns a `policy_decision` error (fail-closed). Verification is opt-in: if no digest is supplied for an artifact, no check is performed.

**Boundary**: Adapters own artifact file I/O and SHA-256 computation. The engine owns the `ArtifactIntegrityMetadata` type, format validation (64 lowercase hex chars), and the fail-closed comparison. This preserves the engine/adapter boundary documented in `docs/adapter-boundary.md`.

**Test evidence**:

| Test | File | Result |
|------|------|--------|
| `dispatch succeeds when supplied digest matches stored digest` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `dispatch succeeds when artifact has integrity but no digest is supplied (opt-in)` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `dispatch returns policy_decision error when digest does not match stored digest` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `error message references the artifact name and revision` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `dispatch does not proceed when integrity check fails (no step attempt recorded)` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `returns validation error for digest that is too short` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `returns validation error for digest with uppercase hex characters` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `integrity check applies to pinned artifacts — mismatch fails closed` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `informational input with stored integrity fails closed on mismatch` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `first integrity mismatch fails fast without checking remaining artifacts` | `artifact-integrity-verification.test.ts` | ✅ pass |
| `dispatch without artifactDigests behaves identically to pre-3.4 behavior` | `artifact-integrity-verification.test.ts` | ✅ pass |

---

## 8. Sanitized Provenance Fixture

**Requirement**: `packages/engine/src/__tests__/fixtures/artifact-provenance.json` contains sanitized example runtime records with integrity fingerprints only — no raw artifact contents, prompts, tokens, or private paths.

**Fixture** (`packages/engine/src/__tests__/fixtures/artifact-provenance.json`):

The fixture contains 7 scenarios covering:

| Scenario | Coverage |
|----------|----------|
| `single-revision-pending` | First revision, no approval yet, integrity digest stored |
| `single-revision-approved` | Approved by a different agent; consumed-revision recorded in step attempt |
| `approval-invalidation` | Stable `ArtifactId` across v1 (approved) and v2 (pending); v2 resets approval |
| `retry-pinning` | Two attempts on same step; both pin to revision 1 |
| `integrity-mismatch-blocked` | Supplied digest ≠ stored digest → `policy_decision` error; no step attempt |
| `self-approval-prohibited` | `approverAgent === producerAgent` → `policy_decision` error |
| `multi-step-independent-counters` | Two steps with independent `attemptNumber` counters |

The fixture's `provenanceInvariants` section documents all 8 invariants (stable identity, monotonic revision, approval invalidation, self-approval prohibition, integrity fail-closed, integrity opt-in, retry pinning, no raw content).

**Sanitization**: The fixture contains only SHA-256 digests (hex strings), logical artifact names, relative paths, ISO 8601 timestamps, and agent names. It explicitly excludes raw artifact contents, raw prompts, tokens, credentials, and private filesystem paths.

---

## 9. Boundary and Glossary Documentation

**Requirement**: `docs/adapter-boundary.md` and `CONTEXT.md` document integrity-verification metadata with a sanctioned home consistent with the new runtime model.

**`docs/adapter-boundary.md`** (updated in task 3.6):

- Added `ArtifactIntegrityMetadata` section documenting the engine-owned type, field layout, and the engine/adapter split for digest computation vs. comparison.
- Documents that adapters own file I/O and SHA-256 computation; the engine owns the type, format validation, and fail-closed comparison.
- Includes a concrete code example showing the correct adapter pattern: read file → compute digest → pass via `artifactDigests` → engine compares.
- Documents that `ArtifactRef.integrity` stores metadata only — never artifact content.

**`CONTEXT.md`** (updated in task 3.6):

- Extended `Artifact Revision` entry: "A new revision always resets approval state to `pending`, invalidating any prior approval on the same artifact name."
- Added `Artifact Integrity Metadata` glossary entry: engine-owned record inside `ArtifactRef`, SHA-256 digest only, never raw content.
- Added `Artifact Digest` glossary entry: adapter-computed hash passed via `DispatchStepInput.artifactDigests`.
- Updated invariants section: "An **Artifact Revision** may carry **Artifact Integrity Metadata** without storing raw artifact contents in the Runtime Store."

---

## 10. Test Run Summary

```
bun test packages/engine/src/__tests__/runtime-memory.test.ts \
         packages/engine/src/__tests__/runtime-sqlite.test.ts \
         packages/engine/src/__tests__/runtime-contract.test.ts \
         packages/engine/src/__tests__/execution-lifecycle.test.ts \
         packages/engine/src/__tests__/artifact-approval-lifecycle.test.ts \
         packages/engine/src/__tests__/artifact-integrity-verification.test.ts
# 663 pass, 0 fail
```

---

## 11. Pre-existing Unrelated Blockers

- **`bun run validate-config`** is blocked by a pre-existing issue in `packages/cli/src/commands/init.ts` (known CLI blocker). This is unrelated to task 3.0 and does not affect the targeted test results above.
- **Workspace-wide `bun test`** may report failures from `docs/adr-workflow-execution-contract/packages/core/src/__tests__/` — a stale sibling directory that lacks `zod` and `neverthrow` in its local `node_modules`. These failures are pre-existing and unrelated to task 3.0.

---

## Acceptance Criteria Checklist

| Criterion | Status |
|-----------|--------|
| Proof file covers artifact identity (`ArtifactId`) | ✅ Section 1 |
| Proof file covers monotonic revisions | ✅ Section 1 |
| Proof file covers approval invalidation on new revision | ✅ Section 2 |
| Proof file covers self-approval prohibition | ✅ Section 3 |
| Proof file covers consumed-revision recording | ✅ Section 5 |
| Proof file covers default retry reuse | ✅ Section 6 |
| Proof file covers integrity verification via adapter-supplied digests | ✅ Section 7 |
| Proof file covers sanitized provenance fixtures | ✅ Section 8 |
| Proof file covers boundary and glossary documentation | ✅ Section 9 |
| Pre-existing unrelated blockers noted | ✅ Section 11 |
| Test evidence included for all criteria | ✅ Sections 1–7 |
| Task 3.0 marked `[x]` in task file | ✅ (done in commit) |
