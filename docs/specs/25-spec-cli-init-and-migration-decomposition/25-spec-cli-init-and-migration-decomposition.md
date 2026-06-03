# 25-spec-cli-init-and-migration-decomposition.md

## Introduction/Overview

The CLI initialization and migration command implementation has accumulated too many responsibilities inside `packages/cli/src/commands/init.ts`. This spec defines a behavior-preserving remediation that restores a compiling baseline, separates init flow from migration flow and legacy conversion logic, and removes duplicated orchestration so the CLI is easier to maintain and safer to extend.

## Goals

- Restore a clean typechecking baseline for CLI command code.
- Split `init.ts` into smaller focused modules with one clear responsibility each.
- Isolate legacy JSONC-to-DSL conversion logic from interactive command orchestration.
- Reuse canonical migration helpers instead of repeating read-check-write-render flows.
- Preserve existing CLI behavior, output intent, and migration safety guarantees unless explicitly documented.

## User Stories

- **As a maintainer**, I want init and migration logic separated so that changing one command flow does not risk the other.
- **As a maintainer**, I want conversion logic isolated from terminal orchestration so that legacy-format support can be tested independently.
- **As a reviewer**, I want migration write logic centralized so that safety checks and success rendering cannot drift across call sites.
- **As a junior developer**, I want the CLI command structure to show where parsing, prompting, migration, and file generation live without reading a giant mixed-purpose file.

## Demoable Units of Work

### Unit 1: Restore a Compiling Baseline

**Purpose:** Fix current CLI type errors before broader structural refactoring continues.

**Functional Requirements:**
- The system shall remove or correct duplicated validation code that currently causes CLI typecheck failures.
- The system shall restore a clean `bun run typecheck` result for the CLI package without suppressing errors through casts or ignored diagnostics.
- The system shall preserve the intended migration validation behavior after the compile fix.

**Proof Artifacts:**
- CLI: `bun run typecheck` succeeds and demonstrates the compile gate is restored.
- Diff: removal of duplicated invalid validation block demonstrates the immediate fault was fixed directly.

### Unit 2: Separate Init, Migration, and Conversion Responsibilities

**Purpose:** Break the oversized command file into modules aligned with actual ownership boundaries.

**Functional Requirements:**
- The system shall move legacy JSONC-to-DSL conversion logic into a dedicated migration-focused module.
- The system shall move migration command orchestration into a dedicated command module separate from init command orchestration.
- The system shall keep shared helpers in canonical shared CLI modules rather than leaving them embedded in one command file.
- The user shall be able to find init flow logic, migration flow logic, and legacy conversion logic in separate files with intention-revealing names.

**Proof Artifacts:**
- File tree diff: demonstrates `init.ts` decomposed into focused modules.
- Test: existing init and migration command tests pass and demonstrate behavior remains intact after decomposition.
- CLI: targeted init and migrate command runs produce expected results and demonstrate flow parity.

### Unit 3: Canonicalize Migration Write Orchestration

**Purpose:** Replace repeated read-check-write-render sequences with one shared migration workflow helper.

**Functional Requirements:**
- The system shall extract one canonical migration execution helper for file read, destination check, write, validation, and success rendering.
- The system shall preserve current safety behavior for migration destination existence checks and failure handling.
- The system shall avoid introducing thin wrappers that only move duplication without simplifying the flow.

**Proof Artifacts:**
- Diff: demonstrates repeated migration orchestration replaced with a shared helper.
- Test: migration tests pass and demonstrate safety checks and user-facing outputs still match expectations.

### Unit 4: Tighten Shared Conversion Helpers

**Purpose:** Reduce copy-paste inside legacy conversion by extracting shared agent-field and warning-building logic where it genuinely simplifies the model.

**Functional Requirements:**
- The system shall extract shared conversion helpers only where multiple conversion paths truly share the same field-handling logic.
- The system shall keep conversion code direct and readable rather than replacing duplication with opaque magic.
- The system shall preserve existing conversion warnings, unsupported-field reporting, and generated DSL output expectations.

**Proof Artifacts:**
- Diff: shared conversion helper extraction demonstrates reduced duplication inside legacy conversion logic.
- Test: migration conversion tests pass and demonstrate unchanged generated DSL structure for covered fixtures.

## Non-Goals (Out of Scope)

1. **New CLI product features**: This spec does not add new user-facing init or migration capabilities.
2. **Legacy config format removal**: This spec does not remove supported legacy migration input formats unless a separate deprecation decision is made.
3. **Whole-CLI redesign**: This spec does not restructure unrelated CLI commands beyond shared helpers directly used by init and migration flows.

## Design Considerations

No specific design requirements identified.

## Repository Standards

- Follow the repository convention that code must compile cleanly under `bun run typecheck` before additional structural work is considered complete.
- Use Bun-native APIs and existing CLI filesystem abstractions rather than adding Node.js runtime dependencies.
- Prefer direct, boring command orchestration over generic wrappers that hide simple control flow.
- Keep tests alongside command behavior changes and preserve existing fixture-driven CLI testing patterns.
- Update docs if CLI command structure, examples, or migration guidance become materially easier to explain after refactoring.

## Technical Considerations

- Context assessment found `packages/cli/src/commands/init.ts` mixing three major concerns: init flow, migration flow, and legacy conversion.
- Repository guidance strongly favors one concept per module, explicit `neverthrow` error handling, and behavior-preserving decomposition.
- No latest-standards research was needed because this spec addresses repository-internal structural cleanup rather than a new library or framework decision.
- Structural extraction should keep command boundaries obvious and avoid replacing one giant file with several files that still depend on hidden cross-module state.
- Preserve fixture compatibility and migration-output expectations so existing tests remain meaningful proof artifacts.

## Security Considerations

- Preserve existing migration safety checks around overwriting files and validating generated DSL content.
- Do not emit sensitive local path or file content details in proof artifacts beyond what current tests already expose safely.
- Ensure migration outputs continue to avoid silently discarding unsupported fields without a warning path.

## Success Metrics

1. **Compile health**: CLI source compiles cleanly with `bun run typecheck`.
2. **Decomposition**: `init.ts` is reduced below 1,000 lines, with migration and conversion logic moved into dedicated modules.
3. **Behavior parity**: init and migration command tests pass with no regressions in supported output and safety behavior.

## Implementation Notes

### Module layout (as implemented)

The decomposition produced the following module structure:

```
packages/cli/src/
├── commands/
│   ├── init.ts                  # Init planning, prompts, scaffold, harness install, summary (617 lines)
│   └── migrate.ts               # weave init migrate orchestration flow
└── migration/
    ├── types.ts                 # MigrationPlan, ConversionWarning, ConversionResult types
    ├── legacy-jsonc-converter.ts # stripJsoncComments, convertLegacyJsonc, all conversion helpers
    ├── conversion-warnings.ts   # renderConversionWarnings
    ├── migration-plan.ts        # buildMigrationPlan, detectLegacySource, canonical path constants
    └── migration-write.ts       # writeMigratedDsl, performMigrationWrite, buildMigratedContent
```

### Backward compatibility

`init.ts` re-exports `MigrationPlan`, `ConversionWarning`, `ConversionResult`, `convertLegacyJsonc`, and `writeMigratedDsl` so that existing test imports from `../init.js` continue to work without modification.

### Open Questions (resolved)

1. Migration conversion moved into a dedicated `migration/` support area under `packages/cli/src/migration/`.
2. Terminal rendering helpers (`renderMigratePreflight`, `renderMigrateSuccess`) remain co-located with their orchestration modules (`migrate.ts` and `init.ts` respectively) since they are not shared across command boundaries.
