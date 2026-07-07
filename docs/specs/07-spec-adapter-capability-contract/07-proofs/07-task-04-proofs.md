# Task 4.0 Proof — Renderer-Ready Structures and CLI Fixtures

## Task Summary

Added `packages/engine/src/__tests__/capability-reporting.test.ts` with 33
tests covering `buildHumanRows`, `buildToonRows`, and `toJson`.

**Why it matters**: Proves the renderer-ready structures are correct,
deterministic, and safe for CLI output, JSON interchange, and LLM-oriented
(TOON) consumption.

## What This Task Proves

1. `buildHumanRows`: all pass → all PASS status (19 rows).
2. `buildHumanRows`: mixed report → correct FAIL/WARN rows.
3. `buildHumanRows`: FAIL row includes blocking impact in notes.
4. `buildHumanRows`: deterministic order (required first, then optional).
5. `buildToonRows`: deterministic (same input = same output).
6. `buildToonRows`: compact keys (id, v, r).
7. `buildToonRows`: F verdict for degraded required, W for unsupported optional.
8. `buildToonRows`: same order as human rows.
9. `toJson`: returns parseable JSON with profileResult, harness, timestamp,
   capabilityContract, and probeResults.
10. `toJson`: 2-space indented formatting.
11. No probe re-execution: renderer functions do not modify the report.
12. Sanitized: no credentials, local paths, or harness secrets in output.
13. Token-usage-reporting with documented reason appears as WARN in human rows.

## Note on Renderer Location

- **Engine** owns normalized report/result structures and deterministic data
  contracts (`buildHumanRows`, `buildToonRows`, `toJson`).
- **CLI** owns concrete terminal presentation when full `doctor`, `status`, or
  `debug` commands are implemented downstream.
- JSON is the machine-readable interchange format.
- TOON is the compact deterministic representation for LLM-oriented consumption.
- Human output is for CLI display.

## Evidence

### Test output

```
bun test packages/engine/src/__tests__/capability-reporting.test.ts

 33 pass
 0 fail
 261 expect() calls
Ran 33 tests across 1 file. [48.00ms]
```

### Typecheck output

```
bun run typecheck

@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

### Lint output

```
bun run lint

Checked 75 files in 15ms. No fixes applied.
```

### Key type shapes

```ts
interface HumanReadinessRow {
  capability: string;       // display name
  status: "PASS" | "FAIL" | "WARN";
  readiness: CapabilityReadiness | "missing";
  notes: string;            // blockingImpact | notes | remediationHint
}

interface ToonReadinessRow {
  id: string;               // capability ID
  v: "P" | "F" | "W";      // verdict
  r: string;                // readiness level
}
```

### Sanitized TOON fixture example (all passing)

```json
[
  { "id": "config-materialization", "v": "P", "r": "native" },
  { "id": "agent-materialization", "v": "P", "r": "native" },
  ...
  { "id": "multiple-active-workflows", "v": "P", "r": "native" }
]
```

### Sanitized TOON fixture example (mixed)

```json
[
  { "id": "config-materialization", "v": "P", "r": "native" },
  ...
  { "id": "workflow-persistence", "v": "F", "r": "degraded" },
  ...
  { "id": "analytics-dashboard", "v": "W", "r": "unsupported" },
  ...
]
```

## Sanitization Proof

All test fixtures use:
- `supplier: "synthetic-adapter"` — no real harness names
- Notes prefixed with `"Synthetic:"` — no real harness config contents
- No `/Users/`, passwords, API keys, or secrets in any fixture or output

## Reviewer Conclusion

All acceptance criteria for Task 4.0 are met:
- [x] Human rows all pass = all PASS status
- [x] Mixed report → correct FAIL/WARN rows
- [x] TOON rows are deterministic (same input = same output)
- [x] `toJson` returns parseable JSON containing profile result
- [x] Deterministic order: required first, then optional
- [x] No probe re-execution
- [x] JSON is machine-readable interchange
- [x] TOON is LLM-oriented compact deterministic representation
- [x] Human output is for CLI display
- [x] No harness secrets in renderer output
- [x] 33 tests pass, 0 fail
- [x] Typecheck clean
- [x] Lint clean
- [x] Fixtures sanitized
