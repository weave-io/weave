# ADR 0005: Remediation Decisions for Specs 24–28

**Status**: Accepted  
**Date**: 2026-06-03  
**Related**: [Spec 24 — Execution Lifecycle Decomposition](../specs/24-spec-execution-lifecycle-decomposition/24-spec-execution-lifecycle-decomposition.md) · [Spec 25 — CLI Init and Migration Decomposition](../specs/25-spec-cli-init-and-migration-decomposition/25-spec-cli-init-and-migration-decomposition.md) · [Spec 26 — OpenCode Adapter Boundary Cleanup](../specs/26-spec-opencode-adapter-boundary-cleanup/26-spec-opencode-adapter-boundary-cleanup.md) · [Spec 27 — DSL Model and Schema Cleanup](../specs/27-spec-dsl-model-and-schema-cleanup/27-spec-dsl-model-and-schema-cleanup.md) · [Spec 28 — Documentation Information Architecture Repair](../specs/28-spec-documentation-information-architecture-repair/28-spec-documentation-information-architecture-repair.md)

---

## Purpose

Each of Specs 24–28 contains open questions that must be resolved before source changes begin. This ADR records the accepted answer for each open question so that downstream tasks implement one coherent branch rather than discovering conflicts mid-stream.

---

## Baseline (recorded before any source changes)

### `bun run typecheck`

```
packages/cli/src/commands/init.ts(1227,9): error TS2451: Cannot redeclare block-scoped variable 'validationResult'.
packages/cli/src/commands/init.ts(1240,9): error TS2451: Cannot redeclare block-scoped variable 'validationResult'.
packages/cli/src/commands/init.ts(1240,40): error TS2552: Cannot find name 'migratedContent'. Did you mean 'buildMigratedContent'?
exit code: 2
```

Three pre-existing type errors in `packages/cli/src/commands/init.ts` (lines 1227, 1240). These are the duplicate validation block identified in Spec 25 Unit 1. All other packages typecheck cleanly.

### `bun test` (scoped — full suite hangs on CLI migrate/init tests)

| Scope | Pass | Fail | Files |
|---|---|---|---|
| `packages/core` + `packages/config` + `packages/engine` | 2060 | 0 | 37 |
| `packages/cli` (non-command tests) | 54 | 0 | 6 |
| `packages/cli/src/commands/__tests__/validate.test.ts` + `runtime.test.ts` | 40 | 0 | 2 |
| `packages/cli/src/commands/__tests__/migrate*.test.ts` + `init.test.ts` | hangs | — | 3 |
| `packages/adapters` | 215 | 0 | 8 |

**Total confirmed passing**: 2369 tests across 53 files.  
**Known hang**: CLI migrate and init test files do not complete within 120 s. This is a pre-existing condition, not introduced by this workstream.

---

## Decision 1 — Spec 24: Legacy no-context execution paths

**Open question**: Which legacy no-context execution paths are still contractually required, if any?

**Decision**: **Remove all no-context (legacy) execution paths.**

**Evidence**:
- The OpenCode adapter (`packages/adapters/opencode/src/run-workflow.ts`) always constructs a `WorkflowExecutionContext` and passes it to every lifecycle call (`startExecution`, `dispatchStep`, `completeStep`). No adapter call site omits `context`.
- The `context?: WorkflowExecutionContext | undefined` optional parameter and the `if (context === undefined)` branches in `execution-lifecycle.ts` exist solely for backward compatibility with a pre-Spec-22 call pattern that no active adapter uses.
- ADR 0004 explicitly states that the legacy `/start-work` → Tapestry flow is no longer the architectural center and that adapters must call the engine lifecycle surface with explicit context.
- No documented contract in `docs/` requires the no-context fallback path.

**Consequence**: Spec 24 Unit 2 shall remove the `context?: ...` optional parameter from `dispatchStep`, `completeStep`, and `resumeExecution` inputs, making `context` required. Any retained compatibility branch must be documented inline with a justification comment.

---

## Decision 2 — Spec 24: Lifecycle module grouping strategy

**Open question**: Should lifecycle module names follow operation-based grouping, concern-based grouping, or a hybrid structure?

**Decision**: **Concern-based grouping.**

**Rationale**: The lifecycle file mixes four distinct concerns — types/errors, validation helpers, orchestration helpers (lease loading, terminal outcomes), and operation handlers (the seven public methods). Operation-based grouping would produce seven thin files with heavy cross-imports. Concern-based grouping produces four files with clear ownership and minimal coupling:

| File | Responsibility |
|---|---|
| `execution-lifecycle/types.ts` | Discriminated error types, input/output types, effect types |
| `execution-lifecycle/validation.ts` | Input validation helpers, metadata sanitization, denylist |
| `execution-lifecycle/orchestration.ts` | Canonical helpers: lease+instance loading pipeline, terminal outcome handler |
| `execution-lifecycle/operations.ts` | The seven public lifecycle methods (thin, delegates to helpers) |
| `execution-lifecycle/index.ts` | Re-exports the public API surface; preserves `packages/engine/src/index.ts` exports |

No replacement file shall exceed 1,000 lines. The public API surface exported from `packages/engine/src/index.ts` is preserved unchanged.

---

## Decision 3 — Spec 25: Migration conversion module location

**Open question**: Should migration conversion remain under `commands/` ownership or move into a dedicated `migrate/` support area?

**Decision**: **Move into a dedicated `migrate/` support area** under `packages/cli/src/migrate/`.

**Rationale**: The conversion logic (JSONC-to-DSL translation, field mapping, warning building) is not command orchestration — it is a pure transformation that should be independently testable without a terminal or file system. Placing it under `commands/` conflates two concerns. A dedicated `migrate/` directory makes the ownership boundary obvious and allows the conversion logic to be tested in isolation.

**Layout**:

```
packages/cli/src/
├── commands/
│   ├── init.ts          (init flow only — interactive prompting, file generation)
│   └── migrate.ts       (migration command orchestration only — calls migrate/ helpers)
└── migrate/
    ├── conversion.ts    (JSONC-to-DSL field mapping and warning building)
    ├── executor.ts      (canonical read-check-write-render migration helper)
    └── index.ts         (barrel)
```

---

## Decision 4 — Spec 25: Shared terminal rendering helpers

**Open question**: Are there any intentionally shared terminal rendering helpers that should be elevated while splitting command files?

**Decision**: **Elevate shared rendering helpers to `packages/cli/src/render/`** only if two or more command files genuinely share the same rendering logic after the split. Do not pre-emptively create a `render/` module for helpers used by only one command.

**Rationale**: Premature elevation creates indirection without simplification. The split itself will reveal which helpers are truly shared. If `init.ts` and `migrate.ts` both need the same success/failure rendering after decomposition, extract to `render/`. If not, keep rendering inline in each command.

---

## Decision 5 — Spec 26: Canonical redaction helper export location

**Open question**: Should the canonical redaction helper be exported directly from the engine root barrel or from a narrower runtime module?

**Decision**: **Export from a narrower runtime module** — specifically `packages/engine/src/sanitize.ts` (or the equivalent module that already owns the denylist), re-exported from the engine barrel only if it is already part of the public surface.

**Rationale**: The engine root barrel (`packages/engine/src/index.ts`) is the public API surface for adapters and the CLI. Exporting a low-level sanitization constant from the root barrel pollutes the public surface with an implementation detail. The CLI should import the canonical denylist from the specific engine module that owns it, not from the root barrel. If the engine barrel already re-exports it, that is acceptable; if not, a direct deep import from the owning module is preferred over adding it to the barrel.

**Consequence**: `packages/cli/src/commands/runtime.ts` shall replace its local `SENSITIVE_KEYS` set with an import from the engine's canonical sanitization module. The comment "Mirrors the denylist in the engine sanitizer" (line 198) shall be removed.

**Implementation (Task 5)**: `isDeniedKey(key: string): boolean` was exported from `packages/engine/src/runtime/sanitizer.ts` and re-exported from `packages/engine/src/index.ts`. `packages/cli/src/commands/runtime.ts` now imports `isDeniedKey` from `@weave/engine` and the local `isSensitiveKey` function (with its duplicated denylist) was removed. The comment "Mirrors the denylist in the engine sanitizer" was removed along with the local copy.

---

## Decision 6 — Spec 26: Non-OpenCode call sites for the typed spawn seam

**Open question**: Are there any non-OpenCode call sites that should adopt the same seam pattern once this cleanup lands?

**Decision**: **Scope to OpenCode adapter only for this spec.** No other adapter currently has a `spawnSubagent` implementation. The Claude Code and Pi adapters are stubs. Extending the typed-result seam to those adapters is deferred until they have real implementations.

**Consequence**: Spec 26 Unit 1 changes only `packages/adapters/opencode/src/adapter.ts` and its callers. The `HarnessAdapter` interface in `packages/engine/src/adapter.ts` is updated to reflect the new return type if `spawnSubagent` is declared there; otherwise the change is adapter-local.

**Implementation (Task 5)**: `HarnessAdapter.spawnSubagent()` was updated to return `ResultAsync<void, Error>`. `OpenCodeAdapter.spawnSubagent()` now returns `ResultAsync<void, OpenCodeAdapterError>` — all failure paths use `errAsync(...)` instead of `throw`. `MockAdapter.spawnSubagent()` returns `ResultAsync<void, never>`. The `.then(ok, err)` wrapper in `plugin.ts` and the `ResultAsync.fromPromise(...)` wrappers in `run-workflow.ts` were removed; callers now use the returned `ResultAsync` directly. Adapter tests were updated to use `isErr()` / `isOk()` instead of `rejects.toThrow()` / `resolves.toBeUndefined()`.

---

## Decision 7 — Spec 27: `extend_before_plan` — simplify or expand grammar?

**Open question**: Is true per-workflow targeting valuable enough to justify grammar expansion, or is simplification the better code-judo move?

**Decision**: **Simplify — remove the phantom per-workflow targeting abstraction.**

**Evidence**:
- The parser (`packages/core/src/parser.ts` line 411) never sets `workflow` on `ExtendBeforePlanDirective`. The field is always `undefined`.
- The validator (`packages/core/src/validate.ts` line 191) uses `node.workflow ?? "__default__"` — the `__default__` sentinel is always used because the parser never produces a named target.
- The `WeaveConfig.extend_before_plan` field is typed as `z.record(z.string(), ExtendBeforePlanSchema)` but in practice only ever contains the `__default__` key.
- No spec, guide, or test documents a user-facing syntax for named workflow targeting (e.g. `extend before-plan workflow-name [...]`).
- Grammar expansion would require parser changes, new DSL syntax documentation, and new test coverage — a significant scope increase for a feature with no current users.

**Consequence**: Spec 27 Unit 1 shall:
1. Remove the `workflow?: string` field from `ExtendBeforePlanDirective` in `packages/core/src/ast.ts`.
2. Change `WeaveConfig.extend_before_plan` from `z.record(...)` to a flat `ExtendBeforePlanSchema` (or `ExtendBeforePlanSchema.optional()`), removing the keyed map entirely.
3. Update the validator to write directly to `extend_before_plan` without the `__default__` sentinel.
4. Update parser, schema, validate, and parse-config tests together in the same commit.

---

## Decision 8 — Spec 27: Shared prompt-schema helper location

**Open question**: Should shared prompt-schema helpers live in `schema.ts` or a nearby focused helper module?

**Decision**: **Keep shared helpers in `schema.ts`** as exported Zod refinement helpers or sub-schemas, not in a separate file.

**Rationale**: `schema.ts` is already the single source of truth for all Zod schemas. Extracting prompt helpers to a separate file creates an import dependency that `schema.ts` must then re-import, adding indirection without reducing complexity. Zod refinement helpers are naturally co-located with the schemas they refine. A focused helper function (e.g. `promptPathConstraints()`) defined at the top of `schema.ts` and reused by `AgentConfigSchema`, `CategoryConfigSchema`, and `WorkflowStepSchema` is the simplest correct solution.

---

## Decision 9 — Spec 28: Historical proof artifact retention

**Open question**: Should historical proof artifacts remain versioned in a non-normative directory, or should some be pruned after policy creation?

**Decision**: **Retain in a non-normative `docs/artifacts/` directory** with a clear README explaining their non-normative status. Do not prune existing artifacts — they provide audit history. New specs shall not produce proof artifacts that land in `docs/` alongside durable reference material.

**Rationale**: Pruning versioned artifacts loses audit history without meaningful benefit. Moving them to a clearly non-normative location preserves history while removing clutter from the durable docs surface.

---

## Decision 10 — Spec 28: Canonical DSL reference location

**Open question**: Should the canonical DSL reference be restored as `01-spec-core-dsl` or introduced as a new guide?

**Decision**: **Introduce as a new guide** at `docs/dsl-reference.md`, not as a numbered spec.

**Rationale**: Numbered specs (`docs/specs/`) are for formal feature specifications with acceptance criteria and proof artifacts. A DSL reference is normative reference documentation — it belongs in `docs/` alongside `adapter-boundary.md`, `prompt-composition.md`, and `workflow-schema.md`. Restoring it as `01-spec-core-dsl` would mix reference material with feature specs and create a numbering anomaly (spec 01 already exists as a directory). A top-level guide with stable cross-links is the correct home.

**Consequence**: `AGENTS.md` DSL syntax sections shall be reduced to summaries with a pointer to `docs/dsl-reference.md`. The canonical DSL contract lives in the guide, not in onboarding instructions.

---

## Workstream Commit Discipline

Each spec is implemented in its own commit sequence. Commits must not mix changes from different specs. The recommended commit prefix per spec:

| Spec | Commit scope |
|---|---|
| Spec 24 | `refactor(engine):` |
| Spec 25 | `refactor(cli):` |
| Spec 26 | `refactor(adapter-opencode):` |
| Spec 27 | `refactor(core):` |
| Spec 28 | `docs:` |

Each spec's commits are independently revertable. A reviewer can revert Spec 27 changes without touching Spec 24 changes.

---

## References

- [`packages/engine/src/execution-lifecycle.ts`](../../packages/engine/src/execution-lifecycle.ts) — Monolithic lifecycle file targeted by Spec 24.
- [`packages/cli/src/commands/init.ts`](../../packages/cli/src/commands/init.ts) — Oversized command file targeted by Spec 25; contains the pre-existing typecheck errors.
- [`packages/adapters/opencode/src/adapter.ts`](../../packages/adapters/opencode/src/adapter.ts) — Adapter spawn seam targeted by Spec 26.
- [`packages/adapters/opencode/src/run-workflow.ts`](../../packages/adapters/opencode/src/run-workflow.ts) — Confirms adapter always passes `context` to lifecycle methods.
- [`packages/cli/src/commands/runtime.ts`](../../packages/cli/src/commands/runtime.ts) — Contains the duplicated sensitive-key denylist targeted by Spec 26 Unit 2.
- [`packages/core/src/ast.ts`](../../packages/core/src/ast.ts) — `ExtendBeforePlanDirective` with phantom `workflow?` field targeted by Spec 27.
- [`packages/core/src/parser.ts`](../../packages/core/src/parser.ts) — Confirms parser never sets `workflow` on `ExtendBeforePlanDirective`.
- [`packages/core/src/validate.ts`](../../packages/core/src/validate.ts) — Confirms `__default__` sentinel is always used.
- [`docs/adr/0004-workflow-first-execution-contract.md`](0004-workflow-first-execution-contract.md) — ADR that established the explicit execution boundary; informs Decision 1.
- [`docs/adapter-boundary.md`](../adapter-boundary.md) — Engine/adapter ownership rules; informs Decisions 1, 5, and 6.
