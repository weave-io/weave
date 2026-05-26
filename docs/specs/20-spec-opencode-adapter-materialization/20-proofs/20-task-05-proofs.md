# Task 5 Proof Artifact — Document the Adapter Shape and Prove Acceptance

**Task**: 5.0 Document the adapter shape and prove acceptance for the first slice  
**Spec**: 20-spec-opencode-adapter-materialization  
**Date**: 2026-05-26

---

## Summary

Task 5 completes the documentation and acceptance proof for the first-slice
`@weave/adapter-opencode` materialization path. All five subtasks are complete:

| Subtask | Description | Status |
|---------|-------------|--------|
| 5.1 | Write `docs/adr/0003-opencode-adapter-materialization-shape.md` | ✅ |
| 5.2 | Update `docs/adapter-readiness-status.md` with first-slice section | ✅ |
| 5.3 | Update `docs/adapter-boundary.md` link references | ✅ |
| 5.4 | Run quality gate and record results | ✅ |
| 5.5 | Finalize sanitized smoke checklist reference | ✅ |

---

## Documents Created / Updated

### 5.1 — `docs/adr/0003-opencode-adapter-materialization-shape.md` (new)

Documents four key design decisions for the first-slice adapter shape:

1. **SDK-first, plugin/runtime-first entry path** — `@weave/adapter-opencode`
   is an OpenCode plugin. Users install it via `opencode.json`'s `plugin` array.
   The plugin host injects a pre-constructed SDK client; the adapter never
   constructs its own.

2. **Injected client, adapter-owned SDK facade** — All SDK calls flow through
   the narrow `OpenCodeClientFacade` interface (`opencode-client.ts`). The
   `SdkOpenCodeClient` is the production implementation; tests use in-memory
   mocks. `sdk-types.ts` is the sole SDK import surface.

3. **Adapter-owned model resolution with engine helper** — `model-resolution.ts`
   gathers `OpenCodeModelContext` from the harness and calls the engine's pure
   `resolveAdapterModelIntent()`. Adds one adapter-local rule: fail-fast for
   explicit subagent model intent that cannot be satisfied.

4. **Harness-owned skill discovery, adapter-forwarded** — `skill-discovery.ts`
   contains no filesystem I/O. The harness injects `SkillInfo[]` via
   `OpenCodeAdapterOptions.availableSkills`; `loadAvailableSkills()` returns it
   unchanged. Missing declared skills are hard errors (no silent skips).

5. **Ownership-safe upsert via `[weave-managed]` tag** — `reconcile-agent.ts`
   implements the `list → classify → create/update` flow. `descriptor.name` is
   the Canonical Agent Name. The `[weave-managed]` tag in `description` is the
   ownership signal. `CollisionError` is returned for same-named foreign agents.
   First-slice is upsert-only (no prune/delete).

### 5.2 — `docs/adapter-readiness-status.md` (updated)

Added:
- Link to ADR 0003 and Spec 20 in the Related section.
- New **OpenCode Adapter — First-Slice Materialization** section with:
  - Capability table (8 rows, all ✅).
  - Explicit non-goals table (prune/delete, workflow-lifecycle, engine API drift,
    skill file loading).
  - Installation and runtime story (`opencode.json` `plugin` array + restart).

### 5.3 — `docs/adapter-boundary.md` (updated)

Added links to ADR 0003 and Spec 20 in the Related section. No ownership rules
changed — the implementation confirmed the existing boundary is correct and
complete for the first slice.

---

## Quality Gate Results

### Command

```
bun run typecheck && \
bun test packages/adapters/opencode/src/__tests__/adapter.test.ts && \
bun test packages/adapters/opencode/src/__tests__/reconcile-agent.test.ts && \
bun test packages/adapters/opencode/src/__tests__/model-resolution.test.ts && \
bun test packages/adapters/opencode/src/__tests__/skill-discovery.test.ts && \
bun test packages/adapters/opencode/src/__tests__/run-workflow.test.ts
```

### Results

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0

bun test v1.3.13 (bf2e2cec)
 137 pass
 0 fail
 273 expect() calls
Ran 137 tests across 5 files. [68.00ms]
```

All 5 packages pass typecheck. All 137 tests pass across 5 test files.

### Per-file test breakdown

| Test file | Tests | Status |
|-----------|-------|--------|
| `adapter.test.ts` | 40 | ✅ pass |
| `reconcile-agent.test.ts` | 42 | ✅ pass |
| `model-resolution.test.ts` | 23 | ✅ pass |
| `skill-discovery.test.ts` | 24 | ✅ pass |
| `run-workflow.test.ts` | 8 | ✅ pass |
| **Total** | **137** | **✅ all pass** |

---

## Sanitized Manual Smoke Checklist

The sanitized manual smoke checklist is at:

```
docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md
```

### Smoke checklist summary

The checklist verifies that a Weave-authored agent appears in OpenCode after
materialization via the real SDK path. Key steps:

1. Create `/tmp/weave-smoke-test` with a minimal `.weave/config.weave` declaring
   `smoke-test-agent`.
2. Write a plugin entry point (`weave-plugin.ts`) that constructs
   `OpenCodeAdapter` with an injected `SdkOpenCodeClient` and calls
   `spawnSubagent()` for each descriptor.
3. Run `bun run weave-plugin.ts` — expected output: `Materialized agent: smoke-test-agent`.
4. Verify `smoke-test-agent` appears in OpenCode with `[weave-managed]` in its
   description.
5. Run a second time — verify idempotency (no duplicate, no error).
6. Create a foreign agent with the same name (no `[weave-managed]` tag) and run
   again — verify `CollisionError` is logged and the foreign agent is not
   overwritten.

**Pass criteria**: plugin runs without uncaught exception; agent appears in
OpenCode; `[weave-managed]` tag present; second run is idempotent; foreign agent
triggers `CollisionError`.

> **Note**: This checklist uses `@weave/adapter-opencode` only. The legacy
> `weave` OpenCode plugin must not be active during this test. Use a clean
> project or temporarily disable the legacy plugin in `opencode.json`.

---

## Proof References

| Artifact | Path |
|----------|------|
| ADR 0003 | `docs/adr/0003-opencode-adapter-materialization-shape.md` |
| Adapter Readiness Status | `docs/adapter-readiness-status.md` |
| Adapter Boundary | `docs/adapter-boundary.md` |
| Smoke checklist | `docs/specs/20-spec-opencode-adapter-materialization/20-smoke-checklist-task-02.md` |
| Task 1 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-01-proofs.md` |
| Task 2 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-02-proofs.md` |
| Task 3 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-03-proofs.md` |
| Task 4 proof | `docs/specs/20-spec-opencode-adapter-materialization/20-proofs/20-task-04-proofs.md` |
| Adapter entry point | `packages/adapters/opencode/src/index.ts` |
| SDK facade | `packages/adapters/opencode/src/opencode-client.ts` |
| Reconciliation | `packages/adapters/opencode/src/reconcile-agent.ts` |
| Model resolution | `packages/adapters/opencode/src/model-resolution.ts` |
| Skill discovery | `packages/adapters/opencode/src/skill-discovery.ts` |

---

## Acceptance Criteria Verification

| Criterion | Met? | Evidence |
|-----------|------|----------|
| ADR 0003 documents SDK-first, plugin/runtime-first, injected-client, and ownership-safe decisions | ✅ | `docs/adr/0003-opencode-adapter-materialization-shape.md` — 5 decisions documented with context, decision, consequences, and references |
| `adapter-readiness-status.md` describes first slice, remaining non-goals, and installation/runtime story | ✅ | New "OpenCode Adapter — First-Slice Materialization" section with capability table, non-goals, and `opencode.json` install snippet |
| `adapter-boundary.md` changes stay within current boundary rules and do not invent new engine contracts | ✅ | Only link additions; no ownership rules changed; implementation confirmed existing boundary is correct |
| Proof file exists with reviewer-friendly context, raw evidence, sanitized smoke checklist path/command, and quality gate results | ✅ | This file |
| Quality gate passes: `bun run typecheck && bun test [5 test files]` | ✅ | 137/137 tests pass; all 5 packages typecheck clean |
| Commit references Task 5 and Spec 20 | ✅ | Conventional Commit with `(adapter-opencode)` scope and task/spec reference in body |
