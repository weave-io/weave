# Dead Code and Vestigial Cleanup

## TL;DR
> **Summary**: A four-tier cleanup sweep that removes orphan installer code, kills the superseded `scripts/validate-config.ts` script, un-exports 11 internals, deletes the `BUILTIN_AGENT_NAMES` constant, resolves an `ArtifactRef` name collision, fixes a DSL-first violation in `compose.ts`, converts `env.ts` to `neverthrow`, fixes a nested `try/catch`, replaces shell-out filesystem ops in the runtime store, and sweeps stale docs.
>
> **Scope note**: Tasks 4, 10, 11, 12 are **SUPERSEDED** by `.weave/plans/adapter-readiness.md`, which deletes `WeaveRunner` outright, removes the deprecated `HarnessAdapter` members, ships the production opencode adapter, and reconciles the parallel materialisation paths via partial-by-default `materializeAgents`. See [Coordination](#coordination-with-adapter-readinessmd) below.
>
> **Estimated Effort**: Medium (reduced from Large after deduplication with adapter-readiness).

## Coordination with `adapter-readiness.md`

`.weave/plans/adapter-readiness.md` is the higher-priority plan that:

- **Deletes `WeaveRunner` entirely** from `@weave/engine` and documents the canonical adapter bootstrap pattern in a new `docs/adapter-bootstrap.md`.
- **Changes `materializeAgents` to partial-by-default**: `MaterializationPlan` now carries both `agents: MaterializedAgent[]` and `errors: readonly MaterializationError[]` so adapters can implement skip-and-continue without `WeaveRunner`.
- **Removes `registerHook`, `loadSkill`, `HookConfig`, `SkillConfig`** from the `HarnessAdapter` interface and `MockAdapter`.
- **Builds a production-grade `@weave/adapter-opencode`** pinned against `@opencode-ai/sdk` types — far beyond a minimal skeleton.
- Establishes verification gates: `grep -rn 'WeaveRunner' packages/` returns zero hits in source; `grep -rn 'registerHook|loadSkill|HookConfig|SkillConfig' packages/engine/src/` returns zero hits.

As a consequence, the following tasks in **this** plan are **SUPERSEDED** and must NOT be executed here:

| Task | Title | Owner |
| --- | --- | --- |
| 4 | Remove deprecated `HarnessAdapter` members and types | `adapter-readiness.md` Task 20 |
| 10 | Implement minimal `@weave/adapter-opencode` skeleton | `adapter-readiness.md` Tasks 8–19 (production adapter) |
| 11 | Reconcile `WeaveRunner.run()` vs `materializeAgents()` parallel paths | `adapter-readiness.md` Tasks 5–7 (deletes `WeaveRunner` entirely) |
| 12 | Resolve issue #9 — wire or explicitly defer lifecycle policy surface | `adapter-readiness.md` (lifecycle surface becomes the sole adapter-facing API once `WeaveRunner` is gone) |

The body of each superseded task below has been replaced with a stub pointing here. The remaining 10 tasks (1, 2, 3, 5, 6, 7, 8, 9, 13, 14) are uniquely owned by this plan and remain unchanged.

**Sequencing with adapter-readiness**: Tier 1 tasks 1, 2, 3, 5 and all Tier 2 tasks (6, 7, 8, 9) are independent of the runner deletion and can land in either order. Tier 4 tasks 13 and 14 can also land in either order, though Task 14's doc sweep will be tidier if adapter-readiness has already landed (so the "deprecated will be removed" language can be deleted in one pass).

## Context

### Original Request
User has already made every binary decision for a four-tier cleanup pass and asked Pattern to capture the decisions in a sequenced, atomic plan. Tier 1 = safe deletions, Tier 2 = design-touching fixes, Tier 3 = strategic scope, Tier 4 = chores. No implementation — planning only.

### Key Findings
- `packages/cli/src/installers/unsupported.ts` — confirmed orphan. `grep -rn "installers/unsupported\|unsupportedHarnessInstall\|undetectedHarnessInstall"` returns hits only in the file itself and `dist/`. Zero source-tree imports.
- `scripts/validate-config.ts` + tests + `scripts/fixtures/full-config.weave` — `package.json` `validate-config` script already delegates to the CLI (`bun packages/cli/src/main.ts validate --project`). The standalone script's `printSummary` is referenced in `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-01-proofs.md` and `.codesight/*` indexes (auto-generated; ignore).
- The 11 internal helpers to un-export are confirmed used only within their own source file (no cross-file imports outside tests). Lexer/parser tests already use the public `tokenize`/`parse` wrappers — no test rewrites needed for those two; the class names are simply not imported.
- `HarnessAdapter` deprecated members: `HookConfig` (adapter.ts:23), `SkillConfig` (adapter.ts:36), `registerHook()` (adapter.ts:97), `loadSkill()` (adapter.ts:109). Touch points: `mock-adapter.ts` lines 31, 62-63, 88-97; `execution-lifecycle-integration.test.ts` lines 330-334, 384-394; `runner.test.ts` lines 1034-1035. The TODO(#9) at `runner.ts:141` references the lifecycle surface superseding `registerHook()`.
- `BUILTIN_AGENT_NAMES` is exported from `packages/config/src/builtins.ts:12` and `index.ts:9`. Used in 3 test files only: `builtin-prompts.test.ts:15`, `load_config.test.ts:4`, `builtins.test.ts:4`. `getBuiltinConfig()` and `BUILTIN_WEAVE_SOURCE` are both already exported and parseable — derivation is trivial.
- `ArtifactRef` name collision: `packages/core/src/schema.ts:129` (`{ name, description }` DSL workflow refs) vs `packages/engine/src/runtime/types.ts:147` (`{ name, path, mimeType?, description? }` runtime persistence records). Both are re-exported from their respective package barrels (`core/index.ts:54,74` and `engine/index.ts:181`). Core's `ArtifactRef` is referenced by `WorkflowStepSchema` (schema.ts:161-162) and `docs/workflow-schema.md`. No external (non-`packages/`) consumer references the core variant.
- `compose.ts:128-135` `shouldExcludeSharedShuttleTarget` hardcodes the literal `"shuttle"` agent name — violates DSL-first principle that no builtin name should be special-cased in engine code. Test coverage exists at `compose.test.ts:400-431` (the two "shuttle excludes category shuttles" tests).
- `packages/engine/src/env.ts` uses `throw new Error(...)` and `NodeJS.ProcessEnv` type (forbidden — Bun-only project). Module-level `export const env = parseEnv()` crashes on import.
- `packages/cli/src/commands/runtime.ts:385-397` contains a nested `try { try { ... } finally { db.close() } } catch { ... }` block that violates AGENTS.md "No nested try/catch".
- `packages/adapters/opencode/src/index.ts` is **0 bytes**. `package.json` already declares deps on `@weave/core` and `@weave/engine`. Build script exists. No `test` script.
- `WeaveRunner.run()` (`runner.ts:127-`) and `materializeAgents()` (`materialization.ts:75`) coexist as parallel adapter-facing paths. `runner.ts:149-157` is a verbatim TODO comment documenting the reconciliation gap.
- `packages/engine/src/runtime/sqlite/store.ts:1090,1102,1152-1154` use `Bun.spawnSync(["mkdir"|"chmod", ...])` — shell-out for filesystem ops.

## Objectives

### Core Objective
Land the four-tier cleanup as a sequence of small, reviewable, atomic Conventional Commits. Each commit either deletes dead code, un-exports an internal, normalises an API to project conventions, or ships a minimum-viable adapter skeleton. No behaviour change to user-facing surfaces beyond what the user explicitly requested.

### Deliverables
- [ ] All Tier 1 deletions landed (excluding superseded Task 4); `bun test` + `bun run typecheck` green.
- [ ] All Tier 2 design fixes landed; behaviour-equivalent at user-facing surface.
- [ ] Tier 3 items: **all four tasks superseded by `adapter-readiness.md`** — no work in this plan.
- [ ] Tier 4 chores landed: cross-platform fs ops, stale docs swept.
- [ ] Each task is a single commit following Conventional Commits.

### Definition of Done
- [ ] `bun test` passes from repo root.
- [ ] `bun run typecheck` passes from repo root.
- [ ] `bun run build` succeeds.
- [ ] `grep -rn "installers/unsupported" packages/` returns zero hits.
- [ ] `grep -rn "scripts/validate-config" .` returns zero source hits (only release-history references in docs allowed).
- [ ] `grep -rn "BUILTIN_AGENT_NAMES" packages/` returns zero hits.
- [ ] `grep -rn "NodeJS.ProcessEnv" packages/` returns zero hits.
- [ ] `grep -n "Bun.spawnSync" packages/engine/src/runtime/sqlite/store.ts` returns zero hits.
- [ ] Tasks owned by `adapter-readiness.md` (deprecated HarnessAdapter member removal, opencode adapter build) are verified by that plan's DoD — not duplicated here.

### Guardrails (Must NOT)
- Must NOT change DSL syntax, lexer, or parser behaviour.
- Must NOT change the `RuntimeStore` contract, schema, or migration ordering.
- Must NOT introduce `try/catch` for fallible paths — use `Result`/`ResultAsync` per AGENTS.md.
- Must NOT use `console.*` — use `logger` from `@weave/engine`.
- Must NOT use `@types/node` or `NodeJS.*` types.
- Must NOT modify `WeaveRunner`, `materializeAgents`, `HarnessAdapter` deprecated members, or the opencode adapter source in this plan — those changes belong to `adapter-readiness.md`.
- Must NOT touch auth/crypto/tokens (warp review explicitly not required for any task in this plan — see Verification).
- Must NOT collapse multiple tasks into a single commit.

---

## TODOs

### Tier 1 — Safe atomic deletions

- [ ] 1. Delete orphan `unsupported.ts` installer module
  **What**: Remove the unused installer module with `unsupportedHarnessInstall` and `undetectedHarnessInstall` exports. No call sites exist anywhere in `packages/` source.
  **Files**:
  - DELETE `packages/cli/src/installers/unsupported.ts`
  - VERIFY no test file imports from it (none expected)
  **Acceptance**:
  - `grep -rn "from.*installers/unsupported\|unsupportedHarnessInstall\|undetectedHarnessInstall" packages/` returns zero hits (excluding `dist/`).
  - `bun test` passes.
  - `bun run typecheck` passes.
  **Commit**: `chore(cli): remove orphan unsupported installer module`

- [ ] 2. Delete superseded `scripts/validate-config.ts` and fixtures
  **What**: The CLI `validate` command supersedes this script. `package.json`'s `validate-config` script already delegates. Remove the script, its tests, and its fixture file.
  **Files**:
  - DELETE `scripts/validate-config.ts`
  - DELETE `scripts/__tests__/validate-config.test.ts`
  - DELETE `scripts/fixtures/full-config.weave`
  - DELETE `scripts/fixtures/` directory if empty
  - KEEP `scripts/test-setup.ts` and `scripts/tsconfig.json` (referenced by other tooling unless verified unused — check before deletion).
  **Acceptance**:
  - `grep -rn "scripts/validate-config\|printSummary" packages/ scripts/` returns zero source hits.
  - `package.json` `validate-config` script still runs: `bun run validate-config` exits cleanly on a valid `.weave/config.weave`.
  - `bun test` passes.
  **Note**: Doc updates (`docs/specs/12-spec-runtime-persistence/12-proofs/12-task-01-proofs.md`) are deferred to Task 14.
  **Commit**: `chore(scripts): remove superseded validate-config script`

- [ ] 3. Un-export internal helpers across packages
  **What**: Drop the `export` keyword from 11 internals that are only used within their own source file. Two of them (Lexer, Parser classes) have public function wrappers (`tokenize`, `parse`) that tests already use — no test rewrites are needed for those.
  **Files** (one symbol per bullet, all in the same commit since they're trivial textual changes):
  - `packages/cli/src/commands/validate.ts` — un-export `validateExplicitPath`, `formatSummary`
  - `packages/cli/src/commands/runtime.ts` — un-export `DEFAULT_RUNTIME_DB_PATH`
  - `packages/cli/src/installers/index.ts` — un-export `unsupportedInstaller`, `skipUnsupported`
  - `packages/cli/src/fs/file-system.ts` — un-export `FileSystemErrorCause` type
  - `packages/core/src/lexer.ts` — un-export `Lexer` class
  - `packages/core/src/parser.ts` — un-export `Parser` class
  - `packages/core/src/schema.ts` — un-export `DisabledConfigSchema`, `DisabledConfig` type
  - `packages/core/src/index.ts` — remove `DisabledConfigSchema`/`DisabledConfig` from barrel if listed
  - `packages/engine/src/runtime/errors.ts` — un-export `RuntimeStoreErrorCause` type
  - `packages/engine/src/runtime/sqlite/schema.ts` — un-export `SchemaMigrationRow`, `RuntimeMetadataRow` types
  - `packages/engine/src/template-renderer.ts` — un-export `TemplateContextValue` type
  - `packages/engine/src/index.ts` — remove any of the above from barrel if listed
  **Acceptance**:
  - `bun run typecheck` passes (will surface any forgotten cross-file usage).
  - `bun test` passes.
  - For each symbol: `grep -rn "import.*<symbol>" packages/ --include="*.ts" | grep -v "/dist/"` returns only the file declaring it.
  **Pitfall**: If typecheck flags an unexpected cross-file consumer, fall back to leaving that single symbol exported and note it in the commit body.
  **Commit**: `refactor: un-export internal helpers not used across modules`

- [x] 4. ~~Remove deprecated `HarnessAdapter` members and types~~ — **SUPERSEDED**
  **Status**: Owned by `.weave/plans/adapter-readiness.md` Task 20. That plan deletes `HookConfig`, `SkillConfig`, `registerHook()`, and `loadSkill()` from `HarnessAdapter` and `MockAdapter` as part of the wider `WeaveRunner` removal. Do NOT execute this task here — it would conflict with the adapter-readiness branch.
  **Verification gate (owned by adapter-readiness)**: `grep -rn 'registerHook\|loadSkill\|HookConfig\|SkillConfig' packages/engine/src/ | grep -v 'loadAvailableSkills'` returns zero hits.

- [ ] 5. Delete `BUILTIN_AGENT_NAMES` constant, derive in tests
  **What**: Remove the redundant `BUILTIN_AGENT_NAMES` constant. Replace each of the three test usages by deriving the agent list from `Object.keys(getBuiltinConfig()._unsafeUnwrap().agents)` or equivalent.
  **Files**:
  - `packages/config/src/builtins.ts` — delete the `BUILTIN_AGENT_NAMES` export (line 12).
  - `packages/config/src/index.ts` — remove `BUILTIN_AGENT_NAMES` from the barrel re-export (line 9).
  - `packages/config/src/__tests__/builtin-prompts.test.ts` — replace usage at lines 15 (import) and 105 (loop): derive via `getBuiltinConfig()._unsafeUnwrap().agents` keys.
  - `packages/config/src/__tests__/load_config.test.ts` — replace usages at lines 4 (import), 57 (toEqual), 100 (loop) similarly.
  - `packages/config/src/__tests__/builtins.test.ts` — remove import at line 4 and rewrite the assertion at line 20 to compare against derived keys.
  **Acceptance**:
  - `grep -rn "BUILTIN_AGENT_NAMES" packages/` returns zero hits.
  - `bun test` passes (the three test files should still validate the same invariants).
  - `bun run typecheck` passes.
  **Pitfall**: When deriving in tests, sort consistently. Several existing assertions sort one side — match the same sort order to avoid spurious diffs.
  **Commit**: `refactor(config): derive builtin agent list in tests, drop constant`

### Tier 2 — Design-touching fixes

- [ ] 6. Rename core/DSL `ArtifactRef` → `ArtifactDecl` to resolve collision with engine runtime `ArtifactRef`
  **What**: Two public exports share the name `ArtifactRef` across packages. Rename the core/DSL variant (DSL workflow step input/output declaration) to `ArtifactDecl`. The engine's runtime `ArtifactRef` (persisted record) keeps its name since it is the runtime concept. Document the convention in `docs/adapter-boundary.md`.
  **Files**:
  - `packages/core/src/schema.ts` — rename `ArtifactRefSchema` → `ArtifactDeclSchema` (line 129); update references inside `WorkflowStepSchema` (lines 161, 162); rename type export `ArtifactRef` → `ArtifactDecl` (line 260).
  - `packages/core/src/index.ts` — rename re-exports at lines 54 (`ArtifactRef`) and 74 (`ArtifactRefSchema`).
  - `packages/core/src/__tests__/schema.test.ts` — update any references.
  - `packages/core/src/__tests__/validate.test.ts` — update any references.
  - `packages/core/src/__tests__/parser.test.ts` — update any references.
  - `packages/core/src/__tests__/parse_config.test.ts` — update any references.
  - `docs/workflow-schema.md` — update type name in lines 39, 40, 161, 164.
  - `docs/adapter-boundary.md` — add short paragraph under a new "Naming conventions" subsection explaining: core/DSL types use `*Decl` suffix when they describe declarative configuration, engine runtime types use `*Ref` when they describe persisted handles.
  - VERIFY no engine source file imports `ArtifactRef` from `@weave/core` (it shouldn't — confirmed in research).
  **Acceptance**:
  - `grep -rn "ArtifactRef" packages/core/ --include="*.ts" | grep -v "/dist/"` returns zero hits.
  - `grep -rn "ArtifactRef" packages/engine/ --include="*.ts" | grep -v "/dist/"` returns only engine runtime references (unchanged).
  - `bun test` passes — all four schema test layers (schema, parser, validate, parse_config) still cover the workflow step input/output array.
  - `bun run typecheck` passes.
  - `bun run build` succeeds.
  **Pitfall**: This is a breaking change to the `@weave/core` public API. Since no external consumer exists today (pre-1.0, single-repo project), no deprecation alias is required. Note this in the commit body.
  **Commit**: `refactor(core)!: rename ArtifactRef → ArtifactDecl to disambiguate from engine runtime type`

- [ ] 7. Replace hardcoded `"shuttle"` literal in `compose.ts` with structural check
  **What**: `shouldExcludeSharedShuttleTarget` at `compose.ts:128-135` special-cases the literal builtin name `"shuttle"`, violating the DSL-first principle that builtin names are not engine-known. Replace with a structural rule based on the agent's `mode` field plus `name`-starts-with-`"shuttle-"` check.
  **Decision**: Pattern selects **Option C** from the brief — structural check based on `mode === "all"` (the shuttle root) plus absence of category prefix. Rationale: requires no schema change, no new DSL keyword, and matches the conceptual definition of "the shuttle root agent" (a top-level non-categorised generalist with `mode: all`). Options A and B would require schema field additions that ripple through validate/parser/parse_config tests for no behavioural gain.
  **Files**:
  - `packages/engine/src/compose.ts` — modify `shouldExcludeSharedShuttleTarget` to accept the full agent config of the *source* agent (not just the name). New rule: "exclude when target is a `shuttle-*` category shuttle AND source agent is either (a) a category shuttle itself, or (b) a root agent with `mode: all` AND no category prefix in its name". Update the call site in `buildDelegationTargets` (compose.ts:151) to pass the source agent's config alongside its name.
  - `packages/engine/src/__tests__/compose.test.ts` — extend existing tests at lines 400-431 with two additional cases:
    1. A user-defined agent named `loom-shuttle` with `mode: all` (not the literal name `"shuttle"`) should also be excluded from category shuttle delegation if it has no category prefix — proves the rule is structural, not name-based.
    2. A user-defined agent named `shuttle` but with `mode: primary` should NOT trigger the exclusion (mode-based, not name-based).
  **Acceptance**:
  - `grep -n "=== \"shuttle\"" packages/engine/src/compose.ts` returns zero hits.
  - Existing tests at compose.test.ts:400-431 still pass.
  - The two new tests pass.
  - `bun test` passes.
  - `bun run typecheck` passes.
  **Pitfall**: If existing tests break due to subtle structural-rule differences, prefer adjusting the rule to preserve existing behaviour over rewriting test expectations. The intent is identical user-facing behaviour with a cleaner internal implementation.
  **Commit**: `refactor(engine): replace hardcoded shuttle name with structural check in delegation exclusion`

- [ ] 8. Convert `packages/engine/src/env.ts` to `Result`-returning + Bun types
  **What**: `parseEnv()` currently throws on validation failure and uses `NodeJS.ProcessEnv`. Convert to `Result<Env, EnvValidationError>` and replace the type with `Record<string, string | undefined>` (project is Bun-only per AGENTS.md). The module-level `env` constant uses `.match()` to log-and-exit on failure, preserving the "crash early" semantics without throwing through `import`.
  **Files**:
  - `packages/engine/src/env.ts` — add typed `EnvValidationError` discriminated union (`{ type: "InvalidEnv", issues: { path: string; message: string }[] }`); change `parseEnv` signature to `(raw?: Record<string, string | undefined>): Result<Env, EnvValidationError>`; change body to `safeParse` → `ok`/`err`; change module-level `export const env` to call `parseEnv().match(env => env, err => { logger.fatal({ err }, "..."); process.exit(1); })` (or equivalent). Import `logger` from `./logger.js`.
  - `packages/engine/src/index.ts` — re-export `EnvValidationError` if it's part of the public surface.
  - CREATE `packages/engine/src/__tests__/env.test.ts` — three tests minimum: (a) valid env returns `ok(Env)` with default `info`; (b) invalid `LOG_LEVEL` returns `err({ type: "InvalidEnv", issues: [...] })` with non-empty issues; (c) default value applied when `LOG_LEVEL` is undefined.
  **Acceptance**:
  - `grep -n "NodeJS.ProcessEnv\|throw new Error" packages/engine/src/env.ts` returns zero hits.
  - `grep -n "Result\|ResultAsync" packages/engine/src/env.ts` returns at least one hit.
  - `bun test packages/engine/src/__tests__/env.test.ts` passes.
  - `bun test` passes (no other test should depend on `parseEnv` throwing).
  - `bun run typecheck` passes.
  **Pitfall**: Module-level `env` initialisation runs at import time. If it calls `process.exit(1)` on invalid env, test suites that import `@weave/engine` with a polluted env will crash. Mitigation: tests must not mutate `process.env.LOG_LEVEL` to invalid values; the test for failure paths must call `parseEnv({ LOG_LEVEL: "bogus" })` with an explicit argument, never via `process.env` mutation.
  **Commit**: `refactor(engine): convert env.ts to neverthrow + Bun-native env type`

- [ ] 9. Fix nested `try/catch` in `runtime.ts` with `Result.fromThrowable`
  **What**: Lines 385-397 of `packages/cli/src/commands/runtime.ts` have a nested `try { try { ... } finally { db.close() } } catch { ... }` block to read schema version from a possibly-missing database. Refactor with `Result.fromThrowable` so the inner cleanup-required block stays a single `try/finally` and the outer `catch` becomes a `Result` error path.
  **Files**:
  - `packages/cli/src/commands/runtime.ts` — replace lines 385-397. New pattern:
    1. Define a small helper (file-local) `readSchemaVersionFromDb(dbPath: string): Result<number, { type: "ReadFailed" }>` that uses `Result.fromThrowable` to wrap `new Database(...)`, `readSchemaVersion`, and explicit close-on-error.
    2. In the calling code, replace the nested try with `readSchemaVersionFromDb(dbPath).match(version => schemaVersion = version, () => { terminal.stderr(...); schemaVersion = CURRENT_SCHEMA_VERSION; })`.
  - VERIFY no other call site of `readSchemaVersion` is affected.
  **Acceptance**:
  - `grep -B2 -A20 "if (ctx.subcommand === \"status\")" packages/cli/src/commands/runtime.ts | grep -c "try {"` returns at most 1.
  - The CLI `weave runtime status` command behaves identically on a missing/corrupt DB (warning printed, `CURRENT_SCHEMA_VERSION` used).
  - `bun test` passes (including existing tests for `runRuntimeStatus`).
  - `bun run typecheck` passes.
  **Pitfall**: The original block uses a `finally` to guarantee `db.close()` runs on success. The replacement must preserve this — wrap the `readSchemaVersion(db)` call in a try/finally inside the helper, with `Result.fromThrowable` wrapping the whole thing.
  **Commit**: `refactor(cli): replace nested try/catch in runtime status with Result.fromThrowable`

### Tier 3 — Strategic / heavier scope

- [x] 10. ~~Implement minimal `@weave/adapter-opencode` skeleton~~ — **SUPERSEDED**
  **Status**: Owned by `.weave/plans/adapter-readiness.md` Tasks 8–19, which ship a **production-grade** `@weave/adapter-opencode` pinned against `@opencode-ai/sdk` types — far beyond the minimal no-op skeleton scoped here. Do NOT execute this task here — it would create a stub that adapter-readiness must immediately discard.

- [x] 11. ~~Reconcile `WeaveRunner.run()` vs `materializeAgents()` parallel paths~~ — **SUPERSEDED**
  **Status**: Owned by `.weave/plans/adapter-readiness.md` Tasks 5–7, which **delete `WeaveRunner` entirely** and migrate `materializeAgents` to partial-by-default (returns `{ agents, errors }`). The parallel paths cease to exist after that plan lands, making any reconciliation work here wasted effort. Do NOT execute this task here.

- [x] 12. ~~Resolve issue #9 — wire or explicitly defer lifecycle policy surface~~ — **SUPERSEDED**
  **Status**: Implicitly resolved by `.weave/plans/adapter-readiness.md`. Once `WeaveRunner` is deleted, the TODO(#9) comment at `runner.ts:141` vanishes with the file, and the lifecycle surface becomes the sole adapter-facing path by default — no wiring decision remains. Spec-13 "Consumers" documentation, if still warranted, can be added inside the adapter-readiness branch's doc tasks. Do NOT execute this task here.

### Tier 4 — Chores

- [ ] 13. Replace `Bun.spawnSync` filesystem ops with native `node:fs` calls
  **What**: `packages/engine/src/runtime/sqlite/store.ts` lines 1090, 1102, 1152-1154 shell out to `mkdir` and `chmod`. Replace with `node:fs/promises` calls. `node:fs` is allowed per AGENTS.md — it is one of the `node:` protocol modules Bun explicitly adopts. Wrap with `Result.fromThrowable` / `ResultAsync.fromPromise` per neverthrow discipline.
  **Files**:
  - `packages/engine/src/runtime/sqlite/store.ts`:
    - Line 1090 `Bun.spawnSync(["mkdir", "-p", dir])` → `await fs.mkdir(dir, { recursive: true })` wrapped with `ResultAsync.fromPromise` returning an `initializationError` on failure. Replace the `mkdirResult.exitCode` check with the Result branch.
    - Line 1102 `Bun.spawnSync(["chmod", "700", dir])` → `await fs.chmod(dir, 0o700).catch(() => undefined)` — preserve the existing best-effort semantics with a swallowed error (already best-effort in the original).
    - Lines 1152-1154 (three `chmod 600` calls) → three `await fs.chmod(path, 0o600).catch(() => undefined)` calls.
  - Import `fs` from `node:fs/promises` at the top of the file.
  - VERIFY no platform-specific behaviour change on macOS/Linux (the original `chmod` is Unix-only too; Windows is not supported by the runtime store today).
  **Acceptance**:
  - `grep -n "Bun.spawnSync" packages/engine/src/runtime/sqlite/store.ts` returns zero hits.
  - `grep -n "node:fs" packages/engine/src/runtime/sqlite/store.ts` returns at least one hit.
  - `bun test packages/engine/src/__tests__/` (the runtime persistence tests) passes.
  - `bun test` (root) passes.
  - `bun run typecheck` passes.
  **Pitfall**: `fs.chmod` rejects on Windows for some modes. Since the runtime store is currently macOS/Linux only, keep the `.catch(() => undefined)` swallow to preserve best-effort behaviour. Document in the commit body that cross-platform Windows support is a separate concern.
  **Commit**: `refactor(engine): replace shell-out fs ops in runtime store with node:fs/promises`

- [ ] 14. Sweep stale doc references
  **What**: After Tasks 2, 4, 5 land, several doc files reference deleted symbols. Sweep and update.
  **Files**:
  - `docs/specs/12-spec-runtime-persistence/12-proofs/12-task-01-proofs.md` — remove the `scripts/validate-config.ts` / `printSummary` reference at line 116; replace with a pointer to the CLI `validate` command.
  - `docs/adapter-boundary.md` — remove the "deprecated `loadSkill`/`registerHook` will be removed" paragraphs (now stale since Task 4 removed them).
  - `docs/specs/09-spec-adapter-provided-skill-resolution/` — same cleanup of `loadSkill` deprecation language; ensure forward references to `loadAvailableSkills` are the canonical guidance.
  - `docs/specs/13-spec-minimal-execution-lifecycle-surface/` — verify the "supersedes `registerHook`" language matches the post-removal state (descriptive past tense, not deprecation language).
  - Any other spec mentioning `BUILTIN_AGENT_NAMES` (none expected — verify with `grep -rn "BUILTIN_AGENT_NAMES" docs/`).
  **Acceptance**:
  - `grep -rn "printSummary\|validate-config.ts" docs/` returns zero hits except historical release notes (if any).
  - `grep -rn "deprecated.*loadSkill\|deprecated.*registerHook" docs/` returns zero hits.
  - `grep -rn "BUILTIN_AGENT_NAMES" docs/` returns zero hits.
  - Docs compile (no broken Markdown link warnings if a link checker is configured).
  **Pitfall**: Some docs may use `loadSkill` in historical context (e.g. ADRs explaining *why* it was deprecated). Preserve historical context; only update guidance/instructional text that would mislead future agents.
  **Commit**: `docs: sweep stale references after dead-code cleanup`

---

## Verification

- [ ] All tests pass: `bun test`
- [ ] Typecheck clean: `bun run typecheck`
- [ ] Build succeeds for all packages including new adapter: `bun run build`
- [ ] No regressions in CLI behaviour: manually run `bun run validate-config`, `bun packages/cli/src/main.ts validate --project`, `bun packages/cli/src/main.ts runtime status`.
- [ ] All Definition-of-Done grep checks return the expected zero/non-zero counts (see above).
- [ ] Each task lands as a single commit following Conventional Commits format (`refactor:`, `feat:`, `docs:`, `chore:`).
- [ ] Tasks 6, 8 carry the breaking-change marker (`!`) in their type since they alter public exports / module-level behaviour respectively.

### Review routing

- **Warp (security review)**: **Not required for any task.** None of the changes touch authentication, authorisation, secret material, tokens, crypto primitives, or signing logic. Task 13 touches `chmod` on runtime DB files (security-relevant *adjacent*, but preserves identical 0o700/0o600 permission bits — no behaviour change). Confirm with Warp anyway as a courtesy review for Task 13 if the project policy requires it.
- **Weft (code review)**: **Recommended for Tasks 6, 7, 8.** These are the design-touching changes most likely to affect downstream API consumers. (Tasks 4, 10, 11, 12 are superseded; their reviews belong to `adapter-readiness.md`.)
- **No review needed (mechanical)**: Tasks 1, 2, 3, 5, 9, 13, 14 — these are deletions or constrained refactors with clear acceptance grep checks.

### Checkpoint recommendations

Use `aft_safety checkpoint` before:
- **Task 6** (`refactor(core)!: rename ArtifactRef → ArtifactDecl`) — touches 8+ files including all four schema test layers. Worth a checkpoint to enable atomic rollback.
- **Task 13** (`refactor(engine): replace shell-out fs ops`) — touches the runtime store initialisation path; checkpoint before exercising the migration test suite.

(Tasks 4 and 10 had checkpoint recommendations in the original plan; both are now superseded.)

### Commit ordering rationale

The 10 active tasks (1, 2, 3, 5, 6, 7, 8, 9, 13, 14) are sequenced so that:
1. **Tier 1 active subset** (Tasks 1, 2, 3, 5) lands first — purely deletes orphan / un-exports / removes the `BUILTIN_AGENT_NAMES` constant. Safe.
2. **Tier 2** (Tasks 6–9) follows — design changes that are easier on a clean baseline.
3. **Tier 3** is fully superseded by `adapter-readiness.md` — no work here.
4. **Tier 4** (Tasks 13, 14) — Task 13 (fs ops) is independent; Task 14 (doc sweep) depends on Tasks 2 and 5 having landed plus the `adapter-readiness.md` `WeaveRunner`/deprecated-member removal having landed (so the "deprecated will be removed" prose can be deleted in a single pass).

**Coordination with `adapter-readiness.md`**: This plan's active tasks are mostly independent of the runner deletion. If both plans run in parallel, prefer landing Tier 1 (1, 2, 3, 5) and Tier 2 (6, 7, 8, 9) here while `adapter-readiness.md` works on the runner branch. Defer Task 14 until both branches have landed so the doc sweep is exhaustive.
