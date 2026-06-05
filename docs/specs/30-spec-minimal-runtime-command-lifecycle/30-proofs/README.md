# 30-proofs — Proof Artifacts for Spec 30

**Spec**: [30 — Minimal Runtime Command Lifecycle](../30-spec-minimal-runtime-command-lifecycle.md)
**Contract**: [Command-Operation Contract](../30-command-operation-contract.md)

---

## Purpose

This directory contains non-normative proof artifacts that connect user-invoked
command/handler input to lifecycle state transitions and final status/health results.
They satisfy the dogfood evidence requirements in Spec 30 Units 2, 3, and 4.

No artifact in this directory contains secrets, API keys, credentials, private prompts,
or sensitive local paths beyond workspace-relative references.

---

## Artifacts

| File | What it proves |
|---|---|
| [`opencode-runtime-command-dogfood.md`](./opencode-runtime-command-dogfood.md) | Explicit handler invocation → lifecycle state transition → final status/health result for all six operations. Includes structured pino log evidence and degraded-affordance documentation for `/weave:abort` and `/weave:advance`. |
| [`health-summary.json`](./health-summary.json) | Real `RuntimeHealthData` output from `buildOpenCodeHealthReport()` + `runtimeHealth()` — adapter capability table, readiness verdict, degraded/unsupported operation lists. |

---

## Evidence Model

All evidence is produced by invoking the explicit adapter handler methods
(`RuntimeCommandProjection.handleStartPlan`, `.handleRunWorkflow`, etc.) with
in-memory fixtures — no real OpenCode TUI, no filesystem, no harness startup.
This is the correct evidence model for this spec because:

1. **Native slash delivery is degraded** — OpenCode does not yet expose
   `/weave:start`, `/weave:run`, `/weave:status`, `/weave:abort`, `/weave:advance`,
   or `/weave:health` as registered TUI slash commands in this slice. The explicit
   handler invocation is the documented equivalent path.

2. **The adapter boundary is the proof boundary** — the spec requires evidence
   that user-invoked input reaches the shared engine lifecycle and produces a typed
   result. The `RuntimeCommandProjection` class is the adapter-owned boundary where
   that delegation happens. Invoking it directly is equivalent to invoking it from
   a slash command handler.

3. **Structured pino log output is the event/journal evidence** — the engine emits
   structured JSON log lines at each lifecycle transition. These lines are captured
   in the dogfood document and prove the command → lifecycle → result chain without
   exposing harness internals.

---

## Degraded Affordances

Two operations are documented as degraded in this slice:

| Command | Reason | Equivalent |
|---|---|---|
| `/weave:abort` | Native TUI abort button not yet wired to `abortExecution` | Call `abortExecution` via plugin tool or script |
| `/weave:advance` | Native TUI step-advance UI not yet wired to `advanceStep` | Call `advanceStep` via plugin tool or script |

These are declared in `DEGRADED_AFFORDANCES` in
[`packages/adapters/opencode/src/runtime-command-projection.ts`](../../../../packages/adapters/opencode/src/runtime-command-projection.ts)
and tested in
[`packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts`](../../../../packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts).

---

## Test Coverage Summary

All six operations are covered by passing tests:

| Test file | Tests | Assertions |
|---|---|---|
| `packages/engine/src/__tests__/runtime-command-operations.test.ts` | 93 | 296 |
| `packages/adapters/opencode/src/__tests__/runtime-command-projection.test.ts` | 58 | 165 |
| `packages/engine/src/__tests__/status-control.test.ts` | 26 | 97 |
| `packages/engine/src/__tests__/runtime-health.test.ts` | 24 | 66 |
| **Total (all tests)** | **2968** | **8292** |

Run: `bun test` from the repository root. All 2968 tests pass, 0 fail.
