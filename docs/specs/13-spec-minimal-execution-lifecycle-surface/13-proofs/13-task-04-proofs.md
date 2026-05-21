# Task 04 Proofs - `beforeTool` policy lifecycle point

## Task Summary

This task proves that `beforeTool` is implemented as a pure policy evaluation function that reuses the existing abstract tool policy model from `tool-policy.ts`. Adapters own concrete tool-name mapping; the engine owns abstract policy decisions. The function returns deterministic allow/deny/ask decisions without accessing the Runtime Store.

## What This Task Proves

- `beforeTool` reuses `ABSTRACT_CAPABILITIES` and `EffectiveToolPolicy` from `tool-policy.ts` — no second policy model created.
- `beforeTool` returns `allow`, `deny`, or `ask` for all 5 abstract capabilities.
- Unknown capabilities return a typed `LifecycleValidationError` (not thrown).
- `BeforeToolInput` and `BeforeToolOutput` contain no credential, token, or raw payload fields.
- `docs/adapter-boundary.md` documents the adapter/engine boundary for tool-name mapping vs. policy decisions.
- 13 new tests pass alongside 824 pre-existing tests (837 total).

## Evidence Summary

- Typecheck exits 0 — `beforeTool` implementation compiles correctly.
- 837/837 tests pass — 13 new `beforeTool` tests included.
- Security tests confirm no credential fields in input/output types.

## Artifact: Typecheck pass

**What it proves:** `beforeTool` implementation compiles with correct types, reusing `EffectiveToolPolicy` from `tool-policy.ts`.

**Command:**
```bash
bun run --filter '@weave/engine' typecheck
```

**Result summary:** Exit code 0.

```
@weave/engine typecheck: Exited with code 0
```

## Artifact: Test suite pass

**What it proves:** 13 new `beforeTool` tests cover all acceptance criteria.

**Command:**
```bash
bun run --filter '@weave/engine' test
```

**Result summary:** 837 pass, 0 fail across 18 files.

```
 837 pass
 0 fail
 Ran 837 tests across 18 files. [692.00ms]
```

## Artifact: Test coverage breakdown

| Test | Behavior verified |
|---|---|
| `allow` decision (read) | `effectiveToolPolicy.read = "allow"` → `decision: "allow"` |
| `deny` decision (write) | `effectiveToolPolicy.write = "deny"` → `decision: "deny"` |
| `ask` decision (network) | `effectiveToolPolicy.network = "ask"` → `decision: "ask"` |
| `allow` for execute | `effectiveToolPolicy.execute = "allow"` → `decision: "allow"` |
| `deny` for delegate | `effectiveToolPolicy.delegate = "deny"` → `decision: "deny"` |
| Unknown capability | `toolCapability = "unknown"` → `LifecycleValidationError` |
| Missing `toolCapability` | → `LifecycleValidationError` |
| Missing `workflowInstanceId` | → `LifecycleValidationError` |
| Missing `leaseId` | → `LifecycleValidationError` |
| Security: output has no credential fields | `BeforeToolOutput` only has `decision` + optional `reason` |
| Security: input has no credential fields | `BeforeToolInput` has no `token`, `apiKey`, `password`, `secret`, `authorization` |
| `toolName` is audit-only | Same capability+policy → same decision regardless of `toolName` |

## Artifact: Documentation update

**What it proves:** `docs/adapter-boundary.md` documents the adapter/engine boundary for `beforeTool`.

**Why it matters:** Future adapter authors need to know they own tool-name mapping; the engine owns policy decisions.

**Added section:** `### beforeTool — Adapter/Engine Boundary` under `## Execution Lifecycle Surface` in `docs/adapter-boundary.md`, covering:
- Adapters own concrete tool-name → abstract capability mapping
- Engine reads `effectiveToolPolicy[toolCapability]` for the decision
- `toolName` is for audit/logging only
- Security invariants for input/output

## Reviewer Conclusion

`beforeTool` is implemented as a pure policy evaluation function with no Runtime Store access. It reuses the existing `EffectiveToolPolicy` model. All 13 tests pass. Security boundaries are documented and tested. 837/837 total tests pass.
