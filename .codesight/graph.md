# Dependency Graph

## Most Imported Files (change these carefully)

- `packages\cli\src\theme\colors.ts` — imported by **17** files
- `packages\engine\src\runtime\types.ts` — imported by **16** files
- `packages\cli\src\io\terminal.ts` — imported by **15** files
- `packages\engine\src\runtime\store.ts` — imported by **13** files
- `packages\cli\src\fs\file-system.ts` — imported by **12** files
- `packages\engine\src\logger.ts` — imported by **12** files
- `packages\cli\src\args.ts` — imported by **11** files
- `packages\engine\src\execution-lifecycle\metadata.ts` — imported by **11** files
- `packages\engine\src\runtime\errors.ts` — imported by **11** files
- `packages\engine\src\execution-lifecycle\lease.ts` — imported by **10** files
- `packages\engine\src\execution-lifecycle\errors.ts` — imported by **10** files
- `packages\adapters\opencode\src\sdk-types.ts` — imported by **9** files
- `packages\adapters\opencode\src\adapter.ts` — imported by **8** files
- `packages\core\src\tokens.ts` — imported by **8** files
- `packages\cli\src\errors.ts` — imported by **7** files
- `packages\engine\src\execution-lifecycle.ts` — imported by **7** files
- `packages\cli\src\prompt\index.ts` — imported by **6** files
- `packages\core\src\errors.ts` — imported by **6** files
- `packages\engine\src\compose.ts` — imported by **6** files
- `packages\engine\src\tool-policy.ts` — imported by **6** files

## Import Map (who imports what)

- `packages\cli\src\theme\colors.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\prompt.ts`, `packages\cli\src\commands\runtime.ts` +12 more
- `packages\engine\src\runtime\types.ts` ← `packages\engine\src\execution-lifecycle\resume.ts`, `packages\engine\src\execution-lifecycle\start.ts`, `packages\engine\src\execution-lifecycle\types.ts`, `packages\engine\src\runtime\journal-writer.ts`, `packages\engine\src\runtime\sanitizer.ts` +11 more
- `packages\cli\src\io\terminal.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\prompt.ts`, `packages\cli\src\commands\runtime.ts` +10 more
- `packages\engine\src\runtime\store.ts` ← `packages\engine\src\execution-lifecycle\artifacts.ts`, `packages\engine\src\execution-lifecycle\dispatch.ts`, `packages\engine\src\execution-lifecycle\inspection.ts`, `packages\engine\src\execution-lifecycle\interrupts.ts`, `packages\engine\src\execution-lifecycle\reconciliation.ts` +8 more
- `packages\cli\src\fs\file-system.ts` ← `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\validate.ts`, `packages\cli\src\commands\__tests__\init.test.ts`, `packages\cli\src\commands\__tests__\migrate-conversion.test.ts`, `packages\cli\src\commands\__tests__\migrate.test.ts` +7 more
- `packages\engine\src\logger.ts` ← `packages\engine\src\compose.ts`, `packages\engine\src\index.ts`, `packages\engine\src\runtime\journal-writer.ts`, `packages\engine\src\runtime\sqlite\store.ts`, `packages\engine\src\runtime-command-operations\control.ts` +7 more
- `packages\cli\src\args.ts` ← `packages\cli\src\cli.ts`, `packages\cli\src\commands\init.ts`, `packages\cli\src\commands\migrate.ts`, `packages\cli\src\commands\prompt.ts`, `packages\cli\src\commands\validate.ts` +6 more
- `packages\engine\src\execution-lifecycle\metadata.ts` ← `packages\engine\src\execution-lifecycle\before-tool.ts`, `packages\engine\src\execution-lifecycle\completion.ts`, `packages\engine\src\execution-lifecycle\dispatch.ts`, `packages\engine\src\execution-lifecycle\index.ts`, `packages\engine\src\execution-lifecycle\inspection.ts` +6 more
- `packages\engine\src\runtime\errors.ts` ← `packages\engine\src\execution-lifecycle\lease.ts`, `packages\engine\src\runtime\fingerprint.ts`, `packages\engine\src\runtime\fingerprint.ts`, `packages\engine\src\runtime\journal-writer.ts`, `packages\engine\src\runtime\journal-writer.ts` +6 more
- `packages\engine\src\execution-lifecycle\lease.ts` ← `packages\engine\src\execution-lifecycle\artifacts.ts`, `packages\engine\src\execution-lifecycle\completion.ts`, `packages\engine\src\execution-lifecycle\dispatch.ts`, `packages\engine\src\execution-lifecycle\inspection.ts`, `packages\engine\src\execution-lifecycle\interrupts.ts` +5 more
