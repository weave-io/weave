# Task 1.0 Proof — Shared Capability Model and Engine Exports

## Task Summary

Created `packages/engine/src/capability-contract.ts` — the harness-neutral
vocabulary module for the Adapter Capability Contract. Exported all public
types and helpers from `packages/engine/src/index.ts`.

**Why it matters**: Establishes the shared vocabulary (readiness levels,
capability IDs, entry shapes, contract structure) that engine, adapters, CLI,
and tests can all import from `@weave/engine` without duplicating definitions.

## What This Task Proves

1. `CapabilityReadiness` has exactly 4 approved values: `native`, `emulated`,
   `degraded`, `unsupported`. No extra values are accepted.
2. All 19 capability IDs (12 required + 7 optional) are defined and validated
   by `CapabilityIdSchema`.
3. `CapabilityEntry` accepts all readiness levels and all optional fields
   (notes, runtimeStatus, blockingImpact, supplier, remediationHint).
4. `AdapterCapabilityContract` is structurally valid and schema-validated.
5. Tool-policy capability references `@weave/core` `ToolPolicy` concepts in
   notes rather than duplicating allow/deny/ask enums.
6. All public types and helpers are re-exported from the engine barrel.
7. Synthetic fixtures contain no credentials, local paths, or harness secrets.

## Evidence

### Test output

```
bun test packages/engine/src/__tests__/capability-contract.test.ts

 27 pass
 0 fail
 102 expect() calls
Ran 27 tests across 1 file. [95.00ms]
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

Checked 72 files in 14ms. No fixes applied.
```

### Public API shape (packages/engine/src/index.ts excerpt)

```ts
export type {
  CapabilityReadiness,
  CapabilityId,
  CapabilityEntry,
  AdapterCapabilityContract,
  ReadinessVerdict,
  ReadinessOutcome,
  ProfileEvaluationResult,
  CapabilityProbeResult,
  SafeAdapterInitInput,
  AdapterHealthReport,
  HumanReadinessRow,
  ToonReadinessRow,
} from "./capability-contract.js";
export {
  CapabilityReadinessSchema,
  CapabilityIdSchema,
  CapabilityEntrySchema,
  AdapterCapabilityContractSchema,
  REQUIRED_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  ALL_CAPABILITY_IDS,
  evaluateCoreReadinessProfile,
  buildAdapterHealthReport,
  buildHumanRows,
  buildToonRows,
  toJson,
} from "./capability-contract.js";
```

### Key type shapes

```ts
type CapabilityReadiness = "native" | "emulated" | "degraded" | "unsupported";

type CapabilityId =
  | "config-materialization" | "agent-materialization"
  | "primary-agent-selection" | "delegated-specialist-execution"
  | "prompt-composition" | "tool-policy-mapping"
  | "workflow-persistence" | "workflow-step-dispatch"
  | "plan-file-compatibility" | "command-entrypoints"
  | "event-logging" | "token-usage-reporting"
  | "idle-continuation" | "compaction-recovery"
  | "context-window-monitor" | "analytics-dashboard"
  | "eval-integration" | "static-artifact-generation"
  | "multiple-active-workflows";

interface CapabilityEntry {
  id: CapabilityId;
  description: string;
  readiness: CapabilityReadiness;
  notes?: string;
  runtimeStatus?: string;
  blockingImpact?: string;
  supplier?: string;
  remediationHint?: string;
}
```

## Sanitization Proof

All test fixtures use:
- `supplier: "synthetic-adapter"` — no real harness names
- Notes prefixed with `"Synthetic:"` — no real harness config contents
- No `/Users/`, `/home/`, passwords, API keys, or secrets in any fixture

## Reviewer Conclusion

All acceptance criteria for Task 1.0 are met:
- [x] `CapabilityReadiness` has exactly 4 values
- [x] All 19 capability IDs defined and schema-validated
- [x] `CapabilityEntry` accepts all readiness levels and optional fields
- [x] `AdapterCapabilityContract` structurally valid
- [x] Tool-policy capability references `@weave/core` concepts (no duplication)
- [x] All public types exported from engine barrel
- [x] 27 tests pass, 0 fail
- [x] Typecheck clean across all packages
- [x] Lint clean
- [x] Fixtures sanitized
