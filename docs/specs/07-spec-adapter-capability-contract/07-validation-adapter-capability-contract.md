# 07-validation-adapter-capability-contract.md

## 1. Executive Summary

| Field | Value |
| --- | --- |
| **Overall** | **PASS** — all validation gates clear |
| **Implementation Ready** | **Yes** — all 5 tasks complete, 415 tests pass, typecheck and lint clean |
| **Requirements Verified** | 4/4 Functional Requirements (100%) |
| **Proof Artifacts Working** | 17/17 (100%) |
| **Files Changed vs Expected** | 13 core/supporting files changed; all mapped to Spec 07 tasks |

No CRITICAL or HIGH issues. One MEDIUM traceability note (proof doc language vs implementation) and one LOW note on conditional tasks.

---

## 2. Coverage Matrix

### Functional Requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| **Unit 1 — Shared Capability Model** | Verified | `capability-contract.ts`: `CapabilityReadiness` = 4 values, 19 `CapabilityId` constants, `CapabilityEntry` with all optional fields; 27 tests pass; typecheck clean; engine barrel exports all types and helpers |
| **Unit 2 — Core Readiness Profile Evaluation** | Verified | `evaluateCoreReadinessProfile` passes required `native`/`emulated`, fails required `degraded`/`unsupported`, warns optional gaps; coverage guard asserts 12 required + 7 optional = 19; 25 tests pass |
| **Unit 3 — Runtime Health Report / Safe Adapter Init** | Verified | `buildAdapterHealthReport` is pure (no `Bun.file`, `Bun.spawn`, directory scans); `SafeAdapterInitInput` JSDoc explicitly forbids agent materialization, hook registration, workflow launch; 21 tests pass |
| **Unit 4 — CLI Renderer-Ready Structures** | Verified | `buildHumanRows`, `buildToonRows`, `toJson` implemented in engine; deterministic ordering (required first, then optional); JSON parseable; TOON deterministic across runs; 33 tests pass. CLI presentation helpers (tasks 4.8/4.9) resolved as not-needed — engine owns structures per planning assumption |
| **Unit 5 — Documentation and Installer Migration** | Verified | `docs/adapter-boundary.md` and `docs/product-vision.md` both link to Spec 07 in their Related section and in dedicated sections; `HarnessInstaller.supported` annotated `@deprecated` with migration path; proof-artifact redaction guidance documented in T5 proof |

### Repository Standards

| Standard Area | Status | Evidence & Compliance Notes |
| --- | --- | --- |
| **Bun-only runtime** | Verified | No `node:fs`, `@types/node`, `ts-node`; only `zod` imported in `capability-contract.ts`; build uses `bun build` |
| **`neverthrow` for fallible functions** | Verified | Engine helpers are pure/infallible by design (adapter-boundary rule); probe failures captured as `CapabilityProbeResult` discriminated union (`ok`/`degraded`/`unavailable`) — no fallible logic introduced that would require `Result` wrapping |
| **No `console.*`** | Verified | Zero `console.*` calls in all new source and test files |
| **No harness I/O in engine** | Verified | `capability-contract.ts` imports only `zod`; contains no `Bun.file`, `Bun.spawn`, directory reads, or hook registration |
| **Zod schemas for structured inputs** | Verified | `CapabilityReadinessSchema`, `CapabilityIdSchema`, `CapabilityEntrySchema`, `AdapterCapabilityContractSchema` defined and exported |
| **Mock-based isolated tests** | Verified | All test files use synthetic fixtures (`supplier: "synthetic-adapter"`); no real harness started |
| **Public exports via engine barrel** | Verified | `packages/engine/src/index.ts` exports all 12 types and 7 function/constant symbols from `capability-contract.ts` |
| **Conventional Commits** | Verified | All 5 commits follow `feat(engine):` / `docs(engine):` pattern with task references |
| **Living documentation** | Verified | `docs/adapter-boundary.md` and `docs/product-vision.md` updated with links and readiness semantics |

### Proof Artifacts

| Unit/Task | Proof Artifact | Status | Verification Result |
| --- | --- | --- | --- |
| T1 | `bun test packages/engine/src/__tests__/capability-contract.test.ts` | Verified | 27 pass, 0 fail, 102 expect() calls — re-run confirmed |
| T1 | `bun run typecheck` | Verified | All 5 packages exit code 0 — re-run confirmed |
| T1 | `packages/engine/src/index.ts` exports capability model | Verified | 12 types + 7 exports confirmed via grep |
| T1 | Tool-policy capability references `@weaveio/weave-core` concepts | Verified | No policy enum duplication; notes reference `ToolPolicy` concepts |
| T1 | Fixtures sanitized | Verified | No credentials, `/Users/`, API keys in any fixture |
| T2 | `bun test packages/engine/src/__tests__/capability-readiness.test.ts` | Verified | 25 pass, 0 fail, 92 expect() calls — re-run confirmed |
| T2 | Coverage guard: 12 required + 7 optional = 19 | Verified | `REQUIRED_CAPABILITIES` and `OPTIONAL_CAPABILITIES` arrays validated by test |
| T2 | Sanitized JSON fixture | Verified | Fixture uses `"synthetic-adapter"`, no credentials |
| T3 | `bun test packages/engine/src/__tests__/adapter-health-report.test.ts` | Verified | 21 pass, 0 fail, 43 expect() calls — re-run confirmed |
| T3 | `buildAdapterHealthReport` pure (no harness I/O) | Verified | Function body: `evaluateCoreReadinessProfile` + `new Date().toISOString()` + object spread only |
| T3 | Safe Adapter Init documented as read-only | Verified | JSDoc on `SafeAdapterInitInput` enumerates 6 MUST NOT constraints |
| T3 | Fixtures sanitized | Verified | `details: "Synthetic: config file found at <redacted>"` pattern confirmed |
| T4 | `bun test packages/engine/src/__tests__/capability-reporting.test.ts` | Verified | 33 pass, 0 fail, 261 expect() calls — re-run confirmed |
| T4 | TOON deterministic | Verified | Same input produces identical output across repeated runs |
| T4 | JSON parseable | Verified | `toJson` returns 2-space indented JSON with `profileResult`, `harness`, `timestamp` |
| T5 | `docs/adapter-boundary.md` and `docs/product-vision.md` link to Spec 07 | Verified | Links found in Related section and dedicated sections in both docs |
| T5 | `HarnessInstaller.supported` `@deprecated` | Verified | Lines 38 and 51 of `packages/cli/src/installers/index.ts` |

---

## 3. Validation Issues

| Severity | Issue | Impact | Recommendation |
| --- | --- | --- | --- |
| MEDIUM | **Proof doc language imprecise for T3.** `07-task-03-proofs.md` states "runtime probe failures are represented with `Result`/`ResultAsync` error types." The actual implementation models probe failures as a `CapabilityProbeResult` discriminated union (`probeStatus: "ok" \| "degraded" \| "unavailable"`) — not `neverthrow` `Result` types. The spec condition "when fallible logic is introduced" was correctly resolved as not triggered (engine helpers are pure), so the implementation is valid. The proof doc claim overstates what was done. | Traceability gap — proof doc misleads future readers about `neverthrow` usage | Update `07-task-03-proofs.md` to state that probe failures are modeled as a `CapabilityProbeResult` discriminated union because the engine helpers have no fallible logic paths, satisfying the spec's `neverthrow` requirement conditionally |
| LOW | **Conditional tasks 4.8 and 4.9 checked without explanation.** Tasks 4.8 and 4.9 (`packages/cli/src/readiness/render.ts` and its test) are marked `[x]` but the files do not exist. The tasks were conditional ("If CLI presentation helpers are added") and the planning assumption resolved them as not needed. The checkbox state is technically correct but leaves no inline explanation. | Minor readability gap — future readers may wonder why the files are absent | Add a brief inline note to tasks 4.8 and 4.9 in the task list explaining the conditional was resolved as not-needed per the T4 planning assumption |

---

## 4. Evidence Appendix

### Git Commits Analyzed

| Commit | Task | Summary |
| --- | --- | --- |
| `e3f9607` | T1 | `feat(engine): add shared adapter capability model and engine exports` — `capability-contract.ts`, `index.ts`, test file, task list |
| `c432943` | T2 | `feat(engine): add Core Readiness Profile evaluator tests` — 25 tests, task list |
| `2315a6e` | T3 | `feat(engine): add adapter health report and Safe Adapter Init tests` — 21 tests, task list |
| `88698ce` | T4 | `feat(engine): add renderer-ready readiness report structure tests` — 33 tests, task list |
| `61a92ed` | T5 | `docs(engine): document adapter capability contract and installer migration` — `adapter-boundary.md`, `product-vision.md`, `installers/index.ts` |

All commits reference "Spec 07" and a task number (`T1`–`T5`) or close `#49`.

### Quality Gates — Live Run Results

```
bun test (all files)
  415 pass
  0 fail
  1280 expect() calls
  Ran 415 tests across 28 files. [237ms]

bun run typecheck
  @weaveio/weave-core typecheck: Exited with code 0
  @weaveio/weave-config typecheck: Exited with code 0
  @weaveio/weave-engine typecheck: Exited with code 0
  @weaveio/weave-adapter-opencode typecheck: Exited with code 0
  @weaveio/weave-cli typecheck: Exited with code 0

bun run lint
  Checked 75 files in 77ms. No fixes applied.

bun run build
  @weaveio/weave-config build: Exited with code 0
  @weaveio/weave-engine build: Exited with code 0
  @weaveio/weave-cli build: Exited with code 0
  @weaveio/weave-adapter-opencode build: Exited with code 0
```

### Capability-Contract File Verification

```
packages/engine/src/capability-contract.ts          638 lines — exists ✓
packages/engine/src/index.ts                        — exports 12 types + 7 symbols ✓
packages/engine/src/__tests__/capability-contract.test.ts   — exists ✓
packages/engine/src/__tests__/capability-readiness.test.ts  — exists ✓
packages/engine/src/__tests__/adapter-health-report.test.ts — exists ✓
packages/engine/src/__tests__/capability-reporting.test.ts  — exists ✓
packages/cli/src/installers/index.ts                — @deprecated annotations on lines 38, 51 ✓
docs/adapter-boundary.md                            — Spec 07 linked (lines 8, 167) ✓
docs/product-vision.md                              — Spec 07 linked (lines 7, 164) ✓
```

### Security / Sanitization Check

- Zero occurrences of `console.*` in all new source and test files.
- Zero occurrences of `Bun.file`, `Bun.spawn`, `readdir`, or directory-scanning APIs in `capability-contract.ts`.
- No API keys, tokens, passwords, or local paths (`/Users/`, `/home/`) in any proof artifact or fixture.
- All fixtures use `supplier: "synthetic-adapter"` and notes prefixed `"Synthetic:"`.
- Path redaction example present: `"Synthetic: config file found at <redacted>"`.

---

**Validation Completed:** 2026-05-15  
**Validation Performed By:** Claude Sonnet 4.6 (Tapestry / SDD Validator)
