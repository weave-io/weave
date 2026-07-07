# 16-task-01-proofs.md

## Task Summary

Task 1.0 formalizes `AgentDescriptor` identity fields. The implementation keeps `name` as the required stable internal identifier and adds optional `displayName` presentation metadata populated from Weave-owned agent `display_name` config.

## What This Task Proves

- Adapter-facing descriptors retain stable `name` identity for durable resource mapping.
- Optional `displayName` is presentation metadata only and does not replace or mutate `name`.
- `AgentDescriptor` remains exported from `@weaveio/weave-engine` through `packages/engine/src/index.ts`.
- Documentation now states the distinction between stable identity and display metadata.

## Evidence Summary

The targeted compose test verifies representative builtin identity behavior, including a configured `display_name` and an omitted `display_name`. The engine package typecheck verifies the exported descriptor type compiles after adding `displayName`.

## Artifact: Targeted Compose Test

Interpretation: `compose.test.ts` passed after adding identity-field assertions, proving descriptor composition returns stable `name` and optional `displayName` for builtin descriptors.

```text
$ bun test packages/engine/src/__tests__/compose.test.ts
bun test v1.3.13 (bf2e2cec)
 34 pass
 0 fail
 75 expect() calls
Ran 34 tests across 1 file. [62.00ms]
```

## Artifact: Engine Typecheck

Interpretation: the engine package typechecked successfully, including the public `AgentDescriptor` export from `packages/engine/src/index.ts`.

```text
$ bun run --filter '@weaveio/weave-engine' typecheck
@weaveio/weave-engine typecheck: Exited with code 0
```

## Artifact: Documentation Evidence

Interpretation: `docs/adapter-boundary.md#stable-adapter-descriptor-contract` now documents that `descriptor.name` is the stable harness-neutral internal id and `descriptor.displayName` is optional presentation metadata composed from Weave-owned config such as `display_name`.

## Reviewer Conclusion

Task 1.0 is complete. The identity contract is implemented, tested, typechecked, documented, and ready for adapter consumers without introducing harness-specific ids.
