# Task 01 Proofs — Export Core Tool-Policy Vocabulary and Define Engine Effective Policy Model

## Task Summary

Task 1 of Spec 08 establishes the foundational vocabulary for abstract tool-policy evaluation in Weave:

1. Confirmed `ToolPermissionSchema`, `ToolPolicySchema`, `ToolPermission`, and `ToolPolicy` already exist in `packages/core/src/schema.ts` — no duplication needed.
2. Updated `packages/core/src/index.ts` to export `ToolPolicy` and `ToolPolicySchema` alongside the existing `ToolPermission` and `ToolPermissionSchema` exports.
3. Created `packages/engine/src/tool-policy.ts` with:
   - `ABSTRACT_CAPABILITIES` — ordered list of exactly five abstract capabilities typed as `(keyof ToolPolicy)[]`
   - `EffectiveToolPolicy` — mapped type requiring all five capabilities as non-optional `ToolPermission` fields
   - `DEFAULT_PERMISSION` — constant `"ask"` typed as `ToolPermission`
4. Updated `packages/engine/src/index.ts` to export the new types and constants.
5. Added barrel import assertions to `packages/core/src/__tests__/schema.test.ts`.
6. Created `packages/engine/src/__tests__/tool-policy.test.ts` with comprehensive tests.

## What This Task Proves

- The `@weaveio/weave-core` barrel correctly exports all four tool-policy symbols (`ToolPermission`, `ToolPermissionSchema`, `ToolPolicy`, `ToolPolicySchema`).
- The engine defines exactly five abstract capabilities (`read`, `write`, `execute`, `delegate`, `network`) with no harness-specific names.
- `EffectiveToolPolicy` is a fully-resolved policy type where every capability is required (no optional fields).
- `DEFAULT_PERMISSION` is `"ask"` — the safest default requiring explicit user approval.
- Engine code imports from `@weaveio/weave-core` and does not redefine `allow`/`deny`/`ask` literals.

## Evidence

### `bun test packages/core/src/__tests__/schema.test.ts packages/engine/src/__tests__/tool-policy.test.ts`

```
bun test v1.3.13 (bf2e2cec)

 50 pass
 0 fail
 91 expect() calls
Ran 50 tests across 2 files. [130.00ms]
```

### `bun run typecheck`

```
$ tsc --noEmit -p tsconfig.json && bun run --filter '*' typecheck
@weaveio/weave-core typecheck: Exited with code 0
@weaveio/weave-config typecheck: Exited with code 0
@weaveio/weave-engine typecheck: Exited with code 0
@weaveio/weave-adapter-opencode typecheck: Exited with code 0
@weaveio/weave-cli typecheck: Exited with code 0
```

## Code Review Artifact

### `packages/engine/src/tool-policy.ts` — Import Verification

The file imports exclusively from `@weaveio/weave-core`:

```typescript
import type { ToolPermission, ToolPolicy } from "@weaveio/weave-core";
```

**Does NOT redefine literals**: The file contains no `"allow"`, `"deny"`, or `"ask"` string literal type definitions. The only occurrence of `"ask"` is as the runtime value assigned to `DEFAULT_PERMISSION`:

```typescript
export const DEFAULT_PERMISSION: ToolPermission = "ask";
```

This is a value assignment using the `ToolPermission` type from `@weaveio/weave-core`, not a redefinition of the enum. The `ToolPermissionSchema` enum (`z.enum(["allow", "deny", "ask"])`) remains solely in `packages/core/src/schema.ts`.

### `ABSTRACT_CAPABILITIES` — Exact Five Capabilities

```typescript
export const ABSTRACT_CAPABILITIES: (keyof ToolPolicy)[] = [
  "read",
  "write",
  "execute",
  "delegate",
  "network",
];
```

Typed as `(keyof ToolPolicy)[]` — TypeScript enforces that only valid `ToolPolicy` keys can appear in this array. Adding a sixth capability would require a schema change in `@weaveio/weave-core` first.

### `EffectiveToolPolicy` — All Five Required

```typescript
export type EffectiveToolPolicy = {
  [K in keyof Required<ToolPolicy>]: ToolPermission;
};
```

Uses `Required<ToolPolicy>` to strip optionality from all five fields, then maps each to `ToolPermission`. This means any object typed as `EffectiveToolPolicy` must provide all five capabilities — no optional fields.
