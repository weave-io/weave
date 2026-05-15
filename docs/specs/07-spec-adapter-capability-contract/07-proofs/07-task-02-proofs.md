# Task 2.0 Proof — Core Readiness Profile Evaluator

## Task Summary

Added `packages/engine/src/__tests__/capability-readiness.test.ts` with 25
tests covering the `evaluateCoreReadinessProfile` function implemented in
`capability-contract.ts`.

**Why it matters**: The Core Readiness Profile evaluator is the decision engine
that determines whether an adapter is ready to run Weave workflows. Tests prove
the evaluation rules are correct and deterministic.

## What This Task Proves

1. Required `degraded` → `fail` (readiness blocked).
2. Required `unsupported` → `fail` (readiness blocked).
3. Required `emulated` → `pass` (emulation satisfies required capabilities).
4. Required `native` → `pass`.
5. Optional `unsupported` → `warning` only (not a failure).
6. Optional `degraded` → `warning` only (not a failure).
7. Missing required capability → `fail`.
8. Missing optional capability → `warning` only.
9. All required native → `ready: true`.
10. Mixed required+optional failures/warnings are correctly separated.
11. `token-usage-reporting` is conditionally required: `unsupported` without
    documented reason → `fail`; `unsupported` with documented reason → `warning`.
12. Coverage guard: `REQUIRED_CAPABILITIES` and `OPTIONAL_CAPABILITIES` match
    the spec exactly (12 + 7 = 19 total).
13. Sanitized JSON fixture contains no credentials or secrets.

## Evidence

### Test output

```
bun test packages/engine/src/__tests__/capability-readiness.test.ts

 25 pass
 0 fail
 92 expect() calls
Ran 25 tests across 1 file. [57.00ms]
```

### Typecheck output

```
bun run typecheck

@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

### Lint output

```
bun run lint

Checked 73 files in 16ms. No fixes applied.
```

### Key evaluation rules (from capability-contract.ts)

```ts
// Required + native/emulated → pass
// Required + degraded/unsupported → fail
// Required + missing → fail
// Optional + native/emulated → pass
// Optional + degraded/unsupported → warning
// Optional + missing → warning
// token-usage-reporting unsupported + notes → warning (conditional)
```

### Sanitized JSON fixture excerpt

```json
{
  "ready": true,
  "failures": [],
  "warnings": [
    {
      "capabilityId": "compaction-recovery",
      "verdict": "warning",
      "readiness": "unsupported",
      "reason": "Optional capability 'compaction-recovery' has readiness 'unsupported'..."
    },
    {
      "capabilityId": "context-window-monitor",
      "verdict": "warning",
      "readiness": "degraded",
      "reason": "Optional capability 'context-window-monitor' has readiness 'degraded'..."
    }
  ],
  "passes": [...]
}
```

## Sanitization Proof

All test fixtures use:
- `supplier: "synthetic-adapter"` — no real harness names
- Notes prefixed with `"Synthetic:"` — no real harness config contents
- No `/Users/`, passwords, API keys, or secrets in any fixture or JSON output

## Reviewer Conclusion

All acceptance criteria for Task 2.0 are met:
- [x] Required degraded fails
- [x] Required unsupported fails
- [x] Required emulated passes
- [x] Required native passes
- [x] Optional unsupported = warning only
- [x] Optional degraded = warning only
- [x] Missing required = failure
- [x] Missing optional = warning only
- [x] All required native → ready: true
- [x] Mixed required+optional correctly separated
- [x] Token-usage-reporting conditionally required
- [x] Coverage guard: 12 required + 7 optional = 19 total
- [x] 25 tests pass, 0 fail
- [x] Typecheck clean
- [x] Lint clean
- [x] Fixtures sanitized
