# Task 03 Proofs - Documentation, adapter boundary, and full integration

## Task Summary

This task verifies the engine-to-adapter boundary stays harness-agnostic, documents category shuttle adapter translation, and runs full integration checks across the workspace.

## What This Task Proves

- `HarnessAdapter` still has no `getSelectedModel()`, `getAvailableModels()`, or equivalent engine-level UI query method.
- `docs/model-resolution.md` now explains how adapters should translate generated category shuttle model preferences.
- Workspace typecheck and all tests pass with the model-resolution helper and category shuttle generation in place.
- The requested pre-commit dry-run commands complete successfully.

## Evidence Summary

- A source search found no UI-query methods on `HarnessAdapter`; only the pure helper input field `uiSelectedModel` appears in model-resolution code and tests.
- `bun run lint` completed without errors, with only pre-existing warnings/infos in unrelated files.
- `bun run typecheck` passed across all packages.
- `bun test` and `bun test --recursive` both passed with 235 tests.
- `bun run validate-config` successfully parsed `.weave/config.weave`.

## Artifact: Adapter boundary verification

**What it proves:** The engine adapter interface was not expanded to query harness UI or model registry state.

**Why it matters:** The spec requires adapters to own harness UI state while Weave passes normalized intent only.

**Command:**

~~~bash
rg -n "getSelectedModel|getAvailableModels|SelectedModel|AvailableModels" packages/engine/src/adapter.ts packages/engine/src
~~~

**Result summary:** No matching UI-query method exists in `adapter.ts`. Matches are limited to explicit helper input naming and tests.

~~~text
packages/engine/src/model-resolution.ts:22:  uiSelectedModel?: string;
packages/engine/src/model-resolution.ts:57:  if (input.uiSelectedModel !== undefined && input.agentMode !== "subagent") {
packages/engine/src/model-resolution.ts:58:    return { model: input.uiSelectedModel, source: "ui-selected" };
packages/engine/src/__tests__/model-resolution.test.ts:16:        uiSelectedModel: "ui-model",
...
~~~

## Artifact: Documentation update

**What it proves:** The adapter guidance now describes category shuttle model translation and shows a concrete helper call.

**Why it matters:** Future adapter authors need to understand that generated category shuttle `models` are intent, not engine-resolved concrete models.

**Artifact path:** `docs/model-resolution.md`

**Result summary:** A new `Category Shuttles and Adapter Translation` section explains that generated `shuttle-{categoryName}` descriptors carry category preferences, subagent mode skips UI-selected models, and adapters may pass `categoryModels` into `resolveAdapterModelIntent()`.

## Artifact: Repository lint gate

**What it proves:** The final source changes do not introduce Biome lint errors.

**Why it matters:** Lint is part of the repository quality gate and pre-commit workflow.

**Command:**

~~~bash
bun run lint
~~~

**Result summary:** Biome completed without errors. The reported warnings/infos are pre-existing and outside the new engine files.

~~~text
$ biome lint packages/
Checked 66 files in 43ms. No fixes applied.
Found 2 warnings.
Found 4 infos.
~~~

## Artifact: Workspace typecheck

**What it proves:** The public exports, helper types, descriptor API, runner integration, and documentation-adjacent task updates do not break TypeScript compilation.

**Why it matters:** The implementation spans package boundaries, so full workspace typechecking is required.

**Command:**

~~~bash
bun run typecheck
~~~

**Result summary:** TypeScript completed with zero errors for all packages.

~~~text
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
~~~

## Artifact: Full test suite

**What it proves:** The complete repository test suite passes with no regressions after adding model-resolution and category-shuttle behavior.

**Why it matters:** Spec validation depends on all affected and unaffected packages remaining green.

**Command:**

~~~bash
bun test
~~~

**Result summary:** All 235 tests passed across scripts, core, config, and engine.

~~~text
235 pass
0 fail
623 expect() calls
Ran 235 tests across 16 files.
~~~

## Artifact: Pre-commit dry-run commands

**What it proves:** The requested pre-commit-equivalent checks completed successfully before the final task commit.

**Why it matters:** This mirrors the repository's pre-commit gate and catches integration issues before history is finalized.

**Command:**

~~~bash
git add docs/model-resolution.md docs/specs/04-spec-agent-model-resolution/04-tasks-agent-model-resolution.md && \
  bunx lint-staged && \
  bun run typecheck && \
  bun run validate-config && \
  bun test --recursive
~~~

**Result summary:** `lint-staged` had no matching staged TS/JS/JSON files in this documentation-only task state; typecheck, config validation, and recursive tests all passed.

~~~text
→ lint-staged could not find any staged files matching configured tasks.
@weave/core typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
✓ .weave/config.weave
235 pass
0 fail
623 expect() calls
Ran 235 tests across 16 files.
~~~

## Reviewer Conclusion

The adapter boundary remains harness-agnostic, category shuttle adapter translation is documented, and the full workspace validation suite passes with the completed implementation.
