# Dependency Graph

## Most Imported Files (change these carefully)

- `packages\cli\src\evals\types.ts` — imported by **39** files
- `packages\cli\src\theme\colors.ts` — imported by **20** files
- `packages\cli\src\io\terminal.ts` — imported by **18** files
- `packages\cli\src\evals\openrouter-client.ts` — imported by **18** files
- `packages\cli\src\evals\report-schema.ts` — imported by **17** files
- `packages\adapters\opencode\src\sdk-types.ts` — imported by **16** files
- `packages\engine\src\runtime\types.ts` — imported by **16** files
- `packages\cli\src\args.ts` — imported by **14** files
- `packages\engine\src\runtime\store.ts` — imported by **13** files
- `packages\cli\src\fs\file-system.ts` — imported by **12** files
- `packages\engine\src\logger.ts` — imported by **12** files
- `packages\adapters\opencode\src\adapter.ts` — imported by **11** files
- `packages\engine\src\execution-lifecycle\metadata.ts` — imported by **11** files
- `packages\engine\src\runtime\errors.ts` — imported by **11** files
- `packages\cli\src\errors.ts` — imported by **10** files
- `packages\engine\src\execution-lifecycle\lease.ts` — imported by **10** files
- `packages\engine\src\execution-lifecycle\errors.ts` — imported by **10** files
- `packages\cli\src\evals\prompt-snapshots.ts` — imported by **9** files
- `packages\engine\src\compose.ts` — imported by **9** files
- `packages\core\src\tokens.ts` — imported by **8** files

## Import Map (who imports what)

- `packages\cli\src\evals\types.ts` ← `packages\cli\src\evals\github-contents-publisher.ts`, `packages\cli\src\evals\input-validation.ts`, `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\loom-routing-runner.ts` +34 more
- `packages\cli\src\theme\colors.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +15 more
- `packages\cli\src\io\terminal.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +13 more
- `packages\cli\src\evals\openrouter-client.ts` ← `packages\cli\src\evals\loom-routing-runner.ts`, `packages\cli\src\evals\pattern-planning-runner.ts`, `packages\cli\src\evals\runner.ts`, `packages\cli\src\evals\shuttle-execution-runner.ts`, `packages\cli\src\evals\spindle-tools-runner.ts` +13 more
- `packages\cli\src\evals\report-schema.ts` ← `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts`, `packages\cli\src\evals\__tests__\artifact-bundle.test.ts` +12 more
- `packages\adapters\opencode\src\sdk-types.ts` ← `packages\adapters\opencode\src\adapter.ts`, `packages\adapters\opencode\src\plugin.ts`, `packages\adapters\opencode\src\reconcile-agent.ts`, `packages\adapters\opencode\src\tool-policy-mapping.ts`, `packages\adapters\opencode\src\translate-agent.ts` +11 more
- `packages\engine\src\runtime\types.ts` ← `packages\engine\src\execution-lifecycle\resume.ts`, `packages\engine\src\execution-lifecycle\start.ts`, `packages\engine\src\execution-lifecycle\types.ts`, `packages\engine\src\runtime\journal-writer.ts`, `packages\engine\src\runtime\sanitizer.ts` +11 more
- `packages\cli\src\args.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\compose.ts`, `packages\cli\src\commands\eval.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts` +9 more
- `packages\engine\src\runtime\store.ts` ← `packages\engine\src\execution-lifecycle\artifacts.ts`, `packages\engine\src\execution-lifecycle\dispatch.ts`, `packages\engine\src\execution-lifecycle\inspection.ts`, `packages\engine\src\execution-lifecycle\interrupts.ts`, `packages\engine\src\execution-lifecycle\reconciliation.ts` +8 more
- `packages\cli\src\fs\file-system.ts` ← `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\validate.ts`, `packages\cli\src\commands\__tests__\init.test.ts`, `packages\cli\src\commands\__tests__\migrate-conversion.test.ts`, `packages\cli\src\commands\__tests__\migrate.test.ts` +7 more
