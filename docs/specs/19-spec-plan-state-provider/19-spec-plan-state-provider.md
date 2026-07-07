# 19-spec-plan-state-provider.md

## Introduction/Overview

Extract the plan-file I/O currently embedded in `packages/engine/src/execution-lifecycle.ts` into a `PlanStateProvider` interface owned by `@weaveio/weave-engine`. Provide a default Bun-backed implementation (`BunFilesystemPlanStateProvider`) in `@weaveio/weave-config`. Wire the provider into `CompleteStepInput` as an optional field so that adapters and tests can supply any implementation without the engine performing direct filesystem I/O.

This fixes a boundary violation: `checkPlanFileExists` and `checkPlanComplete` in `execution-lifecycle.ts` call `Bun.file()` directly, making the engine responsible for harness-owned filesystem conventions. Under the adapter boundary rules, the engine must not scan harness-owned directories or perform concrete filesystem I/O for resources it does not own. Plan files live under `.weave/plans/` — a Weave-owned path — but the _mechanism_ for reading them (Bun filesystem APIs) is a concrete I/O concern that belongs in an adapter-supplied or config-layer-supplied provider, not in the engine core.

## Goals

- Define `PlanStateProvider` and `PlanStateError` in `@weaveio/weave-engine` (`packages/engine/src/plan-state-provider.ts`).
- Add `planStateProvider?: PlanStateProvider` to `CompleteStepInput`.
- When `step.completion.method` is `"plan_created"` or `"plan_complete"` and `planStateProvider` is **absent**, `completeStep` returns a typed `policy_decision` error — never silently passes.
- Provide `BunFilesystemPlanStateProvider` in `@weaveio/weave-config` as the default implementation for production use.
- Keep `validatePlanName` as an internal engine helper; it is a sanitisation concern that any provider may want to apply, and the engine still validates input before calling the provider.
- Document adapter ownership of plan file state in `docs/adapter-boundary.md`.

## User Stories

- **As an adapter author**, I want to supply a `PlanStateProvider` to `completeStep` so that my adapter controls how plan files are discovered and read, without the engine hard-coding Bun filesystem calls.
- **As a test author**, I want to inject a mock `PlanStateProvider` into `completeStep` so that plan-completion tests run without touching the real filesystem.
- **As a Weave engine maintainer**, I want `completeStep` to return a typed error when `plan_created`/`plan_complete` is used without a provider, so that misconfigured callers fail loudly rather than silently skipping plan checks.
- **As a production adapter author**, I want `BunFilesystemPlanStateProvider` available from `@weaveio/weave-config` so that I can use the default implementation without re-implementing filesystem logic.

## Interface and Error Union

Both types are exported from `@weaveio/weave-engine` via `packages/engine/src/plan-state-provider.ts`.

```ts
// packages/engine/src/plan-state-provider.ts

import type { ResultAsync } from "neverthrow";

/**
 * Error variants for PlanStateProvider operations.
 *
 * - `InvalidPlanName` — the plan name contains unsafe characters or is otherwise
 *   rejected before any I/O is attempted.
 * - `ProviderUnavailable` — the provider could not complete the operation (e.g.
 *   filesystem error, network error, or the provider is not configured).
 */
export type PlanStateError =
  | { type: "InvalidPlanName"; planName: string; reason: string }
  | { type: "ProviderUnavailable"; reason: string };

/**
 * Abstract interface for querying plan file state.
 *
 * The engine calls this interface during `completeStep` when the step's
 * completion method is `"plan_created"` or `"plan_complete"`. The engine
 * never performs filesystem I/O directly for plan files.
 *
 * Implementations:
 * - `BunFilesystemPlanStateProvider` in `@weaveio/weave-config` — reads
 *   `.weave/plans/<name>.md` using Bun filesystem APIs (production default).
 * - Test doubles — in-memory stubs that return controlled results without
 *   touching the filesystem.
 */
export interface PlanStateProvider {
  /**
   * Returns `ok(true)` when the plan file exists, `ok(false)` when it does
   * not, or `err(PlanStateError)` when the check cannot be completed.
   */
  planExists(planName: string): ResultAsync<boolean, PlanStateError>;

  /**
   * Returns `ok(true)` when the plan file exists and contains no incomplete
   * checkboxes (`- [ ]`), `ok(false)` when incomplete checkboxes remain, or
   * `err(PlanStateError)` when the check cannot be completed.
   *
   * Implementations MUST return `err({ type: "ProviderUnavailable" })` (not
   * `ok(false)`) when the file does not exist, so callers can distinguish
   * "plan not found" from "plan found but incomplete".
   */
  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError>;
}
```

### Why `ok(boolean)` instead of `ok(undefined)` / `err` for the negative case?

The previous internal helpers (`checkPlanFileExists`, `checkPlanComplete`) returned `ok(undefined)` on success and `err(LifecycleError)` on failure, encoding the negative case as an error. The provider interface uses `ok(boolean)` instead because:

1. "Plan does not exist" and "plan is incomplete" are **expected, non-exceptional states** during normal workflow execution — they are not errors.
2. Returning `ok(false)` lets the engine translate the result into the appropriate `LifecycleError` variant with full context (plan name, step name, instance id) that the provider does not have.
3. Test doubles can return `ok(false)` without constructing `LifecycleError` values, keeping test code simpler.

## `CompleteStepInput` Change

`CompleteStepInput` in `packages/engine/src/execution-lifecycle.ts` gains one optional field:

```ts
export interface CompleteStepInput {
  // ... existing fields unchanged ...

  /**
   * Provider for querying plan file state.
   *
   * Required when `step.completion.method` is `"plan_created"` or
   * `"plan_complete"`. When absent and the step uses either of those methods,
   * `completeStep` returns a `policy_decision` error rather than silently
   * skipping the plan check.
   *
   * Adapters supply this field using `BunFilesystemPlanStateProvider` (from
   * `@weaveio/weave-config`) for production use, or a test double for unit tests.
   */
  readonly planStateProvider?: PlanStateProvider;
}
```

## Engine Behaviour When Provider Is Absent

When `completeStep` evaluates a step whose `completion.method` is `"plan_created"` or `"plan_complete"` and `input.planStateProvider` is `undefined`, the engine **must** return:

```ts
err(
  lifecyclePolicyDecisionError(
    "plan completion method requires a planStateProvider",
    "plan_state_provider",
  ),
)
```

This is a `policy_decision` error (discriminant `"policy_decision"` in `LifecycleError`). The engine never silently passes or skips the plan check in this case.

Rationale: silently skipping the plan check would allow a workflow to advance past a `plan_created` or `plan_complete` step without verifying the plan file, defeating the purpose of those completion methods. A loud, typed error surfaces misconfiguration immediately.

## Engine Behaviour When Provider Is Present

When `input.planStateProvider` is present, the engine delegates plan state queries to the provider:

### `plan_created` method

```ts
const exists = await input.planStateProvider.planExists(planName);
// ok(true)  → plan file exists; proceed
// ok(false) → plan file missing; return not_found error
// err(...)  → provider error; map to persistence error
```

When `exists` is `ok(false)`, the engine returns:

```ts
err(lifecycleNotFoundError("plan_file", planPath, `Plan file "${planPath}" does not exist`))
```

### `plan_complete` method

```ts
const complete = await input.planStateProvider.isPlanComplete(planName);
// ok(true)  → plan is complete; proceed
// ok(false) → plan has incomplete checkboxes; return validation error
// err(...)  → provider error; map to persistence error
```

When `complete` is `ok(false)`, the engine returns:

```ts
err(lifecycleValidationError(
  `Plan "${planName}" has incomplete checkboxes — all tasks must be checked off`,
  "plan_complete",
))
```

### Provider error mapping

`PlanStateError` variants are mapped to `LifecycleError` as follows:

| `PlanStateError.type` | Maps to `LifecycleError` variant | Notes |
|---|---|---|
| `InvalidPlanName` | `validation` | The engine also validates plan names via `validatePlanName` before calling the provider; this case is a defence-in-depth path |
| `ProviderUnavailable` | `persistence` | Treated as an I/O failure |

## `validatePlanName` — Internal Engine Helper

`validatePlanName` remains a **private** function inside `packages/engine/src/execution-lifecycle.ts`. It is not exported from `@weaveio/weave-engine`.

Rationale:
- Name sanitisation is a security concern that the engine must enforce before constructing any path or calling any provider.
- Providers may also want to validate names, but they receive the already-validated name from the engine — they do not need to import the engine's validator.
- Keeping it private prevents callers from bypassing the engine's own validation by calling the provider directly with an unvalidated name.

The regex used by `validatePlanName` is:

```ts
/^[a-zA-Z0-9_-]+$/
```

Allowed: alphanumeric characters, hyphens, and underscores.  
Rejected: slashes, dots, backslashes, or any other character that could enable path traversal attacks.

`BunFilesystemPlanStateProvider` SHOULD apply the same regex before constructing a filesystem path, as a defence-in-depth measure.

## `BunFilesystemPlanStateProvider` — Default Implementation

The default implementation lives in `@weaveio/weave-config` at `packages/config/src/plan-state-provider.ts`.

```ts
// packages/config/src/plan-state-provider.ts

import { ResultAsync, ok, err } from "neverthrow";
import type { PlanStateProvider, PlanStateError } from "@weaveio/weave-engine";

const SAFE_PLAN_NAME = /^[a-zA-Z0-9_-]+$/;

export class BunFilesystemPlanStateProvider implements PlanStateProvider {
  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    if (!SAFE_PLAN_NAME.test(planName)) {
      return ResultAsync.fromSafePromise(
        Promise.resolve(
          err<boolean, PlanStateError>({
            type: "InvalidPlanName",
            planName,
            reason:
              "plan name contains unsafe characters — only alphanumeric characters, hyphens, and underscores are allowed",
          }),
        ),
      ).andThen((r) => r);
    }
    const planPath = `.weave/plans/${planName}.md`;
    return ResultAsync.fromPromise(
      Bun.file(planPath).exists(),
      (cause): PlanStateError => ({
        type: "ProviderUnavailable",
        reason: `Failed to check plan file existence: ${planPath} — ${String(cause)}`,
      }),
    );
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    if (!SAFE_PLAN_NAME.test(planName)) {
      return ResultAsync.fromSafePromise(
        Promise.resolve(
          err<boolean, PlanStateError>({
            type: "InvalidPlanName",
            planName,
            reason:
              "plan name contains unsafe characters — only alphanumeric characters, hyphens, and underscores are allowed",
          }),
        ),
      ).andThen((r) => r);
    }
    const planPath = `.weave/plans/${planName}.md`;
    return ResultAsync.fromPromise(
      Bun.file(planPath).text(),
      (cause): PlanStateError => ({
        type: "ProviderUnavailable",
        reason: `Failed to read plan file: ${planPath} — ${String(cause)}`,
      }),
    ).map((content) => !/- \[ \]/.test(content));
  }
}
```

### Why `@weaveio/weave-config` and not `@weaveio/weave-engine`?

`@weaveio/weave-engine` must not contain Bun filesystem calls for harness-owned or adapter-owned resources. The `.weave/plans/` directory is a Weave-owned path, but the _mechanism_ for reading it (Bun filesystem APIs) is a concrete I/O concern. Placing the default implementation in `@weaveio/weave-config` keeps the engine pure and allows adapters to substitute alternative implementations (e.g. a database-backed provider, a remote provider, or a test double) without modifying engine code.

`@weaveio/weave-config` already performs Bun filesystem I/O for config file discovery and prompt file resolution, so this is consistent with its existing responsibilities.

## Export Surface

### `@weaveio/weave-engine`

`packages/engine/src/index.ts` exports:

```ts
export type { PlanStateProvider, PlanStateError } from "./plan-state-provider.ts";
```

### `@weaveio/weave-config`

`packages/config/src/index.ts` exports:

```ts
export { BunFilesystemPlanStateProvider } from "./plan-state-provider.ts";
```

## Migration: Removing `checkPlanFileExists` and `checkPlanComplete`

After the provider interface is wired into `completeStep`, the private functions `checkPlanFileExists` and `checkPlanComplete` in `execution-lifecycle.ts` are replaced by provider delegation calls. They are not exported and have no external callers, so removal is safe.

The `Bun.file()` calls in those functions are the only direct filesystem I/O in `execution-lifecycle.ts`. After removal, `execution-lifecycle.ts` contains no Bun filesystem calls.

## Non-Goals (Out of Scope)

1. **Changing the `.weave/plans/` path convention**: The path `.weave/plans/<name>.md` remains the canonical location. `BunFilesystemPlanStateProvider` hard-codes this path. Future specs may make the base path configurable.
2. **Plan file creation**: `PlanStateProvider` is read-only. Writing plan files remains outside this spec.
3. **Plan file content parsing beyond checkbox detection**: `isPlanComplete` checks only for `- [ ]` patterns. Richer plan parsing is out of scope.
4. **Adapter-specific plan storage**: This spec does not define how adapters that store plans in non-filesystem locations (e.g. databases) should implement the interface. That is adapter-owned.
5. **Making `planStateProvider` required**: The field is optional to preserve backward compatibility with existing callers that do not use `plan_created`/`plan_complete` completion methods.

## Design Considerations

### Why `policy_decision` error when provider is absent?

`policy_decision` is the correct `LifecycleError` discriminant because the engine is enforcing a policy rule: "you declared a plan completion method, so you must supply a provider." This is not a validation error (the input is structurally valid), not a persistence error (no I/O was attempted), and not a not-found error (no resource was looked up). It is a policy enforcement failure.

### Why keep `validatePlanName` in the engine?

The engine must validate plan names before constructing paths or calling providers, regardless of which provider is used. This is a security invariant: path traversal prevention must not depend on provider implementations being correct. Keeping `validatePlanName` private in the engine ensures the validation always runs before any provider call.

### Why not make `PlanStateProvider` part of `WorkflowExecutionContext`?

`WorkflowExecutionContext` carries workflow-level context (workflow name, goal, slug, workflows map). `PlanStateProvider` is an I/O capability, not workflow context. Mixing I/O capabilities into context objects would make `WorkflowExecutionContext` harder to construct in tests and would blur the boundary between data and behaviour. A separate optional field on `CompleteStepInput` is cleaner.

## Repository Standards

- Follow the engine/adapter boundary in `docs/adapter-boundary.md`: the engine owns the `PlanStateProvider` interface and validation; adapters and `@weaveio/weave-config` own concrete implementations.
- Use `neverthrow` for all fallible operations. `PlanStateProvider` methods return `ResultAsync<T, PlanStateError>`. The engine maps `PlanStateError` to `LifecycleError` at the call site.
- Use the shared pino logger from `@weaveio/weave-engine` for any logging inside `BunFilesystemPlanStateProvider`. Never use `console.*`.
- Tests for `completeStep` with plan completion methods must use a mock `PlanStateProvider` — never real filesystem I/O.
- Export `PlanStateProvider` and `PlanStateError` from `packages/engine/src/index.ts`. Export `BunFilesystemPlanStateProvider` from `packages/config/src/index.ts`.
- Mention the relevant GitHub issue in any Pull Request created for this work.

## Technical Considerations

- The `PlanStateProvider` interface file (`packages/engine/src/plan-state-provider.ts`) should contain only the interface and error union — no implementation code.
- `BunFilesystemPlanStateProvider` should apply the same safe-name regex as `validatePlanName` as a defence-in-depth measure, even though the engine validates names before calling the provider.
- The engine's `completeStep` implementation should call `validatePlanName` first, then check for provider presence, then call the provider. This order ensures path traversal prevention runs before any I/O.
- Existing tests for `plan_created` and `plan_complete` in `packages/engine/src/__tests__/execution-lifecycle.test.ts` must be updated to supply a mock `PlanStateProvider` via `CompleteStepInput.planStateProvider`.
- New tests should cover: provider absent + plan method → `policy_decision` error; provider returns `ok(false)` for `planExists` → `not_found` error; provider returns `ok(false)` for `isPlanComplete` → `validation` error; provider returns `err(InvalidPlanName)` → `validation` error; provider returns `err(ProviderUnavailable)` → `persistence` error.

## Security Considerations

- `validatePlanName` in the engine is the primary path traversal defence. It must run before any provider call.
- `BunFilesystemPlanStateProvider` applies the same regex as a secondary defence. It must not construct filesystem paths from unvalidated names.
- `PlanStateProvider` implementations must not expose plan file content in error messages beyond what is needed for diagnosis.
- The `PlanStateError` union must not carry raw file content, credentials, or sensitive metadata.

## Success Metrics

1. **Interface available**: `PlanStateProvider` and `PlanStateError` are importable from `@weaveio/weave-engine`.
2. **Default implementation available**: `BunFilesystemPlanStateProvider` is importable from `@weaveio/weave-config`.
3. **Provider absent → typed error**: `completeStep` with a `plan_created`/`plan_complete` step and no `planStateProvider` returns a `policy_decision` error.
4. **No Bun.file in engine**: `execution-lifecycle.ts` contains no `Bun.file()` calls after migration.
5. **Test coverage**: All plan-completion paths are tested with mock providers; no test touches the real filesystem for plan checks.
6. **Boundary documented**: `docs/adapter-boundary.md` records plan file state as adapter-owned with a `PlanStateProvider` subsection.

## Open Questions

1. Should `BunFilesystemPlanStateProvider` accept a configurable base path (e.g. `new BunFilesystemPlanStateProvider({ plansDir: ".weave/plans" })`) to support non-standard project layouts, or should the path be hard-coded for now?
2. Should `PlanStateProvider` be extended in a future spec to support plan file creation (`createPlan`) so that the Pattern agent can write plan files through the same abstraction?
3. Should the engine emit a debug-level log when `planStateProvider` is absent and the step uses a plan completion method, before returning the error, to aid diagnosis?
