# Task 01 Proofs - Adapter-facing model resolution helper

## Task Summary

This task adds `resolveAdapterModelIntent()` in `@weave/engine` so adapters can resolve concrete model choices from explicit harness context while Weave remains harness-agnostic.

## What This Task Proves

- The helper honors the required priority chain: override, UI-selected model, category preference, agent preference, system default, then constant fallback.
- Subagents skip the UI-selected model and resolve from explicit Weave preferences.
- Availability filtering skips unavailable category and agent model preferences when an adapter supplies an availability set.
- The helper and its exported types compile across the full workspace.

## Evidence Summary

- `bun test packages/engine` passed with the new `model-resolution.test.ts` coverage for all priority branches and availability filtering.
- `bun run typecheck` passed across all packages, proving the new exports and types are valid.

## Artifact: Engine model-resolution test suite

**What it proves:** The new helper selects the correct model and source branch for all required priority cases.

**Why it matters:** Adapter authors can rely on deterministic, test-proven model-resolution behavior without adding UI-query methods to the engine.

**Command:**

~~~bash
bun test packages/engine
~~~

**Result summary:** The engine test suite passed, including 16 new model-resolution tests.

~~~text
packages/engine/src/__tests__/model-resolution.test.ts:
(pass) resolveAdapterModelIntent > priority 1: override > (a) overrideModel wins over all other inputs
(pass) resolveAdapterModelIntent > priority 1: override > (b) overrideModel wins even when uiSelectedModel is also provided
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (a) uiSelectedModel used when mode is primary
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (b) uiSelectedModel used when mode is all
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (c) uiSelectedModel used when mode is undefined
(pass) resolveAdapterModelIntent > priority 2: ui-selected model > (d) uiSelectedModel is SKIPPED when mode is subagent — falls to next priority
(pass) resolveAdapterModelIntent > priority 3: category preference > (a) first categoryModels entry is returned when available
(pass) resolveAdapterModelIntent > priority 3: category preference > (b) second categoryModels entry used when first is unavailable
(pass) resolveAdapterModelIntent > priority 3: category preference > (c) category preference skipped when mode is subagent and no uiSelectedModel — falls to category then agent
(pass) resolveAdapterModelIntent > priority 4: agent preference > (a) first agentModels entry returned when no higher priority matches
(pass) resolveAdapterModelIntent > priority 4: agent preference > (b) second agentModels entry used when first is unavailable
(pass) resolveAdapterModelIntent > priority 5: system default > (a) systemDefault returned when all preferences are absent
(pass) resolveAdapterModelIntent > priority 6: constant fallback > (a) DEFAULT_FALLBACK_MODEL returned when nothing else is provided
(pass) resolveAdapterModelIntent > priority 6: constant fallback > (b) returned model equals DEFAULT_FALLBACK_MODEL constant value
(pass) resolveAdapterModelIntent > availability filtering > (a) empty availableModels set means no model passes — falls to systemDefault
(pass) resolveAdapterModelIntent > availability filtering > (b) unavailable category model skipped; available agent model returned

30 pass
0 fail
48 expect() calls
Ran 30 tests across 3 files.
~~~

## Artifact: Workspace typecheck

**What it proves:** The helper implementation, public exports, and inferred type usage compile across every package.

**Why it matters:** Adapter-facing API changes must not break downstream packages or workspace path mappings.

**Command:**

~~~bash
bun run typecheck
~~~

**Result summary:** TypeScript completed with zero errors for core, engine, config, and adapter packages.

~~~text
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
~~~

## Reviewer Conclusion

The model-resolution helper is implemented, exported, covered by targeted tests for every required branch, and typechecks across the workspace.
