# Task 02 Proofs - Category shuttle descriptors and runner integration

## Task Summary

This task adds `generateCategoryShuttles()` and updates `WeaveRunner` to spawn generated `shuttle-{categoryName}` descriptors alongside declared agents. It also adds conflict detection for explicit agents whose names collide with generated category shuttle names.

## What This Task Proves

- Category shuttles are generated only when a base `shuttle` agent exists and is enabled.
- Generated descriptors inherit base shuttle fields and apply category overrides for `models`, `temperature`, `prompt_append`, and `tool_policy`.
- Disabled generated shuttles are skipped, while disabled base `shuttle` suppresses all category shuttles.
- Explicit `agent shuttle-{name}` declarations conflict with matching `category {name}` blocks and are surfaced as `CategoryShuttleConflictError` before spawning.
- `WeaveRunner` includes generated category shuttles in adapter spawning and preserves existing disabled-agent behavior.

## Evidence Summary

- `bun test packages/engine` passed with descriptor generation tests and runner integration tests.
- `bun run typecheck` passed across all workspace packages.
- `bun run lint` completed without lint errors; it reported pre-existing warnings/infos in unrelated files and generated declaration output.

## Artifact: Engine descriptor and runner test suite

**What it proves:** The descriptor generator and runner integration behave correctly for generation, inheritance, overrides, disabling, and conflict detection.

**Why it matters:** Category shuttles are part of the normalized agent graph that prompts and adapters rely on, so this behavior must be deterministic and isolated from real harness processes.

**Command:**

```bash
bun test packages/engine
```

**Result summary:** The engine suite passed with 55 tests, including the new descriptor and runner category-shuttle coverage.

```text
packages/engine/src/__tests__/descriptors.test.ts:
(pass) generateCategoryShuttles > generation > (a) returns empty object when config has no categories
(pass) generateCategoryShuttles > generation > (b) returns empty object when base shuttle agent is absent
(pass) generateCategoryShuttles > generation > (c) produces a shuttle-{name} key for each category
(pass) generateCategoryShuttles > generation > (d) generated descriptor name field matches the key
(pass) generateCategoryShuttles > inheritance > (a) generated descriptor inherits base shuttle prompt
(pass) generateCategoryShuttles > inheritance > (b) generated descriptor inherits base shuttle tool_policy when category has none
(pass) generateCategoryShuttles > inheritance > (c) generated descriptor has mode subagent regardless of base shuttle mode
(pass) generateCategoryShuttles > category overrides > (a) category models replace the inherited models field
(pass) generateCategoryShuttles > category overrides > (b) category temperature overrides base temperature
(pass) generateCategoryShuttles > category overrides > (c) category prompt_append is set on the descriptor
(pass) generateCategoryShuttles > category overrides > (d) category tool_policy merges over base: category fields win, unset fields keep base values
(pass) generateCategoryShuttles > category overrides > (e) fields not set in category keep their base shuttle value
(pass) generateCategoryShuttles > disabling > (a) returns ok({}) when base shuttle is in disabled.agents
(pass) generateCategoryShuttles > disabling > (b) skips only the disabled category shuttle; others are still generated
(pass) generateCategoryShuttles > disabling > (c) base shuttle disabled suppresses ALL category shuttles
(pass) generateCategoryShuttles > conflict detection > (a) returns err(CategoryShuttleConflictError) when shuttle-{name} is explicitly declared
(pass) generateCategoryShuttles > conflict detection > (b) error contains the correct shuttleName and categoryName fields
(pass) generateCategoryShuttles > conflict detection > (c) error message is human-readable and names both the agent and the category
(pass) generateCategoryShuttles > conflict detection > (d) returns ok when shuttle-{name} is in disabled.agents but not explicitly declared

packages/engine/src/__tests__/runner.test.ts:
(pass) WeaveRunner > category shuttle spawning > spawns a generated shuttle-{name} agent when a category is configured
(pass) WeaveRunner > category shuttle spawning > spawns multiple generated shuttles for multiple categories
(pass) WeaveRunner > category shuttle spawning > does not spawn a category shuttle when the base shuttle is disabled
(pass) WeaveRunner > category shuttle spawning > does not spawn a specific category shuttle when its name is in disabled.agents
(pass) WeaveRunner > category shuttle spawning > category shuttle descriptor carries category models
(pass) WeaveRunner > category shuttle spawning > throws when a category would generate a name that is already explicitly declared

55 pass
0 fail
85 expect() calls
Ran 55 tests across 4 files.
```

## Artifact: Workspace typecheck

**What it proves:** The fallible `generateCategoryShuttles()` API, `neverthrow` dependency declaration, runner integration, and public exports are type-correct across the workspace.

**Why it matters:** Generated descriptors are consumed through public engine APIs and runner code, so package boundaries must compile cleanly.

**Command:**

```bash
bun run typecheck
```

**Result summary:** TypeScript completed with zero errors for all packages.

```text
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weave/core typecheck: Exited with code 0
@weave/engine typecheck: Exited with code 0
@weave/config typecheck: Exited with code 0
@weave/adapter-opencode typecheck: Exited with code 0
```

## Artifact: Repository lint gate

**What it proves:** The new engine files do not introduce Biome lint errors.

**Why it matters:** The repository enforces linting in pre-commit checks, so generated descriptor code must satisfy project style rules.

**Command:**

```bash
bun run lint
```

**Result summary:** Biome completed without errors. It reported only pre-existing fixable warnings/infos in unrelated core test/declaration files.

```text
$ biome lint packages/
Checked 66 files in 45ms. No fixes applied.
Found 2 warnings.
Found 4 infos.
```

## Reviewer Conclusion

The category shuttle generator and runner integration work through isolated unit tests, compile across package boundaries, and satisfy repository lint gates without requiring a real harness.
