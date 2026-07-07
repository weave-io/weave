/**
 * Fixtures for runtime-command-operations integration tests.
 *
 * Provides:
 * - `MockPlanStateProvider` — configurable in-memory PlanStateProvider
 * - `FailingPlanStateProvider` — always returns ProviderUnavailable
 * - `InvalidNamePlanStateProvider` — always returns InvalidPlanName
 * - `MockEffectProjector` — records DispatchAgentEffect calls, no harness I/O
 * - `MockSecondAdapter` — non-OpenCode adapter fixture proving portability
 * - Workflow registry fixtures (SIMPLE_WORKFLOWS, MULTI_STEP_WORKFLOWS)
 * - `noopProjectEffect` — ok(undefined) without harness I/O
 * - `makeCapabilityEntry` / `makeContractWithCommandEntrypoints` — health fixtures
 *
 * ## Design constraints
 *
 * - No `@weaveio/weave-adapter-opencode` imports.
 * - No OpenCode registration code.
 * - No filesystem access, no SQLite, no harness startup.
 * - All mock implementations satisfy the engine interface surface only.
 *
 * @see packages/engine/src/plan-state-provider.ts
 * @see packages/engine/src/runtime-command-operations/types.ts
 * @see packages/engine/src/capability-contract.ts
 */

import type { WorkflowConfig } from "@weaveio/weave-core";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import type {
  AdapterCapabilityContract,
  CapabilityEntry,
  SafeAdapterInitInput,
} from "../../capability-contract.js";
import type { DispatchAgentEffect } from "../../execution-lifecycle.js";
import type {
  PlanStateError,
  PlanStateProvider,
} from "../../plan-state-provider.js";
import type { WorkflowRunnerError } from "../../runtime-command-operations/workflow-runner.js";

// ---------------------------------------------------------------------------
// § 1 — MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Configurable in-memory mock for `PlanStateProvider`.
 *
 * Tracks all calls so tests can assert the provider was (or was not) invoked.
 * No filesystem access — all results are in-memory.
 */
export class MockPlanStateProvider implements PlanStateProvider {
  readonly planExistsCalls: string[] = [];
  readonly isPlanCompleteCalls: string[] = [];

  constructor(
    private readonly planExistsResult: boolean = true,
    private readonly isPlanCompleteResult: boolean = true,
  ) {}

  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    this.planExistsCalls.push(planName);
    return okAsync(this.planExistsResult);
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    this.isPlanCompleteCalls.push(planName);
    return okAsync(this.isPlanCompleteResult);
  }
}

// ---------------------------------------------------------------------------
// § 2 — FailingPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Mock `PlanStateProvider` that always returns a `ProviderUnavailable` error.
 *
 * Used to test the error path when the provider cannot answer the query.
 */
export class FailingPlanStateProvider implements PlanStateProvider {
  planExists(_planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "test provider unavailable" },
    });
  }

  isPlanComplete(_planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "ProviderUnavailable" as const,
      cause: { message: "test provider unavailable" },
    });
  }
}

// ---------------------------------------------------------------------------
// § 3 — InvalidNamePlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Mock `PlanStateProvider` that always returns an `InvalidPlanName` error.
 *
 * Simulates a provider that rejects the plan name at the safe-name check
 * (e.g. the name contains `/`, `..`, `\0`, or other unsafe characters).
 */
export class InvalidNamePlanStateProvider implements PlanStateProvider {
  planExists(planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "InvalidPlanName" as const,
      planName,
    });
  }

  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError> {
    return errAsync({
      type: "InvalidPlanName" as const,
      planName,
    });
  }
}

// ---------------------------------------------------------------------------
// § 4 — MockEffectProjector
// ---------------------------------------------------------------------------

/**
 * Records `DispatchAgentEffect` calls without performing any harness I/O.
 *
 * Proves the engine's effect projection seam works without importing any
 * concrete harness adapter. The `calls` array records every effect in
 * emission order.
 */
export class MockEffectProjector {
  readonly calls: DispatchAgentEffect[] = [];

  /**
   * Returns `ok(undefined)` for every effect — no harness I/O.
   * Bind this method when passing as `projectEffect`.
   */
  project = (
    effect: DispatchAgentEffect,
  ): ResultAsync<void, WorkflowRunnerError> => {
    this.calls.push(effect);
    return okAsync(undefined);
  };
}

// ---------------------------------------------------------------------------
// § 5 — MockSecondAdapter — non-OpenCode adapter fixture
// ---------------------------------------------------------------------------

/**
 * Minimal non-OpenCode adapter fixture that proves command-operation
 * portability. This adapter:
 *
 * - Has a distinct harness name ("mock-second-adapter")
 * - Declares `command-entrypoints` as `emulated` (not `native`)
 * - Records all effect projections without any harness I/O
 * - Never imports `@weaveio/weave-adapter-opencode` or any OpenCode registration code
 *
 * Use this fixture in tests that must prove the engine command operations
 * work with a non-OpenCode harness.
 */
export class MockSecondAdapter {
  readonly harness = "mock-second-adapter";
  readonly projectedEffects: DispatchAgentEffect[] = [];

  /**
   * Effect projection callback — records effects without harness I/O.
   * Bind this method when passing as `projectEffect`.
   */
  projectEffect = (
    effect: DispatchAgentEffect,
  ): ResultAsync<void, WorkflowRunnerError> => {
    this.projectedEffects.push(effect);
    return okAsync(undefined);
  };

  /**
   * Build a `SafeAdapterInitInput` for this adapter with `command-entrypoints`
   * declared as `emulated` — proving the engine works with non-native entrypoints.
   */
  buildInitInput(): SafeAdapterInitInput {
    return {
      harness: this.harness,
      capabilityContract: makeContractWithCommandEntrypoints("emulated"),
      probeResults: [],
    };
  }
}

// ---------------------------------------------------------------------------
// § 6 — Workflow registry fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal workflow registry with a single `agent_signal` step.
 *
 * Used for tests that need a successful `runWorkflowLifecycle` call without
 * plan-oriented completion methods.
 */
export const SIMPLE_WORKFLOWS: Record<string, WorkflowConfig> = {
  "simple-execution": {
    description: "Simple execution workflow for testing",
    version: 1,
    steps: [
      {
        name: "execute",
        display_name: "Execute",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
    ],
  },
};

/**
 * Multi-step workflow registry with two sequential `agent_signal` steps.
 *
 * Used for tests that need to verify multi-step execution and effect ordering.
 */
export const MULTI_STEP_WORKFLOWS: Record<string, WorkflowConfig> = {
  "multi-step-execution": {
    description: "Multi-step execution workflow for testing",
    version: 1,
    steps: [
      {
        name: "plan",
        display_name: "Plan",
        type: "autonomous" as const,
        agent: "loom",
        prompt: "Plan for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
      {
        name: "execute",
        display_name: "Execute",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
    ],
  },
};

/**
 * Gate workflow with a `review_verdict` step for completion signal tests.
 *
 * - "work" step: agent_signal (auto-advances)
 * - "gate": review_verdict + on_reject: pause
 *
 * Used to test `advanceStep` with `review_verdict` approved/rejected signals.
 */
export const GATE_WORKFLOWS: Record<string, WorkflowConfig> = {
  "gate-execution": {
    description: "Gate workflow with review_verdict step for testing",
    version: 1,
    steps: [
      {
        name: "work",
        display_name: "Work",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Do the work for: {{instance.goal}}",
        completion: { method: "agent_signal" as const },
      },
      {
        name: "gate",
        display_name: "Gate",
        type: "gate" as const,
        agent: "weft",
        prompt: "Review the changes",
        completion: { method: "review_verdict" as const },
        on_reject: "pause" as const,
      },
    ],
  },
};

/**
 * Plan workflow with `plan_created` and `plan_complete` completion methods.
 *
 * Used to test the degraded fallback when `planStateProvider` is absent.
 */
export const PLAN_COMPLETION_WORKFLOWS: Record<string, WorkflowConfig> = {
  "plan-completion-execution": {
    description: "Plan completion workflow for testing",
    version: 1,
    steps: [
      {
        name: "create-plan",
        display_name: "Create Plan",
        type: "autonomous" as const,
        agent: "pattern",
        prompt: "Create a plan for: {{instance.goal}}",
        completion: {
          method: "plan_created" as const,
          plan_name: "{{instance.slug}}",
        },
      },
      {
        name: "execute-plan",
        display_name: "Execute Plan",
        type: "autonomous" as const,
        agent: "shuttle",
        prompt: "Execute the plan for: {{instance.goal}}",
        completion: {
          method: "plan_complete" as const,
          plan_name: "{{instance.slug}}",
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// § 7 — No-op projectEffect
// ---------------------------------------------------------------------------

/**
 * No-op `projectEffect` callback — returns `ok(undefined)` without harness I/O.
 *
 * Use when the test does not need to assert on projected effects.
 */
export const noopProjectEffect = (
  _effect: DispatchAgentEffect,
): ResultAsync<void, WorkflowRunnerError> => okAsync(undefined);

// ---------------------------------------------------------------------------
// § 8 — Capability contract fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `CapabilityEntry` for a given capability ID and readiness.
 */
export function makeCapabilityEntry(
  id: CapabilityEntry["id"],
  readiness: CapabilityEntry["readiness"],
  overrides: Partial<CapabilityEntry> = {},
): CapabilityEntry {
  return {
    id,
    description: `${id} capability`,
    readiness,
    ...overrides,
  };
}

/**
 * Build a complete `AdapterCapabilityContract` with all 12 required capabilities
 * set to `native`, plus the `command-entrypoints` capability overridden to the
 * given readiness.
 */
export function makeContractWithCommandEntrypoints(
  commandEntrypointsReadiness: CapabilityEntry["readiness"],
): AdapterCapabilityContract {
  const requiredIds: CapabilityEntry["id"][] = [
    "config-materialization",
    "agent-materialization",
    "primary-agent-selection",
    "delegated-specialist-execution",
    "prompt-composition",
    "tool-policy-mapping",
    "workflow-persistence",
    "workflow-step-dispatch",
    "plan-file-compatibility",
    "command-entrypoints",
    "event-logging",
    "token-usage-reporting",
  ];

  return {
    capabilities: requiredIds.map((id) =>
      makeCapabilityEntry(
        id,
        id === "command-entrypoints" ? commandEntrypointsReadiness : "native",
      ),
    ),
  };
}
