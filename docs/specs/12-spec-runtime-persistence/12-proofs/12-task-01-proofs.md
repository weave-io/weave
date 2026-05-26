# Task 1 Proof Artifact — Migrate DSL settings into `settings` block

## Summary

Task 1 migrates `log_level` from a top-level DSL setting into a `settings { ... }` block.
Top-level `log_level` is now rejected with a `ValidationError`. The `settings` block also
introduces `runtime.journal.strict` (boolean, default `false`) for Spec 12 runtime persistence.

---

## Test Output

```
bun test packages/core/src/__tests__/schema.test.ts \
         packages/core/src/__tests__/validate.test.ts \
         packages/core/src/__tests__/parser.test.ts \
         packages/core/src/__tests__/parse_config.test.ts
```

```
bun test v1.3.13 (bf2e2cec)

 122 pass
 0 fail
 368 expect() calls
Ran 122 tests across 4 files. [29.00ms]
```

### New test coverage added

| File | New describe block | Tests added |
|---|---|---|
| `schema.test.ts` | `LogLevelSchema` | 3 |
| `schema.test.ts` | `RuntimeSettingsSchema` | 3 |
| `schema.test.ts` | `SettingsConfigSchema` | 8 |
| `schema.test.ts` | `WeaveConfigSchema — settings integration` | 4 |
| `validate.test.ts` | `validate — settings block` | 8 |
| `parser.test.ts` | `Parser — settings block` | 2 |
| `parse_config.test.ts` | `parseConfig — settings block` | 5 |

---

## Typecheck Output

```
bun run typecheck
```

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

---

## Full Test Suite

```
bun test
```

```
bun test v1.3.13 (bf2e2cec)

 1032 pass
 0 fail
 2705 expect() calls
Ran 1032 tests across 35 files. [154.00ms]
```

---

## Acceptance Criteria Verification

| # | Criterion | Status |
|---|---|---|
| 1 | `SettingsConfigSchema` exists with `log_level` (enum, default INFO) and `runtime.journal.strict` (boolean, default false) | ✅ |
| 2 | `WeaveConfigSchema` accepts `settings { log_level INFO }` and rejects top-level `log_level` (via validate layer) | ✅ |
| 3 | Validation transforms nested `settings { ... }` block into the schema shape | ✅ |
| 4 | Parser correctly handles nested settings block syntax | ✅ |
| 5 | Config merge works across global/project layers without regressing agents/categories/workflows | ✅ |
| 6 | All four test files have coverage: valid settings, default `runtime.journal.strict false`, invalid settings, top-level `log_level` rejection | ✅ |
| 7 | `AGENTS.md` DSL examples use `settings { log_level INFO }` (not top-level `log_level INFO`) | ✅ |
| 8 | `bun test packages/core/src/__tests__/schema.test.ts packages/core/src/__tests__/validate.test.ts packages/core/src/__tests__/parser.test.ts packages/core/src/__tests__/parse_config.test.ts` passes | ✅ 122 pass, 0 fail |
| 9 | `bun run typecheck` passes | ✅ All 5 packages exit 0 |

---

## Files Changed

### Core schema and validation
- `packages/core/src/schema.ts` — Added `LogLevelSchema`, `RuntimeSettingsSchema`, `SettingsConfigSchema`; updated `WeaveConfigSchema` to include `settings`; removed top-level `log_level`; added inferred types
- `packages/core/src/validate.ts` — Updated `astToPlainObject` to handle `settings { }` block and reject top-level `log_level`; updated `validate()` to return early with error on top-level `log_level`
- `packages/core/src/index.ts` — Exported new schemas and types: `LogLevelSchema`, `RuntimeSettingsSchema`, `SettingsConfigSchema`, `LogLevel`, `RuntimeSettings`, `SettingsConfig`

### Tests
- `packages/core/src/__tests__/schema.test.ts` — Added `LogLevelSchema`, `RuntimeSettingsSchema`, `SettingsConfigSchema`, `WeaveConfigSchema — settings integration` test suites
- `packages/core/src/__tests__/validate.test.ts` — Replaced `validate — log_level setting` with `validate — settings block` (8 tests)
- `packages/core/src/__tests__/parser.test.ts` — Added `Parser — settings block` (2 tests)
- `packages/core/src/__tests__/parse_config.test.ts` — Updated full-config test to use `settings { log_level INFO }`; added `parseConfig — settings block` (5 tests)

### Config package
- `packages/config/src/__tests__/merge.test.ts` — Updated tests (a) and (b) to use `settings { log_level ... }`
- `packages/config/src/__tests__/load_config.test.ts` — Updated test (d) to use `settings { log_level ... }`

### CLI package
- `packages/cli/src/commands/validate.ts` — Updated `formatSummary` to use `config.settings.log_level`
- `packages/cli/src/config/starter-config.ts` — Updated starter config template to use `settings { log_level INFO }`
- `packages/cli/src/__fixtures__/valid.weave` — Updated fixture to use `settings { log_level INFO }`

### Scripts (removed)

> **Note**: The `scripts/validate-config.ts` script and its associated test and fixture files were removed in a subsequent cleanup. The `printSummary` / `log_level` logic described here was migrated to the CLI `validate` command at `packages/cli/src/commands/validate.ts` (see `formatSummary`). Use `weave validate` to exercise this behaviour.

### Engine
- `packages/engine/src/__tests__/skill-resolution.test.ts` — Updated `makeConfig` helper to include `settings` field

### Documentation
- `AGENTS.md` — Updated DSL example to use `settings { log_level INFO }`
- `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-01-proofs.md` — This file

---

## Design Notes

**Top-level `log_level` rejection**: Zod's `z.object()` strips unknown keys before `.refine()` runs,
so the rejection is enforced at the AST validation layer (`validate.ts`) rather than in the Zod schema.
The `astToPlainObject` function detects `log_level` as a top-level `SettingAssignment` and returns
`topLevelLogLevel: true`, causing `validate()` to return a `ValidationError` before Zod is invoked.
The schema test documents this behavior explicitly.

**Settings merge**: The `settings` object deep-merges across global/project config layers via the
existing `mergeValues` recursive merge in `packages/config/src/merge.ts`. No changes to merge logic
were needed — the `settings` object is a plain nested object and merges correctly by default.
