# Task 06 Proofs — Cleanup: Remove Legacy Types, Update Engine Consumers

## Task Summary

Task 6.0 removes the five legacy files that preceded the DSL pipeline (`agent.ts`, `config.ts`, `dsl.ts`, `hook.ts`, `skill.ts`), updates `engine/adapter.ts` to define `HookConfig` and `SkillConfig` locally (they are engine concerns, not part of the `.weave` DSL spec), and rewrites `engine/runner.ts` to consume the new `WeaveConfig` shape — using `disabled.agents` instead of a flat `disabled` array and `models?.[0]` instead of `model` for logging.

## What This Task Proves

- The five legacy `@weave/core` files are deleted; no file in the workspace imports them.
- `defineConfig()` and all legacy DSL exports are gone with zero references remaining.
- `engine/adapter.ts` imports only `AgentConfig` from `@weave/core`; `HookConfig` and `SkillConfig` are defined as local engine interfaces with TODO markers for future spec coverage.
- `engine/runner.ts` correctly uses the new `WeaveConfig` shape: `disabled.agents.includes(name)` for agent-disable checks, `agentConfig.models?.[0]` for model logging, and TODO comments for deferred hook/skill loading.
- The full workspace typechecks with zero errors after all deletions.
- All 85 tests pass after the cleanup.
- `grep` for legacy identifiers returns zero results.

## Evidence Summary

Three artifacts: legacy-reference grep (zero results), workspace typecheck, and full test suite.

---

## Artifact: No Legacy References — Zero Results

**What it proves:** No file in the workspace imports `defineConfig`, the old `dsl` module, or the deleted core files.
**Why it matters:** Stale imports to deleted files would cause runtime errors or silent type holes. Zero results confirms the cleanup is complete.

**Command:**
```bash
grep -r "defineConfig\|from.*['\"].*dsl['\"]" packages/ --include="*.ts"
```

**Result summary:** Exit code 1 (no matches) — zero references to legacy identifiers found across all packages.

```
(no output — exit code 1, meaning zero matches)
```

---

## Artifact: Full Workspace Typecheck — Zero Errors

**What it proves:** Deleting the five legacy files and updating both engine files leaves the workspace in a fully type-correct state. No consumers depended on the removed types in a way that would surface as a compile error.
**Why it matters:** This is the definitive verification that the cleanup is non-breaking. A single missed import or shape mismatch in the engine would surface here.

**Command:**
```bash
bun run typecheck
```

**Result summary:** All three workspace packages typecheck with exit code 0.

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

---

## Artifact: Full Workspace Test Suite — 85/85 Pass

**What it proves:** The engine changes (new `disabled.agents` shape, `models?.[0]`, removed hook/skill loops) do not break any existing tests. All pipeline tests and engine env tests continue to pass.
**Why it matters:** The runner's `run()` method touches `WeaveConfig` fields directly; if the shape update were wrong, the engine env test or a future runner test would catch it.

**Command:**
```bash
bun test --recursive
```

**Result summary:** 85 tests pass across 6 files in 36ms.

```
 85 pass
 0 fail
 253 expect() calls
Ran 85 tests across 6 files. [36.00ms]
```

---

## Reviewer Conclusion

Task 6.0 is complete. The five legacy core files are deleted. `engine/adapter.ts` and `engine/runner.ts` are updated to consume the new Zod-inferred `WeaveConfig` shape with no references to legacy types remaining. The full workspace typechecks cleanly and all 85 tests pass.
