# Spec 21 Validation Report — CLI Legacy Config Migration

**Spec**: `docs/specs/21-spec-cli-legacy-config-migration/21-spec-cli-legacy-config-migration.md`  
**Task list**: `docs/specs/21-spec-cli-legacy-config-migration/21-tasks-cli-legacy-config-migration.md`  
**Validator**: Shuttle (claude-sonnet-4-6)  
**Validation date**: 2026-05-27  
**Overall verdict**: ✅ **PASS**

---

## 1. Executive Summary

Spec 21 adds a legacy-config migration path to the Weave CLI, allowing users to convert legacy `weave-opencode.jsonc` OpenCode config into the current `.weave` DSL via `weave init migrate` or through automatic discovery in ordinary `weave init`. All five parent tasks are complete and marked `[x]` in the task list.

Independent validation confirms:

- All 187 targeted migration tests pass (0 failures) across 3 test files.
- Full suite: **2057 pass, 0 fail** across 54 files.
- All packages typecheck clean (exit code 0).
- All packages build clean (exit code 0).
- Lint: 0 errors (98 pre-existing warnings, 52 infos — none introduced by this spec).
- All 8 spec-21 commits are present and traceable to spec requirements.
- All 5 proof artifact files exist and contain substantive evidence.
- No real secrets, tokens, or private paths appear in any proof artifact.
- All functional requirements are covered by tests and proof artifacts.
- Repository standards (neverthrow, Bun-only, no console.\*, mocked tests, docs updated) are followed.

**Implementation Ready**: **Yes** — all functional requirements are verified, all proof artifacts are accessible, all required quality gates pass, and no blocking validation issues were found.

**Gate summary**:

| Gate | Result |
|------|--------|
| A — No CRITICAL/HIGH issues | ✅ PASS |
| B — No Unknown entries in Functional Requirements matrix | ✅ PASS |
| C — All proof artifacts accessible and functional | ✅ PASS |
| D1 — No unmapped out-of-scope core/source changes | ✅ PASS |
| D2/D3 — Supporting files have clear linkage | ✅ PASS |
| E — Implementation follows repo standards | ✅ PASS |
| F — No real secrets in proof artifacts | ✅ PASS |

---

## 2. Coverage Matrix

### 2.1 Functional Requirements

| # | Requirement (from spec) | Unit | Status | Evidence |
|---|------------------------|------|--------|----------|
| FR-1 | System shall support explicit migration entry path `weave init migrate` | 1 | ✅ OK | `args.ts` `initSubmode?: "migrate"`; `cli.ts` routes to `renderMigrateHelp()`; `runMigrateMode()` in `init.ts`; 9 explicit-migrate tests in `init.test.ts` |
| FR-2 | Ordinary `weave init` shall offer migration when matching legacy source exists | 1 | ✅ OK | `createPlan()` checks legacy source after scope resolution; 5 ordinary-init migration tests + 5 `--scope` flag tests in `init.test.ts` |
| FR-3 | Migration shall be scope-aware: global reads `~/.config/opencode/weave-opencode.jsonc`, local reads `./.opencode/weave-opencode.jsonc` | 1 | ✅ OK | `detectLegacySource()` in `init.ts`; global/local scope tests in `init.test.ts` and `migrate.test.ts` |
| FR-4 | Migration shall write to canonical targets `~/.weave/config.weave` and `./.weave/config.weave` | 1 | ✅ OK | `buildMigrationPlan()` uses `CANONICAL_WEAVE_DIR` constants; `--install-dir` ignored test in `init.test.ts` |
| FR-5 | Migration shall continue into normal harness selection/configuration flow after successful write | 1 | ✅ OK | `continueAfterMigration()` called from `runMigrateMode()`; 3 harness-flow continuation tests in `init.test.ts` |
| FR-6 | System shall show interactive preflight summary (source, destination, dest-exists, backup intent, skipped-field count) | 2 | ✅ OK | `renderMigratePreflight()` in `init.ts`; 5 preflight tests in `migrate.test.ts`; CLI capture in task-02-proofs.md |
| FR-7 | System shall validate generated DSL through normal parse/validation pipeline before mutating any files | 2 | ✅ OK | `writeMigratedDsl()` calls `parseConfig()` before any write; 9 validation-before-write tests in `migrate.test.ts` covering syntax-invalid and schema-invalid cases |
| FR-8 | System shall write exactly one `.bak` backup at `<target>.bak` before overwriting existing destination | 2 | ✅ OK | `writeMigratedDsl()` backup logic; 6 overwrite-backup tests in `migrate.test.ts` |
| FR-9 | System shall keep legacy JSONC source file in place after successful migration | 2 | ✅ OK | No rename/delete in `performMigrationWrite()`; 3 source-preservation tests in `migrate.test.ts` |
| FR-10 | System shall prepend provenance comment to generated `config.weave` | 2 | ✅ OK | `buildMigratedContent()` prepends 4-line comment block; 5 provenance-comment tests in `migrate.test.ts` |
| FR-11 | System shall ignore arbitrary source-file JSONC comments | 2 | ✅ OK | `stripJsoncComments()` in `init.ts`; 3 JSONC comment-stripping tests in `migrate-conversion.test.ts` |
| FR-12 | Non-interactive `--yes` mode shall proceed without prompts including overwrite-with-backup | 2 | ✅ OK | `--yes` path in `runMigrateMode()`; 6 non-interactive `--yes` tests in `migrate.test.ts` |
| FR-13 | System shall use best-effort partial conversion — write destination even when some fields are skipped | 3 | ✅ OK | `convertLegacyJsonc()` returns `{ dsl, warnings }`; 7 best-effort partial-success tests in `migrate-conversion.test.ts` |
| FR-14 | System shall print warning summary enumerating each skipped/unmappable field | 3 | ✅ OK | `renderConversionWarnings()` in `init.ts`; 5 unsupported-section warning tests; CLI capture in task-03-proofs.md |
| FR-15 | System shall exit with code `0` when migration writes successfully but emits warnings | 3 | ✅ OK | Exit-code assertions in `migrate-conversion.test.ts` (8 tests in `runInit migration — unsupported sections warn but file is written`) |
| FR-16 | System shall map `disabled_agents`, `disabled_hooks`, `disabled_skills` to current `disable` declarations | 3 | ✅ OK | `convertLegacyJsonc()` handlers; 10 supported-field-mapping tests in `migrate-conversion.test.ts` |
| FR-17 | System shall map `log_level` to `settings { log_level ... }` | 3 | ✅ OK | `log_level` handler in `convertLegacyJsonc()`; 4 log_level tests in `migrate-conversion.test.ts` |
| FR-18 | System shall warn and skip `workflows`, `continuation`, `analytics`, `background` in v1 | 3 | ✅ OK | `UNSUPPORTED_LEGACY_FIELDS` constant; 5 unsupported-section tests in `migrate-conversion.test.ts` |
| FR-19 | System shall treat legacy `agents` entries as overrides of existing builtin agent names only | 4 | ✅ OK | `BUILTIN_AGENT_NAMES.has()` check in `convertLegacyJsonc()`; 11 builtin-override tests (including 5 retry tests for non-builtin rejection) |
| FR-20 | System shall convert legacy `custom_agents` into new `agent <name>` blocks | 4 | ✅ OK | `convertLegacyCustomAgent()` in `init.ts`; 7 custom-agent tests in `migrate-conversion.test.ts` |
| FR-21 | System shall warn when `custom_agents` name collides with builtin agent name | 4 | ✅ OK | `BUILTIN_AGENT_NAMES.has()` collision check; 4 collision-warning tests in `migrate-conversion.test.ts` |
| FR-22 | System shall convert `model` + optional `fallback_models` into ordered `models [...]` list | 4 | ✅ OK | `convertLegacyModels()` in `init.ts`; 7 model-conversion tests in `migrate-conversion.test.ts` |
| FR-23 | System shall convert legacy `categories` into current `category <name>` blocks | 4 | ✅ OK | `convertLegacyCategory()` in `init.ts`; 7 category-block tests in `migrate-conversion.test.ts` |
| FR-24 | System shall map only clearly known legacy tool names to abstract `tool_policy` buckets; warn on ambiguous | 4 | ✅ OK | `LEGACY_TOOL_TO_CAPABILITY` and `AMBIGUOUS_LEGACY_TOOLS` constants; 10 tool-policy tests in `migrate-conversion.test.ts` |
| FR-25 | System shall preserve `prompt_file` only when path can be safely translated to `.weave/prompts/` convention | 4 | ✅ OK | `isPromptFileSafe()` in `init.ts`; 3 safe + 5 unsafe prompt-file tests in `migrate-conversion.test.ts` |
| FR-26 | System shall warn and skip unsafe `prompt_file` references | 4 | ✅ OK | Warning path in `convertLegacyPromptFile()`; 5 unsafe-path tests including directory separator, absolute path, parent traversal |

### 2.2 Repository Standards

| Standard | Requirement | Status | Evidence |
|----------|-------------|--------|----------|
| Bun-only runtime | No Node.js APIs except `node:path`, `node:os` | ✅ OK | `init.ts` imports only `node:path` (allowed); no `fs`, `child_process`, `@types/node` |
| neverthrow | All fallible internal logic returns `Result`/`ResultAsync` | ✅ OK | `writeMigratedDsl()`, `runMigrateMode()`, `performMigrationWrite()` all use `ResultAsync`; single `try/catch` at JSON.parse boundary is a legitimate framework boundary (JSON.parse throws) |
| No console.\* | All output via logger or terminal IO | ✅ OK | `grep console. init.ts` returns 0 results |
| Mocked tests | No real filesystem, harness processes, or real home directories | ✅ OK | All 3 test files use `MemoryFileSystem` and `StaticPromptAdapter`; confirmed by file headers and grep |
| Docs updated in same changeset | Non-trivial behavior changes require doc updates | ✅ OK | `docs/cli.md` and `docs/config-loading.md` updated in commit `8157f8b` |
| Conventional commits | Commit messages follow `<type>(<scope>): <summary>` | ✅ OK | All 8 commits use `feat(cli):`, `fix(cli):`, `test(cli):`, `docs(cli):` prefixes |
| Early returns | Guard at top, happy path unindented | ✅ OK | `convertLegacyJsonc()` and helper functions use early-return guards |
| No nested try/catch | Single error boundary per block | ✅ OK | Only one `try/catch` in `init.ts` (JSON.parse boundary); no nesting |

### 2.3 Proof Artifacts

| Artifact | Path | Accessible | Functional |
|----------|------|-----------|-----------|
| Task 1 proof file | `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-01-proofs.md` | ✅ | ✅ Contains CLI capture, test output (40/40 pass), acceptance criteria table |
| Task 2 proof file | `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-02-proofs.md` | ✅ | ✅ Contains preflight CLI capture, file artifact samples, validation-gate evidence table, test output (39/39 pass) |
| Task 3 proof file | `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-03-proofs.md` | ✅ | ✅ Contains supported-fields fixture output, warning summary CLI capture, conversion behavior table, test output (48/48 pass) |
| Task 4 proof file | `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-04-proofs.md` | ✅ | ✅ Contains agent/category fixture DSL, warning capture for collision+ambiguous tool+unsafe prompt, test output (108/108 pass) |
| Task 5 proof file | `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-05-proofs.md` | ✅ | ✅ Contains doc change summary, sanitized smoke notes (local/global/overwrite/warning scenarios), full quality gate output |
| `docs/cli.md` migration section | `docs/cli.md` (lines 99–246) | ✅ | ✅ Covers all required topics: entry paths, scope sources, canonical destinations, `--install-dir` behavior, preflight, safety, `--yes`, warnings, field table, agent namespace rules, prompt-file translation, post-migration flow |
| `docs/config-loading.md` migration subsections | `docs/config-loading.md` | ✅ | ✅ Two new subsections: "Migration and canonical destinations" and "Migration and prompt-file translation" with cross-links |
| `init.test.ts` | `packages/cli/src/commands/__tests__/init.test.ts` | ✅ | ✅ 40 tests pass (independently verified: `bun test init.test.ts`) |
| `migrate.test.ts` | `packages/cli/src/commands/__tests__/migrate.test.ts` | ✅ | ✅ 39 tests pass (independently verified) |
| `migrate-conversion.test.ts` | `packages/cli/src/commands/__tests__/migrate-conversion.test.ts` | ✅ | ✅ 108 tests pass (independently verified) |
| Quality gate command | `bun run lint && bun run typecheck && bun test [...] && bun run build` | ✅ | ✅ All pass; lint 0 errors; typecheck exit 0 all packages; build exit 0 all packages |

---

## 3. Validation Issues

No CRITICAL or HIGH issues found.

| # | Severity | Gate | Description | Resolution |
|---|----------|------|-------------|------------|
| 1 | MEDIUM | D2 | `.codesight/` files (`CODESIGHT.md`, `graph.md`, `coverage.md`, `libs.md`, `middleware.md`) are modified across multiple commits but are not listed in the task file's Relevant Files table. | These are auto-maintained project-graph files updated as a side effect of code changes. They have clear implicit linkage (they track the codebase graph and are updated whenever source files change). No functional requirement or test is affected. Classified as D2 supporting files with implicit linkage — not a blocker. |
| 2 | MEDIUM | E | The single `try/catch` in `convertLegacyJsonc()` (line 636) wraps `JSON.parse()` — a third-party API that throws. This is the correct pattern per repo rules (`Result.fromThrowable` is preferred, but `try/catch` at a framework boundary is explicitly allowed). The implementation is correct but could be refactored to `Result.fromThrowable` for consistency. | Not a blocker. The current form is within the repo's stated exception for framework boundaries. |
| 3 | OK | — | Lint reports 98 warnings and 52 infos. | All pre-existing; confirmed by task-05-proofs.md and independently verified. Zero errors. No new warnings introduced by Spec 21. |

**GATE A**: No CRITICAL or HIGH issues → **PASS**

---

## 4. Evidence Appendix

### A. Independent test run (validator-executed)

```
$ bun test packages/cli/src/commands/__tests__/init.test.ts \
           packages/cli/src/commands/__tests__/migrate.test.ts \
           packages/cli/src/commands/__tests__/migrate-conversion.test.ts

bun test v1.3.13 (bf2e2cec)
 187 pass
 0 fail
 501 expect() calls
Ran 187 tests across 3 files. [24.24s]
```

### B. Full suite (validator-executed)

```
$ bun test

 2057 pass
 0 fail
 5566 expect() calls
Ran 2057 tests across 54 files. [26.01s]
```

### C. Typecheck (validator-executed)

```
$ bun run typecheck

@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
@weave/cli typecheck: Exited with code 0
```

### D. Build (validator-executed)

```
$ bun run build

@weave/core build: Exited with code 0
@weave/engine build: Exited with code 0
@weave/config build: Exited with code 0
@weave/cli build: Exited with code 0
@weave/adapter-opencode build: Exited with code 0
```

### E. Lint (validator-executed)

```
$ bun run lint

Checked 132 files in 45ms. No fixes applied.
Found 98 warnings.
Found 52 infos.
(0 errors)
```

### F. Commit traceability

| Commit | Type | Scope | Spec 21 task |
|--------|------|-------|--------------|
| `7d9c762` | feat | cli | Task 1.0 — migration-aware `weave init` entry paths |
| `49c9fd9` | fix | cli | Task 1.0 retry — `--scope` flag reaches migration discovery; harness flow continuation |
| `e453de3` | feat | cli | Task 2.0 — migration preflight, validation-before-write, write-path tests |
| `4c3dad4` | test | cli | Task 2.0 supplement — direct `writeMigratedDsl` validation-gate coverage |
| `5a23060` | feat | cli | Task 3.0 — best-effort JSONC conversion for top-level settings |
| `233dc46` | feat | cli | Task 4.0 — agents, categories, models, tools, prompt_file conversion |
| `3947739` | fix | cli | Task 4.0 retry — enforce builtin-only semantics for `agents` overrides |
| `8157f8b` | docs | cli | Task 5.0 — document `weave init migrate`, prove end-to-end acceptance |

### G. Changed files classification

| File | Classification | Requirement/Task linkage |
|------|---------------|--------------------------|
| `packages/cli/src/args.ts` | Core source | Task 1.1 — `initSubmode?: "migrate"` |
| `packages/cli/src/cli.ts` | Core source | Task 1.2 — `renderMigrateHelp()`, migrate routing |
| `packages/cli/src/commands/init.ts` | Core source | Tasks 1.3–1.6, 2.1–2.7, 3.1–3.5, 4.1–4.8 |
| `packages/cli/src/commands/__tests__/init.test.ts` | Test | Tasks 1.7, 2.8 |
| `packages/cli/src/commands/__tests__/migrate.test.ts` | Test | Task 2.8 |
| `packages/cli/src/commands/__tests__/migrate-conversion.test.ts` | Test | Tasks 3.6, 4.9 |
| `docs/cli.md` | Documentation | Task 5.1 |
| `docs/config-loading.md` | Documentation | Task 5.2, 5.3 |
| `docs/specs/21-spec-cli-legacy-config-migration/21-tasks-cli-legacy-config-migration.md` | Spec/task tracking | Task status updates |
| `docs/specs/21-spec-cli-legacy-config-migration/21-proofs/21-task-0{1-5}-proofs.md` | Proof artifacts | Tasks 1.0–5.0 proof requirements |
| `.codesight/CODESIGHT.md` | Supporting (D2) | Auto-maintained project graph; implicit linkage to source changes |
| `.codesight/graph.md` | Supporting (D2) | Auto-maintained project graph |
| `.codesight/coverage.md` | Supporting (D2) | Auto-maintained coverage tracking |
| `.codesight/libs.md` | Supporting (D2) | Auto-maintained library tracking |
| `.codesight/middleware.md` | Supporting (D2) | Auto-maintained middleware tracking |

### H. Security check

- No real user paths (e.g. `/Users/jose`) found in any proof artifact.
- All proof artifacts use fixture paths (`/tmp/weave-fixture-project`, `/tmp/weave-fixture-home`).
- No tokens, API keys, passwords, or private harness config content found in any proof artifact.
- `grep -rn "real.*secret|token|password|api_key|API_KEY"` across proof directory: 0 matches (only the phrase "no real user paths, tokens, secrets" in the sanitization disclaimer).

### I. Task completion status

All 5 parent tasks and all 37 subtasks are marked `[x]` complete in `21-tasks-cli-legacy-config-migration.md`.

| Task | Subtasks | Status |
|------|----------|--------|
| 1.0 Add migration-aware `weave init` entry paths | 1.1–1.7 (7) | ✅ All `[x]` |
| 2.0 Implement safe migration planning, preflight, and write behavior | 2.1–2.8 (8) | ✅ All `[x]` |
| 3.0 Convert top-level legacy settings with warning-visible best effort | 3.1–3.6 (6) | ✅ All `[x]` |
| 4.0 Convert legacy agent, category, model, tool, and prompt intent | 4.1–4.9 (9) | ✅ All `[x]` |
| 5.0 Document migration usage and prove end-to-end acceptance | 5.1–5.5 (5) | ✅ All `[x]` |

---

**Validation Completed:** 2026-05-27 23:59 UTC  
**Validation Performed By:** openai/gpt-5.4 (delegated validation analysis executed via Shuttle / claude-sonnet-4-6)
