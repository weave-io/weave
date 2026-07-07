# 16-task-03-proofs.md

## Task Summary

Task 3.0 represents category metadata and disabled entries in adapter-facing descriptors. `AgentDescriptor` now has optional normalized `category` metadata for generated category shuttles only: source category name, optional description, and declared patterns.

## What This Task Proves

- Generated category shuttle descriptors include category metadata without changing regular agent descriptors.
- Category patterns are preserved exactly as declared; the engine does not expand globs or scan project files.
- Disabled declared agents and suppressed generated category shuttles are omitted from adapter-facing materialization output.
- Descriptor metadata preservation is wired through runner composition while leaving category shuttle generation mechanics to the existing generation path.

## Evidence Summary

Targeted descriptor, compose, and runner tests pass. The tests cover generated shuttle association with source category metadata, omitted disabled category shuttles, descriptor category shape, regular-agent absence, and adapter-facing omission behavior.

## Artifact: Targeted Descriptors/Compose/Runner Tests

Interpretation: these tests prove category metadata is available on generated category shuttle descriptors and omitted for regular agents, while disabled declared agents and disabled generated shuttles are not emitted.

```text
$ bun test packages/engine/src/__tests__/descriptors.test.ts packages/engine/src/__tests__/compose.test.ts packages/engine/src/__tests__/runner.test.ts
bun test v1.3.13 (bf2e2cec)
 113 pass
 0 fail
 270 expect() calls
Ran 113 tests across 3 files. [64.00ms]
```

## Artifact: Engine Typecheck

Interpretation: category metadata types compile through `AgentDescriptor`, descriptor composition, and runner materialization.

```text
$ bun run --filter '@weaveio/weave-engine' typecheck
@weaveio/weave-engine typecheck: Exited with code 0
```

## Artifact: Pattern Preservation Evidence

Interpretation: tests assert category patterns such as `src/components/**` and `src/pages/**/*.tsx` appear unchanged in `descriptor.category.patterns`. No engine code expands those globs or scans project files to derive category metadata.

## Reviewer Conclusion

Task 3.0 is complete. Category metadata is represented in the stable descriptor contract for generated shuttles only, and disabled entries are omitted from adapter-facing output.
