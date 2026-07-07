# Task 4 Proof Artifact — Model and Skill Validation

**Task**: 4.0 Add model and skill validation to the materialization pipeline  
**Spec**: 20-spec-opencode-adapter-materialization  
**Date**: 2026-05-26

---

## Summary

Task 4 replaces the `descriptor.models[0]` shortcut in `translate-agent.ts` with
validated model resolution via `resolveAdapterModelIntent()`, implements
harness-injection-based `loadAvailableSkills()` (no filesystem scanning), and
preserves hard-error semantics for missing declared skills. All six subtasks are
complete.

### Architecture correction (Task 4 retry)

The original Task 4 implementation violated the adapter/harness boundary by
scanning the filesystem for skill files in `.weave/skills/` and `.agents/skills/`
directories. The correct architecture is:

- **Harness-owned**: which skills exist, where their files live, how they are
  loaded and mounted. The OpenCode SDK/runtime provides this information.
- **Adapter-owned**: receiving the harness-provided `SkillInfo[]` list (injected
  via `OpenCodeAdapterOptions.availableSkills`), forwarding it to the engine via
  `loadAvailableSkills()`, and validating declared skill names against it.
- **Engine-owned**: matching declared skill names against `SkillInfo.name` values
  and emitting `MissingSkill` errors for unresolved names.

`skill-discovery.ts` was rewritten to remove all filesystem scanning. It now
provides only `buildSkillInfoList()` (wraps harness-provided names as
`SkillInfo[]`) and `validateDeclaredSkills()` (validates declared names against
the harness-provided list). The `OpenCodeAdapter` stores the injected skill list
and returns it from `loadAvailableSkills()` without any filesystem access.

---

## Subtask Completion

| Subtask | Description | Status |
|---------|-------------|--------|
| 4.1 | Create `model-resolution.ts` | ✅ |
| 4.2 | Replace `descriptor.models[0]` shortcut | ✅ |
| 4.3 | Fail fast on unsupported explicit subagent model | ✅ |
| 4.4 | Create `skill-discovery.ts` with harness-injection-based `SkillInfo[]` | ✅ |
| 4.5 | Surface missing declared skills as hard errors | ✅ |
| 4.6 | Add model-resolution, skill-discovery, translate-agent tests | ✅ |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/adapters/opencode/src/model-resolution.ts` | **New** — `resolveModelForAgent()` wraps `resolveAdapterModelIntent()` with OpenCode model context; fail-fast rule for explicit subagent models |
| `packages/adapters/opencode/src/skill-discovery.ts` | **Rewritten** — removed filesystem scanning; now provides `buildSkillInfoList()` (wraps harness names as `SkillInfo[]`) and `validateDeclaredSkills()` (validates declared names against harness-provided list); no `discoverSkills()` |
| `packages/adapters/opencode/src/translate-agent.ts` | **Updated** — `translateAgent()` now accepts `resolvedModel?: string` parameter; no longer uses `descriptor.models[0]` as fallback |
| `packages/adapters/opencode/src/index.ts` | **Updated** — `spawnSubagent()` calls `resolveModelForAgent()` before `translateAgent()`; `loadAvailableSkills()` returns harness-injected skills (no filesystem scanning); new `availableSkills` constructor option; `harnessSkills` private field; removed `discoverSkills` re-export |
| `packages/adapters/opencode/src/__tests__/model-resolution.test.ts` | **New** — 23 tests covering constant fallback, agent preference, system default, UI-selected, fail-fast rule |
| `packages/adapters/opencode/src/__tests__/skill-discovery.test.ts` | **Rewritten** — 24 tests covering `buildSkillInfoList`, `validateDeclaredSkills`, harness-injection semantics, hard-error behavior; no filesystem tests |
| `packages/adapters/opencode/src/__tests__/translate-agent.test.ts` | **New** — 17 tests covering `resolvedModel` parameter, no `descriptor.models[0]` fallback, full round-trip |
| `packages/adapters/opencode/src/__tests__/adapter.test.ts` | **Updated** — Added 5 model-resolution tests; replaced single `loadAvailableSkills` test with 6 harness-injection tests proving no filesystem scanning |

---

## Test Evidence

### model-resolution.test.ts

```
bun test packages/adapters/opencode/src/__tests__/model-resolution.test.ts

bun test v1.3.13 (bf2e2cec)
 23 pass
 0 fail
 46 expect() calls
Ran 23 tests across 1 file. [53.00ms]
```

**Key cases covered:**
- Constant fallback when no models declared and no context
- Agent preference: first available model in declared list
- System default when no models declared
- UI-selected model for primary/all mode (ignored for subagent)
- **Fail-fast**: `ModelNotAvailableError` when subagent declares unavailable model
- No fail-fast when `availableModels` is undefined
- No fail-fast for primary/all mode agents
- No fail-fast when subagent has no declared models
- Success when subagent declares a model that IS available

### skill-discovery.test.ts

```
bun test packages/adapters/opencode/src/__tests__/skill-discovery.test.ts

bun test v1.3.13 (bf2e2cec)
 24 pass
 0 fail
 39 expect() calls
Ran 24 tests across 1 file. [12.00ms]
```

**Key cases covered:**
- `buildSkillInfoList`: empty input, correct names, order preservation, harness-provided names
- `validateDeclaredSkills`: ok when all present, err with missing names, disabled skills silently skipped
- **Hard-error semantics**: missing declared skill → `err(string[])` not silent skip
- Hard error when harness provides no skills but agent declares some
- Harness-provided `SkillInfo` with metadata passes through name matching
- **No filesystem tests** — discovery is harness-owned, not adapter-owned

### translate-agent.test.ts

```
bun test packages/adapters/opencode/src/__tests__/translate-agent.test.ts

bun test v1.3.13 (bf2e2cec)
 17 pass
 0 fail
 42 expect() calls
Ran 17 tests across 1 file. [7.00ms]
```

**Key cases covered:**
- `resolvedModel` parameter is used when provided
- Model field omitted when `resolvedModel` is `undefined`
- **Does NOT use `descriptor.models[0]` as fallback** (explicit regression test)
- `resolvedModel` overrides any models in `descriptor.models`
- Full descriptor round-trip with all fields

### adapter.test.ts (updated)

```
bun test packages/adapters/opencode/src/__tests__/adapter.test.ts

bun test v1.3.13 (bf2e2cec)
 40 pass
 0 fail
 81 expect() calls
Ran 40 tests across 1 file. [73.00ms]
```

**New model-resolution cases:**
- Uses resolved model from `modelContext` when available
- **Throws `ModelNotAvailableError`** when subagent declares unsupported model
- Does not call `createAgent()` when model resolution fails
- Succeeds when no `modelContext` provided (falls back to constant fallback)
- Succeeds for primary mode agent with unavailable model (no fail-fast)

**New `loadAvailableSkills()` harness-injection cases:**
- Returns empty array when no skills are injected (no filesystem scanning)
- Returns the injected harness-provided skill list
- Returns injected skills with metadata intact
- Returns the same list on repeated calls (no filesystem side effects)
- Does not scan the filesystem — returns empty list for non-existent project root
- Two adapters with different injected skills are independent

### Full adapter test suite

```
bun test packages/adapters/opencode/src/__tests__/

bun test v1.3.13 (bf2e2cec)
 154 pass
 0 fail
 315 expect() calls
Ran 154 tests across 6 files. [58.00ms]
```

---

## Typecheck

```
bun run typecheck

$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

All packages pass typecheck with exit code 0.

---

## Design Decisions

### Fail-fast rule scope

The fail-fast rule for unsupported explicit model intent applies **only** to
`subagent` mode agents with non-empty `models` declarations. Primary and `all`
mode agents fall through to the engine's standard resolution chain (which may
select a different available model or the constant fallback). This matches the
spec requirement: "fail materialization when explicit subagent model intent
cannot be satisfied."

### `resolvedModel` parameter on `translateAgent`

`translateAgent` now accepts an optional `resolvedModel?: string` parameter
instead of reading `descriptor.models[0]`. When `undefined`, the model field is
omitted from the output config (OpenCode uses its own default). This keeps
translation pure and model resolution adapter-owned.

### Harness-injection for skill availability

Skill discovery is harness-owned. The OpenCode harness (SDK/runtime) knows which
skills are available; the adapter's role is to receive that list and forward it
to the engine. `OpenCodeAdapterOptions.availableSkills` is the injection point.
`loadAvailableSkills()` returns the injected list without any filesystem access.

When no skills are injected, `loadAvailableSkills()` returns `[]`. The engine's
`resolveSkillsForAgent()` will then emit `MissingSkill` errors for any declared
skills — this is the correct hard-error behavior (no silent skips).

### `skill-discovery.ts` scope after correction

After the boundary correction, `skill-discovery.ts` contains only:
- `buildSkillInfoList(names: string[]): SkillInfo[]` — wraps harness-provided
  skill names as `SkillInfo[]` entries for the engine.
- `validateDeclaredSkills(...)` — validates declared skill names against the
  harness-provided list; returns `err(string[])` for missing skills.

The module no longer exports `discoverSkills()` or `SkillDiscoveryError`. The
`index.ts` re-exports were updated accordingly.

---

## Acceptance Criteria Verification

| Criterion | Met? | Evidence |
|-----------|------|----------|
| Skill discovery is no longer adapter-owned filesystem scanning | ✅ | `skill-discovery.ts` has no filesystem I/O; `discoverSkills()` removed |
| Adapter consumes harness-provided/injected skill info | ✅ | `OpenCodeAdapterOptions.availableSkills` + `harnessSkills` field + `loadAvailableSkills()` returns injected list |
| Missing declared skills remain hard errors | ✅ | `validateDeclaredSkills()` returns `err(string[])`; engine's `resolveSkillsForAgent()` emits `MissingSkill` |
| No silent skip behavior introduced | ✅ | Empty injected list → empty `loadAvailableSkills()` → engine hard-errors on declared skills |
| Model-resolution behavior intact | ✅ | 23 model-resolution tests pass; 17 translate-agent tests pass |
| `bun test skill-discovery.test.ts` passes | ✅ | 24/24 pass |
| `bun test adapter.test.ts` passes | ✅ | 40/40 pass |
| `bun test model-resolution.test.ts` passes | ✅ | 23/23 pass |
| `bun test translate-agent.test.ts` passes | ✅ | 17/17 pass |
| Full adapter suite passes | ✅ | 154/154 pass |
| Typecheck passes | ✅ | All 5 packages exit code 0 |
| Proof file updated | ✅ | This file |
