# Task 3.0 Proof — Adapter-Owned Declarations, Health Reports, Safe Adapter Init

## Task Summary

Added `packages/engine/src/__tests__/adapter-health-report.test.ts` with 21
tests covering `buildAdapterHealthReport`, `SafeAdapterInitInput`,
`CapabilityProbeResult`, and `AdapterHealthReport`.

**Why it matters**: Proves the engine builds health reports from explicit
adapter-supplied inputs without performing harness I/O, scanning directories,
registering hooks, or mutating harness state.

## What This Task Proves

1. `buildAdapterHealthReport` is pure: accepts `SafeAdapterInitInput` and
   returns `AdapterHealthReport` without calling `Bun.file`, `Bun.spawn`,
   scanning directories, or registering hooks.
2. Harness name is preserved from input.
3. Capability contract is preserved from input.
4. Probe results are preserved from input.
5. Timestamp is a non-empty ISO 8601 string.
6. `profileResult` matches `evaluateCoreReadinessProfile` output.
7. `CapabilityProbeResult` models `ok`, `degraded`, and `unavailable` statuses.
8. `SafeAdapterInitInput` carries harness, contract, and probeResults.
9. Supplier attribution is preserved in capability entries.
10. Multiple calls with same input produce equivalent structural results.
11. Sanitized: no credentials, local paths, or harness secrets in fixtures.

## Code Review Artifact: Boundary Compliance

`buildAdapterHealthReport` in `capability-contract.ts`:

```ts
export function buildAdapterHealthReport(
  input: SafeAdapterInitInput,
): AdapterHealthReport {
  const profileResult = evaluateCoreReadinessProfile(input.capabilityContract);
  return {
    harness: input.harness,
    timestamp: new Date().toISOString(),
    capabilityContract: input.capabilityContract,
    probeResults: input.probeResults,
    profileResult,
  };
}
```

**Verification**: The function body contains:
- `evaluateCoreReadinessProfile(...)` — pure engine function, no harness I/O
- `new Date().toISOString()` — timestamp generation, no harness I/O
- Object spread from `input` — no harness discovery

No calls to `Bun.file`, `Bun.spawn`, `Bun.spawnSync`, directory scanning,
hook registration, agent materialization, or harness API queries.

## Code Review Artifact: Safe Adapter Init Documentation

From `capability-contract.ts` JSDoc:

```ts
/**
 * Safe Adapter Init contract:
 * - MUST NOT materialize agents.
 * - MUST NOT register lifecycle hooks.
 * - MUST NOT launch workflows or workflow steps.
 * - MUST NOT mutate harness configuration or state.
 * - MUST NOT write generated config files.
 * - MUST NOT start harness runtimes or processes.
 * - MAY perform read-only harness environment checks (file existence, env vars,
 *   version queries) and report results as `CapabilityProbeResult` entries.
 */
export interface SafeAdapterInitInput { ... }
```

## Evidence

### Test output

```
bun test packages/engine/src/__tests__/adapter-health-report.test.ts

 21 pass
 0 fail
 43 expect() calls
Ran 21 tests across 1 file. [44.00ms]
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

Checked 74 files in 20ms. No fixes applied.
```

## Sanitization Proof

All test fixtures use:
- `harness: "synthetic-adapter"` or `"synthetic-test-harness"` — no real harness names
- `details: "Synthetic: ..."` — no real harness config contents
- `details: "Synthetic: config file found at <redacted>"` — path redaction example
- No `/Users/`, passwords, API keys, or secrets in any fixture

## Reviewer Conclusion

All acceptance criteria for Task 3.0 are met:
- [x] Mock adapter supplies probe results; engine uses only explicit inputs
- [x] `buildAdapterHealthReport` is pure (no harness I/O)
- [x] `profileResult` matches `evaluateCoreReadinessProfile` output
- [x] Timestamp is a non-empty ISO 8601 string
- [x] Harness name is preserved
- [x] `CapabilityProbeResult` models ok/degraded/unavailable
- [x] `SafeAdapterInitInput` shape is correct
- [x] Supplier attribution preserved
- [x] Boundary compliance: no harness I/O in engine helpers
- [x] Safe Adapter Init documented as read-only and adapter-owned
- [x] 21 tests pass, 0 fail
- [x] Typecheck clean
- [x] Lint clean
- [x] Fixtures sanitized
