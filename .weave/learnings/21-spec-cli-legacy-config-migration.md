# Learnings: 21-spec-cli-legacy-config-migration

## Task 1: Add migration-aware `weave init` command entry paths
- **Discrepancy**: The existing `createPlan()` flow had a decisive-flag shortcut that returned early when `--scope` was present, so the required `weave init --scope local|global` migration-offer path was not reachable without restructuring. Explicit `weave init migrate` also initially wrote the migrated file without actually re-entering the normal interactive harness-selection flow.
- **Resolution**: Restructured scope resolution so `--scope` still reaches legacy-source detection before normal init fallback, and updated explicit migrate mode to continue through `continueAfterMigration()` for interactive sessions while keeping `--yes` non-interactive.
- **Suggestion**: Future plans for this area should explicitly call out the existing decisive-flag fast path in `createPlan()` and separately specify interactive versus `--yes` post-migration continuation expectations.

## Task 2: Implement safe migration planning, preflight, and write behavior
- **Discrepancy**: The first Task 2 pass added a `parseConfig()` validation gate, but the test/proof coverage only demonstrated an earlier abort path (`no legacy source`) instead of directly proving that invalid generated DSL stops before destination or backup mutation.
- **Resolution**: Exported `writeMigratedDsl()` and `MigrationPlan` from `packages/cli/src/commands/init.ts`, then added direct invalid-DSL injection tests for both syntax and schema failures with and without a pre-existing destination to prove the validation gate fires before any write or backup step.
- **Suggestion**: Future plans for migration safety should explicitly require a directly testable validation seam whenever write-time validation must be proven, rather than assuming an end-to-end path can naturally produce invalid generated output.

## Task 3: Convert top-level legacy settings with warning-visible best effort
- **Discrepancy**: The existing preflight flow only knew the skipped-warning count after conversion, but the task required that warning count to be visible before the write confirmation. The prior `buildMigrationPlan()` default of `skippedWarningCount = 0` was not enough once real top-level conversion warnings existed.
- **Resolution**: Added a pure `convertLegacyJsonc()` pre-conversion pass in `runMigrateMode()` before rendering preflight, then rebuilt the migration plan with the actual `warnings.length` so the confirmation summary reflects the real skipped-field count.
- **Suggestion**: Future plans that require preflight summaries to show derived conversion metadata should state explicitly whether that metadata must be computed in advance, especially when the final write path also performs conversion.

## Task 4: Convert legacy agent, category, model, tool, and prompt intent
- **Discrepancy**: The first Task 4 pass converted any entry under the legacy `agents` top-level key into an `agent <name>` block, even when the name was not a builtin. That silently created new agents through the builtin-override path and conflicted with the plan’s namespace semantics, which reserve `custom_agents` for new agents.
- **Resolution**: Added a `BUILTIN_AGENT_NAMES.has(agentName)` guard in the `agents` handler so non-builtin names now warn and skip with guidance to use `custom_agents`, then added direct tests and proof coverage for that case.
- **Suggestion**: Future plans for config-namespace migrations should explicitly state both the allowed names and the rejection behavior for each legacy namespace, especially when multiple legacy keys can otherwise generate similar modern blocks.
