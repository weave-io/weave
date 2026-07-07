/**
 * Tests for execution-lifecycle.ts
 *
 * Verifies:
 * - Lifecycle input types accept valid values (runtime shape checks)
 * - Lifecycle error discriminants are correct
 * - LifecycleEffect union includes RunAgentEffect as a variant (via DispatchAgentEffect)
 * - Public import paths compile (imports from @weaveio/weave-engine)
 * - SafeMetadata structural constraint
 * - Error factory helpers produce correct discriminants
 * - ExecutionOperationKind discriminated union (Spec 22 Unit 1)
 * - ExecutionAuthorizationSource — explicit authorization enforcement (Task 1.3)
 * - inspectExecution read-only behavior (Spec 22 Unit 1)
 * - observeSession boundary: cannot create instances or leases (ADR 0004)
 * - Agent-, hook-, and event-initiated self-start paths are rejected (ADR 0004)
 */

import { describe, expect, it } from "bun:test";
import type { RunAgentEffect } from "@weaveio/weave-engine";
import {
  type ArtifactInputDecl,
  type ArtifactInputRole,
  type ArtifactInputSummary,
  ARTIFACT_INPUT_ROLES,
  type BeforeToolInput,
  type BeforeToolOutput,
  beforeTool,
  type CompleteStepInput,
  type CompleteStepOutput,
  completeStep,
  createExecutionLeaseId,
  createInMemoryRuntimeStore,
  createOwnerId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
  type DispatchAgentEffect,
  type DispatchStepInput,
  type DispatchStepOutput,
  dispatchStep,
  EXECUTION_AUTHORIZATION_SOURCES,
  EXECUTION_OPERATION_KINDS,
  type ExecutionAuthorizationSource,
  type ExecutionOperationKind,
  evaluateEffectiveToolPolicy,
  type HandleUserInterruptInput,
  type HandleUserInterruptOutput,
  handleUserInterrupt,
  type InspectExecutionInput,
  type InspectExecutionOutput,
  inspectExecution,
  type LifecycleEffect,
  type LifecycleError,
  lifecycleLeaseConflictError,
  lifecycleNotFoundError,
  lifecyclePersistenceError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
  type ObserveSessionInput,
  type ObserveSessionOutput,
  observeSession,
  type PlanStateError,
  type PlanStateProvider,
  type PromptMetadata,
  queryError,
  type ReconcileExecutionInput,
  type ReconcileExecutionOutput,
  type ReconciliationAuthorizationSource,
  reconcileExecution,
  RECONCILIATION_AUTHORIZATION_SOURCES,
  RECONCILIATION_REASONS,
  type ResumeExecutionInput,
  type ResumeExecutionOutput,
  resumeExecution,
  type SafeMetadata,
  type StartExecutionInput,
  type StartExecutionOutput,
  type StepCompletionSignal,
  sanitizeMetadata,
  startExecution,
  validateAuthorizationSource,
  validateReconciliationSource,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import { errAsync, okAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// MockPlanStateProvider
// ---------------------------------------------------------------------------

/**
 * Configurable mock for PlanStateProvider.
 *
 * - `existsMap`: maps planName → boolean (default: false = not found)
 * - `completeMap`: maps planName → boolean (default: false = incomplete)
 * - `existsError`: if set, planExists returns this error for all names
 * - `completeError`: if set, isPlanComplete returns this error for all names
 */
class MockPlanStateProvider implements PlanStateProvider {
  constructor(
    private readonly existsMap: Record<string, boolean> = {},
    private readonly completeMap: Record<string, boolean> = {},
    private readonly existsError?: PlanStateError,
    private readonly completeError?: PlanStateError,
  ) {}

  planExists(planName: string) {
    if (this.existsError) return errAsync(this.existsError);
    const exists = this.existsMap[planName] ?? false;
    return okAsync(exists);
  }

  isPlanComplete(planName: string) {
    if (this.completeError) return errAsync(this.completeError);
    const complete = this.completeMap[planName] ?? false;
    return okAsync(complete);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wfId = createWorkflowInstanceId("wf-test-001");
const leaseId = createExecutionLeaseId("lease-test-001");
const snapshotId = createSessionSnapshotId("snap-test-001");

// ---------------------------------------------------------------------------
// SafeMetadata
// ---------------------------------------------------------------------------

describe("SafeMetadata", () => {
  it("accepts a flat record of string, number, and boolean values", () => {
    const meta: SafeMetadata = {
      agentName: "loom",
      stepIndex: 1,
      isRetry: false,
      modelId: "claude-sonnet-4-5",
    };
    expect(meta.agentName).toBe("loom");
    expect(meta.stepIndex).toBe(1);
    expect(meta.isRetry).toBe(false);
  });

  it("accepts an empty record", () => {
    const meta: SafeMetadata = {};
    expect(Object.keys(meta)).toHaveLength(0);
  });

  it("runtime shape: values are string | number | boolean only", () => {
    const meta: SafeMetadata = {
      str: "hello",
      num: 42,
      bool: true,
    };
    for (const val of Object.values(meta)) {
      const t = typeof val;
      expect(["string", "number", "boolean"]).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// LifecycleError discriminants
// ---------------------------------------------------------------------------

describe("LifecycleError discriminants", () => {
  it("lifecycleValidationError produces type: 'validation'", () => {
    const e = lifecycleValidationError("bad input", "fieldName");
    expect(e.type).toBe("validation");
    expect(e.message).toBe("bad input");
    expect(e.field).toBe("fieldName");
  });

  it("lifecycleValidationError without field produces type: 'validation'", () => {
    const e = lifecycleValidationError("bad input");
    expect(e.type).toBe("validation");
    expect(e.field).toBeUndefined();
  });

  it("lifecycleNotFoundError produces type: 'not_found'", () => {
    const e = lifecycleNotFoundError("WorkflowInstance", "wf-123");
    expect(e.type).toBe("not_found");
    expect(e.entity).toBe("WorkflowInstance");
    expect(e.id).toBe("wf-123");
    expect(e.message).toContain("wf-123");
  });

  it("lifecycleNotFoundError with custom message", () => {
    const e = lifecycleNotFoundError(
      "step",
      "step-1",
      "Step not found in workflow",
    );
    expect(e.type).toBe("not_found");
    expect(e.message).toBe("Step not found in workflow");
  });

  it("lifecycleLeaseConflictError produces type: 'lease_conflict'", () => {
    const e = lifecycleLeaseConflictError(
      wfId,
      leaseId,
      "Lease held by another owner",
    );
    expect(e.type).toBe("lease_conflict");
    expect(e.workflowInstanceId).toBe(wfId);
    expect(e.conflictingLeaseId).toBe(leaseId);
    expect(e.message).toBe("Lease held by another owner");
  });

  it("lifecyclePersistenceError produces type: 'persistence'", () => {
    const cause = { type: "query" as const, message: "DB write failed" };
    const e = lifecyclePersistenceError("Store write failed", cause);
    expect(e.type).toBe("persistence");
    expect(e.message).toBe("Store write failed");
    expect(e.cause).toBe(cause);
  });

  it("lifecyclePersistenceError without cause", () => {
    const e = lifecyclePersistenceError("Store write failed");
    expect(e.type).toBe("persistence");
    expect(e.cause).toBeUndefined();
  });

  it("lifecyclePolicyDecisionError produces type: 'policy_decision'", () => {
    const e = lifecyclePolicyDecisionError("Cannot evaluate policy", "execute");
    expect(e.type).toBe("policy_decision");
    expect(e.message).toBe("Cannot evaluate policy");
    expect(e.rule).toBe("execute");
  });

  it("lifecyclePolicyDecisionError without rule", () => {
    const e = lifecyclePolicyDecisionError("Cannot evaluate policy");
    expect(e.type).toBe("policy_decision");
    expect(e.rule).toBeUndefined();
  });

  it("all 5 error variants are exhaustively covered by the discriminant", () => {
    const errors: LifecycleError[] = [
      lifecycleValidationError("v"),
      lifecycleNotFoundError("E", "id"),
      lifecycleLeaseConflictError(wfId, leaseId, "conflict"),
      lifecyclePersistenceError("p"),
      lifecyclePolicyDecisionError("pd"),
    ];
    const types = errors.map((e) => e.type);
    expect(types).toContain("validation");
    expect(types).toContain("not_found");
    expect(types).toContain("lease_conflict");
    expect(types).toContain("persistence");
    expect(types).toContain("policy_decision");
    expect(new Set(types).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// LifecycleEffect union — RunAgentEffect as dispatch variant
// ---------------------------------------------------------------------------

describe("LifecycleEffect union", () => {
  it("DispatchAgentEffect wraps RunAgentEffect with kind: 'dispatch-agent'", () => {
    // Build a minimal RunAgentEffect fixture
    const runAgentEffect: RunAgentEffect = {
      kind: "run-agent",
      agentName: "shuttle",
      agentDescriptor: {
        name: "shuttle",
        composedPrompt: "You are shuttle.",
        models: ["claude-sonnet-4-5"],
        temperature: undefined,
        mode: "subagent",
        skills: [],
        delegationTargets: [],
        effectiveToolPolicy: {
          read: "allow",
          write: "allow",
          execute: "ask",
          delegate: "deny",
          network: "ask",
        },
        rawToolPolicy: undefined,
      },
      effectiveToolPolicy: {
        read: "allow",
        write: "allow",
        execute: "ask",
        delegate: "deny",
        network: "ask",
      },
      rawToolPolicy: undefined,
      resolvedSkills: [],
    };

    const dispatchEffect: DispatchAgentEffect = {
      kind: "dispatch-agent",
      runAgent: runAgentEffect,
    };

    expect(dispatchEffect.kind).toBe("dispatch-agent");
    expect(dispatchEffect.runAgent.kind).toBe("run-agent");
    expect(dispatchEffect.runAgent.agentName).toBe("shuttle");
  });

  it("LifecycleEffect union includes dispatch-agent, pause-execution, complete-execution variants", () => {
    const effects: LifecycleEffect[] = [
      {
        kind: "dispatch-agent",
        runAgent: {
          kind: "run-agent",
          agentName: "loom",
          agentDescriptor: {
            name: "loom",
            composedPrompt: "You are loom.",
            models: [],
            temperature: undefined,
            mode: "primary",
            skills: [],
            delegationTargets: [],
            effectiveToolPolicy: {
              read: "ask",
              write: "ask",
              execute: "ask",
              delegate: "ask",
              network: "ask",
            },
            rawToolPolicy: undefined,
          },
          effectiveToolPolicy: {
            read: "ask",
            write: "ask",
            execute: "ask",
            delegate: "ask",
            network: "ask",
          },
          rawToolPolicy: undefined,
          resolvedSkills: [],
        },
      },
      {
        kind: "pause-execution",
        workflowInstanceId: wfId,
        reason: "Gate rejected",
      },
      {
        kind: "complete-execution",
        workflowInstanceId: wfId,
      },
    ];

    const kinds = effects.map((e) => e.kind);
    expect(kinds).toContain("dispatch-agent");
    expect(kinds).toContain("pause-execution");
    expect(kinds).toContain("complete-execution");
  });

  it("pause-execution effect carries workflowInstanceId and optional reason", () => {
    const effect: LifecycleEffect = {
      kind: "pause-execution",
      workflowInstanceId: wfId,
      reason: "User requested pause",
    };
    expect(effect.kind).toBe("pause-execution");
    if (effect.kind === "pause-execution") {
      expect(effect.workflowInstanceId).toBe(wfId);
      expect(effect.reason).toBe("User requested pause");
    }
  });

  it("complete-execution effect carries workflowInstanceId", () => {
    const effect: LifecycleEffect = {
      kind: "complete-execution",
      workflowInstanceId: wfId,
    };
    expect(effect.kind).toBe("complete-execution");
    if (effect.kind === "complete-execution") {
      expect(effect.workflowInstanceId).toBe(wfId);
    }
  });
});

// ---------------------------------------------------------------------------
// ObserveSession input/output shapes
// ---------------------------------------------------------------------------

describe("ObserveSessionInput / ObserveSessionOutput", () => {
  it("accepts a valid ObserveSessionInput", () => {
    const input: ObserveSessionInput = {
      workflowInstanceId: wfId,
      leaseId,
      harnessName: "opencode",
      harnessVersion: "1.2.3",
      agentName: "loom",
      modelId: "claude-sonnet-4-5",
      stepName: "plan",
      sessionStatus: "active",
      metadata: { stepIndex: 0, isRetry: false },
    };
    expect(input.harnessName).toBe("opencode");
    expect(input.sessionStatus).toBe("active");
  });

  it("accepts ObserveSessionInput without optional fields", () => {
    const input: ObserveSessionInput = {
      workflowInstanceId: wfId,
      leaseId,
      harnessName: "claude-code",
      agentName: "shuttle",
      sessionStatus: "idle",
    };
    expect(input.harnessVersion).toBeUndefined();
    expect(input.metadata).toBeUndefined();
  });

  it("ObserveSessionOutput carries snapshotId", () => {
    const output: ObserveSessionOutput = { snapshotId };
    expect(output.snapshotId).toBe(snapshotId);
  });
});

// ---------------------------------------------------------------------------
// StartExecution input/output shapes
// ---------------------------------------------------------------------------

describe("StartExecutionInput / StartExecutionOutput", () => {
  it("accepts a valid StartExecutionInput", () => {
    const input: StartExecutionInput = {
      workflowInstanceId: wfId,
      ownerId: "session-abc",
      now: "2026-05-21T00:00:00.000Z",
      metadata: { source: "cli" },
    };
    expect(input.ownerId).toBe("session-abc");
  });

  it("accepts StartExecutionInput without optional fields", () => {
    const input: StartExecutionInput = {
      workflowInstanceId: wfId,
      ownerId: "session-xyz",
    };
    expect(input.now).toBeUndefined();
    expect(input.metadata).toBeUndefined();
  });

  it("StartExecutionOutput carries workflowInstanceId, leaseId and effects array", () => {
    const output: StartExecutionOutput = {
      workflowInstanceId: wfId,
      leaseId,
      effects: [],
    };
    expect(output.workflowInstanceId).toBe(wfId);
    expect(output.leaseId).toBe(leaseId);
    expect(output.effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ResumeExecution input/output shapes
// ---------------------------------------------------------------------------

describe("ResumeExecutionInput / ResumeExecutionOutput", () => {
  it("accepts a valid ResumeExecutionInput", () => {
    const input: ResumeExecutionInput = {
      workflowInstanceId: wfId,
      ownerId: "session-resume",
      now: "2026-05-21T01:00:00.000Z",
    };
    expect(input.ownerId).toBe("session-resume");
  });

  it("ResumeExecutionOutput carries leaseId and effects", () => {
    const output: ResumeExecutionOutput = {
      leaseId,
      effects: [{ kind: "pause-execution", workflowInstanceId: wfId }],
    };
    expect(output.leaseId).toBe(leaseId);
    expect(output.effects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// HandleUserInterrupt input/output shapes
// ---------------------------------------------------------------------------

describe("HandleUserInterruptInput / HandleUserInterruptOutput", () => {
  it("accepts signal: 'cancel'", () => {
    const input: HandleUserInterruptInput = {
      workflowInstanceId: wfId,
      leaseId,
      signal: "cancel",
    };
    expect(input.signal).toBe("cancel");
  });

  it("accepts signal: 'pause'", () => {
    const input: HandleUserInterruptInput = {
      workflowInstanceId: wfId,
      leaseId,
      signal: "pause",
      metadata: { source: "keyboard" },
    };
    expect(input.signal).toBe("pause");
  });

  it("HandleUserInterruptOutput carries effects array", () => {
    const output: HandleUserInterruptOutput = {
      effects: [{ kind: "complete-execution", workflowInstanceId: wfId }],
    };
    expect(output.effects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// DispatchStep input/output shapes
// ---------------------------------------------------------------------------

describe("DispatchStepInput / DispatchStepOutput", () => {
  it("accepts a valid DispatchStepInput with explicit stepName", () => {
    const input: DispatchStepInput = {
      workflowInstanceId: wfId,
      leaseId,
      stepName: "implement",
      metadata: { attempt: 1 },
    };
    expect(input.stepName).toBe("implement");
  });

  it("accepts DispatchStepInput without stepName (engine determines next step)", () => {
    const input: DispatchStepInput = {
      workflowInstanceId: wfId,
      leaseId,
    };
    expect(input.stepName).toBeUndefined();
  });

  it("DispatchStepOutput carries stepName and effects", () => {
    const output: DispatchStepOutput = {
      stepName: "plan",
      effects: [],
    };
    expect(output.stepName).toBe("plan");
    expect(output.effects).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CompleteStep input/output shapes
// ---------------------------------------------------------------------------

describe("CompleteStepInput / CompleteStepOutput", () => {
  it("accepts outcome: 'success' with artifacts", () => {
    const signal: StepCompletionSignal = {
      outcome: "success",
      message: "Plan created successfully",
      artifacts: [{ name: "plan_path", path: ".weave/plans/my-feature.md" }],
      nextStepHint: "implement",
    };
    const input: CompleteStepInput = {
      workflowInstanceId: wfId,
      leaseId,
      stepName: "plan",
      completionSignal: signal,
    };
    expect(input.completionSignal.outcome).toBe("success");
    expect(input.completionSignal.artifacts).toHaveLength(1);
  });

  it("accepts outcome: 'blocked'", () => {
    const input: CompleteStepInput = {
      workflowInstanceId: wfId,
      leaseId,
      stepName: "security-review",
      completionSignal: { outcome: "blocked" },
    };
    expect(input.completionSignal.outcome).toBe("blocked");
  });

  it("accepts outcome: 'failed'", () => {
    const input: CompleteStepInput = {
      workflowInstanceId: wfId,
      leaseId,
      stepName: "implement",
      completionSignal: { outcome: "failed", message: "Build failed" },
    };
    expect(input.completionSignal.outcome).toBe("failed");
  });

  it("accepts outcome: 'paused'", () => {
    const input: CompleteStepInput = {
      workflowInstanceId: wfId,
      leaseId,
      stepName: "review-plan",
      completionSignal: { outcome: "paused" },
    };
    expect(input.completionSignal.outcome).toBe("paused");
  });

  it("CompleteStepOutput carries effects array", () => {
    const output: CompleteStepOutput = {
      effects: [{ kind: "complete-execution", workflowInstanceId: wfId }],
    };
    expect(output.effects).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BeforeTool input/output shapes
// ---------------------------------------------------------------------------

describe("BeforeToolInput / BeforeToolOutput", () => {
  const allAllowPolicy = evaluateEffectiveToolPolicy({
    read: "allow",
    write: "allow",
    execute: "allow",
    delegate: "allow",
    network: "allow",
  });

  it("accepts all abstract capability categories", () => {
    const capabilities: BeforeToolInput["toolCapability"][] = [
      "read",
      "write",
      "execute",
      "delegate",
      "network",
    ];
    for (const toolCapability of capabilities) {
      const input: BeforeToolInput = {
        workflowInstanceId: wfId,
        leaseId,
        agentName: "shuttle",
        toolCapability,
        toolName: `mock-${toolCapability}-tool`,
        effectiveToolPolicy: allAllowPolicy,
      };
      expect(input.toolCapability).toBe(toolCapability);
    }
  });

  it("accepts BeforeToolInput with optional metadata", () => {
    const input: BeforeToolInput = {
      workflowInstanceId: wfId,
      leaseId,
      agentName: "loom",
      toolCapability: "write",
      toolName: "edit_file",
      effectiveToolPolicy: allAllowPolicy,
      metadata: { filePath: "src/index.ts" },
    };
    expect(input.metadata?.filePath).toBe("src/index.ts");
  });

  it("BeforeToolOutput decision: 'allow'", () => {
    const output: BeforeToolOutput = { decision: "allow" };
    expect(output.decision).toBe("allow");
  });

  it("BeforeToolOutput decision: 'deny' with reason", () => {
    const output: BeforeToolOutput = {
      decision: "deny",
      reason: "Network access is denied by policy",
    };
    expect(output.decision).toBe("deny");
    expect(output.reason).toBe("Network access is denied by policy");
  });

  it("BeforeToolOutput decision: 'ask'", () => {
    const output: BeforeToolOutput = { decision: "ask" };
    expect(output.decision).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// Public import path verification
// ---------------------------------------------------------------------------

describe("public import paths", () => {
  it("lifecycle error factories are importable from @weaveio/weave-engine", () => {
    // These are already imported at the top of this file from @weaveio/weave-engine.
    // If the imports compile and resolve, this test passes.
    expect(typeof lifecycleValidationError).toBe("function");
    expect(typeof lifecycleNotFoundError).toBe("function");
    expect(typeof lifecycleLeaseConflictError).toBe("function");
    expect(typeof lifecyclePersistenceError).toBe("function");
    expect(typeof lifecyclePolicyDecisionError).toBe("function");
  });

  it("ID factory helpers are importable from @weaveio/weave-engine", () => {
    expect(typeof createWorkflowInstanceId).toBe("function");
    expect(typeof createExecutionLeaseId).toBe("function");
    expect(typeof createSessionSnapshotId).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — observeSession
// ---------------------------------------------------------------------------

describe("observeSession (Runtime Store)", () => {
  it("stores a sanitized SessionSnapshot and returns snapshotId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { stepIndex: 1, isRetry: false },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { snapshotId } = result.value;
    expect(typeof snapshotId).toBe("string");
    expect(snapshotId.length).toBeGreaterThan(0);

    // Verify the snapshot was persisted
    const fetchResult = await store.snapshots.getById(snapshotId);
    expect(fetchResult.isOk()).toBe(true);
    if (!fetchResult.isOk()) return;

    const snapshot = fetchResult.value;
    expect(snapshot.workflowInstanceId).toBe(wfId);
    expect(snapshot.leaseId).toBe(leaseId);
    expect(snapshot.harnessName).toBe("opencode");
    expect(snapshot.agentName).toBe("loom");
    expect(snapshot.sessionStatus).toBe("active");
    expect(snapshot.metadata.stepIndex).toBe(1);
    expect(snapshot.metadata.isRetry).toBe(false);
  });

  it("excludes raw harness-private data — metadata with 'password' key is rejected by sanitizer", async () => {
    const store = createInMemoryRuntimeStore();
    // The lifecycle sanitizer rejects metadata containing denied field names
    // before the store is called. 'password' is in the denylist.
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        // TypeScript allows this because SafeMetadata is Record<string, string|number|boolean>
        // but the runtime sanitizer rejects it
        metadata: { password: "hunter2" } as Record<
          string,
          string | number | boolean
        >,
      },
      store,
    );

    // The lifecycle sanitizer rejects the denied field with a validation error
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("excludes raw harness-private data — metadata with 'token' key is rejected", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "claude-code",
        agentName: "shuttle",
        sessionStatus: "idle",
        metadata: { token: "secret-token-value" } as Record<
          string,
          string | number | boolean
        >,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: "" as typeof wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for missing leaseId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId: "" as typeof leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("returns validation error for missing harnessName", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns validation error for missing agentName", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("stores snapshot with empty metadata when metadata is omitted", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "terminated",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const fetchResult = await store.snapshots.getById(result.value.snapshotId);
    expect(fetchResult.isOk()).toBe(true);
    if (!fetchResult.isOk()) return;
    expect(fetchResult.value.metadata).toEqual({});
  });

  it("returns persistence error when store fails", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { snapshotRecord: queryError("injected snapshot failure") },
    });
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — startExecution
// ---------------------------------------------------------------------------

describe("startExecution (Runtime Store)", () => {
  it("creates a WorkflowInstance and acquires an active ExecutionLease", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-start-001",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { leaseId: acquiredLeaseId, effects } = result.value;
    expect(typeof acquiredLeaseId).toBe("string");
    expect(acquiredLeaseId.length).toBeGreaterThan(0);
    expect(effects).toHaveLength(0);

    // Verify the lease is active in the store
    const leaseResult = await store.leases.getById(acquiredLeaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value.workflowInstanceId).toBe(wfId);
    expect(leaseResult.value.ownerId).toBe(createOwnerId("session-start-001"));
  });

  it("returns the lease ID in output", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-lease-check",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Verify the returned leaseId matches what's in the store
    const activeResult = await store.leases.findActive();
    expect(activeResult.isOk()).toBe(true);
    if (!activeResult.isOk()) return;
    expect(activeResult.value?.id).toBe(result.value.leaseId);
  });

  it("uses one clock source — pass now explicitly and verify lease timestamps match", async () => {
    const fixedNow = "2026-05-21T10:00:00.000Z";
    // Use a clock that returns the fixed time so we can verify timestamps
    const store = createInMemoryRuntimeStore({
      clock: () => new Date(fixedNow),
    });

    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-clock-test",
        now: fixedNow,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const leaseResult = await store.leases.getById(result.value.leaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;

    // The store uses its own clock; the lease acquiredAt should match the fixed clock
    expect(leaseResult.value.acquiredAt).toBe(fixedNow);
  });

  it("updates existing WorkflowInstance to running status", async () => {
    const store = createInMemoryRuntimeStore();

    // Pre-create the workflow instance
    const createResult = await store.instances.create({
      workflowName: "test-workflow",
      goal: "test goal",
      slug: "test-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const existingId = createResult.value.id;

    const result = await startExecution(
      {
        workflowInstanceId: existingId,
        ownerId: "session-update-test",
      },
      store,
    );

    expect(result.isOk()).toBe(true);

    // Verify the instance is now running
    const instanceResult = await store.instances.getById(existingId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: "" as typeof wfId,
        ownerId: "session-abc",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns validation error for missing ownerId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns persistence error when store fails on lease acquire", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { leaseAcquire: queryError("injected lease failure") },
    });
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-fail-test",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });

  it("returns persistence error when workflow create fails", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { workflowCreate: queryError("injected create failure") },
    });
    const result = await startExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "session-create-fail",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });

  it("startExecution: returned workflowInstanceId matches the created instance and acquired lease", async () => {
    // Regression test for the ID mismatch bug:
    // Previously, store.instances.create() generated a new UUID while the lease
    // was acquired for input.workflowInstanceId — two different IDs.
    // Now all three must be identical.
    const store = createInMemoryRuntimeStore();
    const targetId = createWorkflowInstanceId("regression-id-match-001");

    const result = await startExecution(
      {
        workflowInstanceId: targetId,
        ownerId: "session-regression-test",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const output = result.value;

    // 1. output.workflowInstanceId must equal the input ID
    expect(output.workflowInstanceId).toBe(targetId);

    // 2. The instance in the store must have the same ID
    const instanceResult = await store.instances.getById(targetId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    const instance = instanceResult.value;
    expect(instance.id).toBe(targetId);

    // 3. The acquired lease must reference the same workflowInstanceId
    const leaseResult = await store.leases.getById(output.leaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    const lease = leaseResult.value;
    expect(lease.workflowInstanceId).toBe(targetId);

    // Invariant: output.workflowInstanceId === lease.workflowInstanceId === instance.id
    expect(output.workflowInstanceId).toBe(lease.workflowInstanceId);
    expect(output.workflowInstanceId).toBe(instance.id);
    expect(lease.workflowInstanceId).toBe(instance.id);
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — resumeExecution
// ---------------------------------------------------------------------------

describe("resumeExecution (Runtime Store)", () => {
  it("rebinds to an available execution (no active lease)", async () => {
    const store = createInMemoryRuntimeStore();

    // Pre-create a workflow instance in paused state
    const createResult = await store.instances.create({
      workflowName: "resume-workflow",
      goal: "resume goal",
      slug: "resume-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    await store.instances.update(instanceId, { status: "paused" });

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-resume-001",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { leaseId: newLeaseId, effects } = result.value;
    expect(typeof newLeaseId).toBe("string");
    expect(newLeaseId.length).toBeGreaterThan(0);
    expect(effects).toHaveLength(0);

    // Verify the instance is now running
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  it("rebinds to an expired lease (store replaces it)", async () => {
    // Use a clock that starts in the past so the first lease expires immediately
    let clockTime = new Date("2026-01-01T00:00:00.000Z");
    const store = createInMemoryRuntimeStore({
      clock: () => clockTime,
    });

    // Pre-create a workflow instance
    const createResult = await store.instances.create({
      workflowName: "expired-lease-workflow",
      goal: "expired lease goal",
      slug: "expired-lease-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    // Acquire an initial lease (will expire in 1 hour from clockTime)
    const firstLeaseResult = await store.leases.acquire({
      workflowInstanceId: instanceId,
      ownerId: "session-first-owner" as ReturnType<typeof createOwnerId>,
      ttlMs: 1, // 1ms TTL — expires almost immediately
    });
    expect(firstLeaseResult.isOk()).toBe(true);
    if (!firstLeaseResult.isOk()) return;
    const firstLeaseId = firstLeaseResult.value.id;

    // Advance clock past the lease expiry
    clockTime = new Date("2026-01-01T01:00:00.000Z");

    // Now resume — the expired lease should be replaced
    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-resume-new",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // The new lease ID should differ from the first
    expect(result.value.leaseId).not.toBe(firstLeaseId);
  });

  it("returns typed lease_conflict error for unexpired foreign lease", async () => {
    const store = createInMemoryRuntimeStore();

    // Pre-create a workflow instance
    const createResult = await store.instances.create({
      workflowName: "conflict-workflow",
      goal: "conflict goal",
      slug: "conflict-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    // Acquire an active lease by another owner
    const firstLeaseResult = await store.leases.acquire({
      workflowInstanceId: instanceId,
      ownerId: "session-foreign-owner" as ReturnType<typeof createOwnerId>,
      ttlMs: 3_600_000, // 1 hour — unexpired
    });
    expect(firstLeaseResult.isOk()).toBe(true);
    if (!firstLeaseResult.isOk()) return;
    const foreignLeaseId = firstLeaseResult.value.id;

    // Attempt to resume — should fail with lease_conflict
    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-new-owner",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
    if (result.error.type === "lease_conflict") {
      expect(result.error.workflowInstanceId).toBe(instanceId);
      expect(result.error.conflictingLeaseId).toBe(foreignLeaseId);
    }
  });

  it("returns not_found error when workflow instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("non-existent-wf-id");

    const result = await resumeExecution(
      {
        workflowInstanceId: nonExistentId,
        ownerId: "session-not-found",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
      expect(result.error.id).toBe(nonExistentId);
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await resumeExecution(
      {
        workflowInstanceId: "" as typeof wfId,
        ownerId: "session-resume",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("returns validation error for missing ownerId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await resumeExecution(
      {
        workflowInstanceId: wfId,
        ownerId: "",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — handleUserInterrupt
// ---------------------------------------------------------------------------

describe("handleUserInterrupt (Runtime Store)", () => {
  /**
   * Helper: start an execution for a new workflow instance and return both
   * the instance ID and the acquired lease ID.
   */
  async function startInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`interrupt-wf-${suffix}`);
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: `owner-${suffix}` },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  it("pause signal: updates instance to paused status, returns PauseExecutionEffect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "pause");

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("pause-execution");
    if (effects[0]?.kind === "pause-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }

    // Verify instance is paused
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("cancel signal: updates instance to cancelled status, returns CompleteExecutionEffect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "cancel");

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        signal: "cancel",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("complete-execution");
    if (effects[0]?.kind === "complete-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }

    // Verify instance is cancelled
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("cancelled");
  });

  it("pause does NOT set completedAt — preserves resumability", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(
      store,
      "pause-no-complete",
    );

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isOk()).toBe(true);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    // paused is not a terminal status — completedAt must not be set
    expect(instanceResult.value.completedAt).toBeUndefined();
  });

  it("returns not_found for missing instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Acquire a lease bound directly to the non-existent instance ID so the
    // workflowInstanceId binding check passes and the not_found check fires.
    const nonExistentId = createWorkflowInstanceId("non-existent-interrupt-id");
    const leaseResult = await store.leases.acquire({
      workflowInstanceId: nonExistentId,
      ownerId: createOwnerId("owner-not-found-setup"),
      ttlMs: 3_600_000,
    });
    if (!leaseResult.isOk()) throw new Error("lease acquire failed");
    const boundLeaseId = leaseResult.value.id;

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: nonExistentId,
        leaseId: boundLeaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
      expect(result.error.id).toBe(nonExistentId);
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await handleUserInterrupt(
      {
        workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
        leaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for missing leaseId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await handleUserInterrupt(
      {
        workflowInstanceId: wfId,
        leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
        signal: "cancel",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("returns lease_conflict when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId } = await startInstance(store, "lease-conflict");
    const fakeLeaseId = createExecutionLeaseId(
      "fake-lease-id-that-does-not-match",
    );

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceId,
        leaseId: fakeLeaseId,
        signal: "pause",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns lease_conflict when lease belongs to a different workflow instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Start two separate workflow instances
    const { instanceId: instanceA, activeLeaseId: leaseA } =
      await startInstance(store, "cross-wf-a");
    const instanceB = createWorkflowInstanceId("interrupt-wf-cross-wf-b");
    // instanceB is not started — we just want to use leaseA with instanceB's ID
    // (leaseA is bound to instanceA)
    void instanceA; // used to acquire leaseA

    const result = await handleUserInterrupt(
      {
        workflowInstanceId: instanceB,
        leaseId: leaseA,
        signal: "pause",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — dispatchStep
// ---------------------------------------------------------------------------

describe("dispatchStep (Runtime Store)", () => {
  /**
   * Helper: start an execution for a new workflow instance and return both
   * the instance ID and the acquired lease ID.
   */
  async function startInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`dispatch-wf-${suffix}`);
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: `owner-${suffix}` },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  it("uses explicit stepName from input when provided", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(
      store,
      "explicit",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepName).toBe("implement");
  });

  it("falls back to instance.currentStepName when no stepName in input", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(
      store,
      "fallback",
    );

    // Set currentStepName on the instance
    await store.instances.update(instanceId, { currentStepName: "plan" });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        // no stepName — should fall back to instance.currentStepName
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepName).toBe("plan");
  });

  it("falls back to 'default' when neither input.stepName nor instance.currentStepName is set", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "default");

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepName).toBe("default");
  });

  it("updates currentStepName on the workflow instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "update");

    await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "security-review",
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.currentStepName).toBe("security-review");
  });

  it("returned DispatchAgentEffect has kind: 'dispatch-agent' and runAgent.kind: 'run-agent'", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "effect");

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      expect(effects[0].runAgent.kind).toBe("run-agent");
      expect(effects[0].runAgent.agentName).toBe("plan");
    }
  });

  it("emitted effect contains no raw prompts, credentials, or tokens (composedPrompt === '')", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(
      store,
      "security",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // Security invariant: composedPrompt must be empty string for MVP dispatch
      expect(effects[0].runAgent.agentDescriptor.composedPrompt).toBe("");
      // No credentials or tokens in resolvedSkills
      expect(effects[0].runAgent.resolvedSkills).toHaveLength(0);
    }
  });

  it("returns not_found for missing instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Acquire a lease bound directly to the non-existent instance ID so the
    // workflowInstanceId binding check passes and the not_found check fires.
    const nonExistentId = createWorkflowInstanceId("non-existent-dispatch-id");
    const leaseResult = await store.leases.acquire({
      workflowInstanceId: nonExistentId,
      ownerId: createOwnerId("owner-not-found-setup"),
      ttlMs: 3_600_000,
    });
    if (!leaseResult.isOk()) throw new Error("lease acquire failed");
    const boundLeaseId = leaseResult.value.id;

    const result = await dispatchStep(
      {
        workflowInstanceId: nonExistentId,
        leaseId: boundLeaseId,
        stepName: "plan",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await dispatchStep(
      {
        workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
        leaseId,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for missing leaseId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await dispatchStep(
      {
        workflowInstanceId: wfId,
        leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("returns lease_conflict when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId } = await startInstance(store, "lease-conflict");
    const fakeLeaseId = createExecutionLeaseId(
      "fake-lease-id-that-does-not-match",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: fakeLeaseId,
        stepName: "plan",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns lease_conflict when lease belongs to a different workflow instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Start two separate workflow instances
    const { instanceId: instanceA, activeLeaseId: leaseA } =
      await startInstance(store, "cross-wf-a");
    const instanceB = createWorkflowInstanceId("dispatch-wf-cross-wf-b");
    // instanceB is not started — leaseA is bound to instanceA
    void instanceA;

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceB,
        leaseId: leaseA,
        stepName: "plan",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });
});

// ---------------------------------------------------------------------------
// Runtime Store lifecycle tests — completeStep
// ---------------------------------------------------------------------------

describe("completeStep (Runtime Store)", () => {
  /**
   * Helper: start an execution for a new workflow instance and return both
   * the instance ID and the acquired lease ID.
   */
  async function startInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`complete-wf-${suffix}`);
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: `owner-${suffix}` },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  it("success outcome: updates instance to running status", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "success");

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(0);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  it("blocked outcome: updates instance to blocked status and releases lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "blocked");

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "security-review",
        completionSignal: { outcome: "blocked" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // blocked is terminal — lease is released and complete-execution is emitted.
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("blocked");
  });

  it("failed outcome: updates instance to failed status with errorMessage and releases lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "failed");

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        completionSignal: { outcome: "failed", message: "Build failed" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // failed is terminal — lease is released and complete-execution is emitted.
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("failed");
    expect(instanceResult.value.errorMessage).toBe("Build failed");
    // failed is terminal — completedAt should be set
    expect(instanceResult.value.completedAt).toBeDefined();
  });

  it("paused outcome: updates instance to paused status, returns PauseExecutionEffect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(store, "paused");

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review-plan",
        completionSignal: { outcome: "paused" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("pause-execution");
    if (effects[0]?.kind === "pause-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("artifacts from signal are merged into instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startInstance(
      store,
      "artifacts",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/my-feature.md" },
          ],
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    const artifacts = instanceResult.value.artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("plan_path");
    expect(artifacts[0]?.path).toBe(".weave/plans/my-feature.md");
  });

  it("returns not_found for missing instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Acquire a lease bound directly to the non-existent instance ID so the
    // workflowInstanceId binding check passes and the not_found check fires.
    const nonExistentId = createWorkflowInstanceId("non-existent-complete-id");
    const leaseResult = await store.leases.acquire({
      workflowInstanceId: nonExistentId,
      ownerId: createOwnerId("owner-not-found-setup"),
      ttlMs: 3_600_000,
    });
    if (!leaseResult.isOk()) throw new Error("lease acquire failed");
    const boundLeaseId = leaseResult.value.id;

    const result = await completeStep(
      {
        workflowInstanceId: nonExistentId,
        leaseId: boundLeaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await completeStep(
      {
        workflowInstanceId: "" as ReturnType<typeof createWorkflowInstanceId>,
        leaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for missing leaseId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await completeStep(
      {
        workflowInstanceId: wfId,
        leaseId: "" as ReturnType<typeof createExecutionLeaseId>,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("returns validation error for missing stepName", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await completeStep(
      {
        workflowInstanceId: wfId,
        leaseId,
        stepName: "",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("stepName");
    }
  });

  it("returns lease_conflict when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId } = await startInstance(store, "lease-conflict");
    const fakeLeaseId = createExecutionLeaseId(
      "fake-lease-id-that-does-not-match",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: fakeLeaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns lease_conflict when lease belongs to a different workflow instance", async () => {
    const store = createInMemoryRuntimeStore();
    // Start two separate workflow instances
    const { instanceId: instanceA, activeLeaseId: leaseA } =
      await startInstance(store, "cross-wf-a");
    const instanceB = createWorkflowInstanceId("complete-wf-cross-wf-b");
    // instanceB is not started — leaseA is bound to instanceA
    void instanceA;

    const result = await completeStep(
      {
        workflowInstanceId: instanceB,
        leaseId: leaseA,
        stepName: "plan",
        completionSignal: { outcome: "success" },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });
});

// ---------------------------------------------------------------------------
// beforeTool — policy evaluation
// ---------------------------------------------------------------------------

describe("beforeTool", () => {
  // Helper: build a minimal valid BeforeToolInput
  function makeInput(
    overrides: Partial<BeforeToolInput> = {},
  ): BeforeToolInput {
    return {
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: evaluateEffectiveToolPolicy({
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "deny",
        network: "ask",
      }),
      ...overrides,
    };
  }

  it("allow decision: effectiveToolPolicy.read = 'allow', toolCapability = 'read'", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "read",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ read: "allow" }),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("deny decision: effectiveToolPolicy.write = 'deny', toolCapability = 'write'", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "write",
        toolName: "write_file",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ write: "deny" }),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("deny");
  });

  it("ask decision: effectiveToolPolicy.network = 'ask', toolCapability = 'network'", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "network",
        toolName: "fetch_url",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ network: "ask" }),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("ask");
  });

  it("allow decision for execute capability", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "execute",
        toolName: "run_command",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ execute: "allow" }),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("deny decision for delegate capability", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "delegate",
        toolName: "spawn_subagent",
        effectiveToolPolicy: evaluateEffectiveToolPolicy({ delegate: "deny" }),
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("deny");
  });

  it("unknown capability: returns LifecycleValidationError", async () => {
    const result = await beforeTool(
      makeInput({
        toolCapability: "unknown" as BeforeToolInput["toolCapability"],
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("toolCapability");
    }
  });

  it("missing toolCapability: returns LifecycleValidationError", async () => {
    const input = makeInput();
    // Simulate missing toolCapability at runtime
    const inputWithoutCapability = {
      ...input,
      toolCapability: "" as BeforeToolInput["toolCapability"],
    };
    const result = await beforeTool(inputWithoutCapability);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("toolCapability");
    }
  });

  it("missing workflowInstanceId: returns LifecycleValidationError", async () => {
    const result = await beforeTool(
      makeInput({
        workflowInstanceId: "" as typeof wfId,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("missing leaseId: returns LifecycleValidationError", async () => {
    const result = await beforeTool(
      makeInput({
        leaseId: "" as typeof leaseId,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("output contains only decision and optional reason — no raw tool payload fields", () => {
    // TypeScript structural test: BeforeToolOutput must only have decision and reason.
    // This verifies the type does not accidentally include credential or payload fields.
    const output: BeforeToolOutput = { decision: "allow" };

    // These fields must NOT exist on BeforeToolOutput (compile-time + runtime check)
    expect("token" in output).toBe(false);
    expect("apiKey" in output).toBe(false);
    expect("password" in output).toBe(false);
    expect("secret" in output).toBe(false);
    expect("authorization" in output).toBe(false);
    expect("toolArguments" in output).toBe(false);
    expect("rawPayload" in output).toBe(false);

    // Only decision (and optional reason) are present
    const keys = Object.keys(output);
    expect(keys).toContain("decision");
    for (const key of keys) {
      expect(["decision", "reason"]).toContain(key);
    }
  });

  it("BeforeToolInput does not accept credential fields (structural security test)", () => {
    // Verify that a valid BeforeToolInput object has no credential-named fields.
    // This is a runtime structural check — TypeScript prevents adding extra fields,
    // but we also verify at runtime that no credential keys leak into the input.
    const input: BeforeToolInput = makeInput();

    expect("token" in input).toBe(false);
    expect("apiKey" in input).toBe(false);
    expect("password" in input).toBe(false);
    expect("secret" in input).toBe(false);
    expect("authorization" in input).toBe(false);
    expect("rawPayload" in input).toBe(false);
    expect("toolArguments" in input).toBe(false);
  });

  it("toolName is present in input but engine does not use it for policy (audit-only)", async () => {
    // Two inputs with different toolNames but same capability and policy
    // must produce the same decision — proving toolName is audit-only.
    const policy = evaluateEffectiveToolPolicy({ read: "allow" });

    const result1 = await beforeTool(
      makeInput({
        toolCapability: "read",
        toolName: "read_file",
        effectiveToolPolicy: policy,
      }),
    );
    const result2 = await beforeTool(
      makeInput({
        toolCapability: "read",
        toolName: "some_other_harness_read_tool",
        effectiveToolPolicy: policy,
      }),
    );

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);
    if (!result1.isOk() || !result2.isOk()) return;

    // Same capability + same policy → same decision regardless of toolName
    expect(result1.value.decision).toBe(result2.value.decision);
    expect(result1.value.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// sanitizeMetadata — runtime enforcement tests
// ---------------------------------------------------------------------------

describe("sanitizeMetadata", () => {
  it("sanitizeMetadata: rejects token key", () => {
    const result = sanitizeMetadata({ token: "secret-value" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("token");
    expect(result.error.field).toBe("metadata");
  });

  it("sanitizeMetadata: rejects authHeader key (case-insensitive)", () => {
    const result = sanitizeMetadata({ authHeader: "Bearer xyz" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("authHeader");
  });

  it("sanitizeMetadata: rejects jwt key", () => {
    const result = sanitizeMetadata({ jwt: "eyJhbGciOiJIUzI1NiJ9" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("jwt");
  });

  it("sanitizeMetadata: rejects apiKey key (case-insensitive)", () => {
    const result = sanitizeMetadata({ apiKey: "sk-abc123" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("apiKey");
  });

  it("sanitizeMetadata: rejects password key", () => {
    const result = sanitizeMetadata({ password: "hunter2" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("password");
  });

  it("sanitizeMetadata: rejects sessionId key", () => {
    const result = sanitizeMetadata({ sessionId: "sess-abc" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("sessionId");
  });

  it("sanitizeMetadata: rejects cookie key", () => {
    const result = sanitizeMetadata({ cookie: "session=abc" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("cookie");
  });

  it("sanitizeMetadata: accepts safe metadata", () => {
    const meta: SafeMetadata = {
      agentName: "loom",
      stepIndex: 1,
      isRetry: false,
      modelId: "claude-sonnet-4-5",
    };
    const result = sanitizeMetadata(meta);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual(meta);
  });

  it("sanitizeMetadata: accepts empty metadata", () => {
    const result = sanitizeMetadata({});
    expect(result.isOk()).toBe(true);
  });

  it("sanitizeMetadata: case-insensitive check — AUTH_HEADER rejected", () => {
    const result = sanitizeMetadata({ AUTH_HEADER: "Bearer xyz" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("sanitizeMetadata: case-insensitive check — TOKEN rejected", () => {
    const result = sanitizeMetadata({ TOKEN: "abc" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  // New tests for extended denylist — raw prompt/completion/transcript keys
  it("sanitizeMetadata: rejects prompt key", () => {
    const result = sanitizeMetadata({ prompt: "You are a helpful assistant." });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("prompt");
  });

  it("sanitizeMetadata: rejects completion key", () => {
    const result = sanitizeMetadata({ completion: "Here is my answer." });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("completion");
  });

  it("sanitizeMetadata: rejects transcript key", () => {
    const result = sanitizeMetadata({
      transcript: "User: hello\nAssistant: hi",
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("transcript");
  });

  it("sanitizeMetadata: rejects accessToken key (case-insensitive)", () => {
    const result = sanitizeMetadata({ accessToken: "eyJhbGci..." });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("accessToken");
  });

  it("sanitizeMetadata: rejects refreshToken key", () => {
    const result = sanitizeMetadata({ refreshToken: "rt-abc123" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("refreshToken");
  });

  it("sanitizeMetadata: rejects privateKey key", () => {
    const result = sanitizeMetadata({
      privateKey: "-----BEGIN RSA PRIVATE KEY-----",
    });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    expect(result.error.message).toContain("privateKey");
  });

  it("sanitizeMetadata: accepts safe keys like stepName, duration, retryCount", () => {
    const meta: SafeMetadata = {
      stepName: "implement",
      duration: 1234,
      retryCount: 0,
    };
    const result = sanitizeMetadata(meta);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value).toEqual(meta);
  });
});

// ---------------------------------------------------------------------------
// observeSession — metadata sanitization integration
// ---------------------------------------------------------------------------

describe("observeSession: metadata sanitization", () => {
  it("observeSession: returns validation error when metadata contains token key", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { token: "secret-token" } as SafeMetadata,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.message).toContain("token");
      expect(result.error.field).toBe("metadata");
    }
  });

  it("observeSession: returns validation error when metadata contains jwt key", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { jwt: "eyJhbGciOiJIUzI1NiJ9" } as SafeMetadata,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// beforeTool — metadata sanitization integration
// ---------------------------------------------------------------------------

describe("beforeTool: metadata sanitization", () => {
  function makeBeforeToolInput(
    overrides: Partial<BeforeToolInput> = {},
  ): BeforeToolInput {
    return {
      workflowInstanceId: wfId,
      leaseId,
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: evaluateEffectiveToolPolicy({
        read: "allow",
        write: "deny",
        execute: "ask",
        delegate: "deny",
        network: "ask",
      }),
      ...overrides,
    };
  }

  it("beforeTool: returns validation error when metadata contains password key", async () => {
    const result = await beforeTool(
      makeBeforeToolInput({
        metadata: { password: "hunter2" } as SafeMetadata,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.message).toContain("password");
      expect(result.error.field).toBe("metadata");
    }
  });

  it("beforeTool: returns validation error when metadata contains apiToken key", async () => {
    const result = await beforeTool(
      makeBeforeToolInput({
        metadata: { apiToken: "sk-abc" } as SafeMetadata,
      }),
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });

  it("beforeTool: proceeds normally with safe metadata", async () => {
    const result = await beforeTool(
      makeBeforeToolInput({
        metadata: { filePath: "src/index.ts", attempt: 1 },
      }),
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// LifecyclePersistenceError.cause — narrowed type test
// ---------------------------------------------------------------------------

describe("LifecyclePersistenceError.cause narrowed type", () => {
  it("LifecyclePersistenceError.cause is narrowed to safe type (no raw store internals)", () => {
    // The cause must only carry { type, message } — no SQL, file paths, or stack traces.
    const cause = { type: "query" as const, message: "DB write failed" };
    const e = lifecyclePersistenceError("Store write failed", cause);

    expect(e.type).toBe("persistence");
    expect(e.cause).toBeDefined();
    if (!e.cause) return;

    // Only type and message are present — no raw store internals
    const causeKeys = Object.keys(e.cause);
    expect(causeKeys).toContain("type");
    expect(causeKeys).toContain("message");
    // Verify no extra fields that could carry SQL or file paths
    for (const key of causeKeys) {
      expect(["type", "message"]).toContain(key);
    }

    expect(e.cause.type).toBe("query");
    expect(e.cause.message).toBe("DB write failed");
  });

  it("LifecyclePersistenceError.cause is undefined when not provided", () => {
    const e = lifecyclePersistenceError("Store write failed");
    expect(e.cause).toBeUndefined();
  });

  it("persistence error from observeSession store failure has narrowed cause", async () => {
    const store = createInMemoryRuntimeStore({
      failOn: { snapshotRecord: queryError("injected snapshot failure") },
    });
    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");

    if (result.error.type === "persistence") {
      // cause must be narrowed — only type and message
      if (result.error.cause !== undefined) {
        const causeKeys = Object.keys(result.error.cause);
        for (const key of causeKeys) {
          expect(["type", "message"]).toContain(key);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// startExecution — WorkflowExecutionContext validation and instance init
// ---------------------------------------------------------------------------

describe("startExecution: WorkflowExecutionContext", () => {
  /**
   * Minimal workflow fixture with two steps.
   * Compatible with WeaveConfig["workflows"] value type.
   */
  const twoStepWorkflow: WorkflowExecutionContext["workflows"][string] = {
    version: 1,
    steps: [
      {
        name: "plan",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Create a plan",
        completion: { method: "agent_signal" },
      },
      {
        name: "implement",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Implement the plan",
        completion: { method: "agent_signal" },
      },
    ],
  };

  const singleStepWorkflow: WorkflowExecutionContext["workflows"][string] = {
    version: 1,
    steps: [
      {
        name: "fix",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Fix the bug",
        completion: { method: "agent_signal" },
      },
    ],
  };

  const knownWorkflows: WorkflowExecutionContext["workflows"] = {
    "my-feature": twoStepWorkflow,
    "quick-fix": singleStepWorkflow,
  };

  // ---------------------------------------------------------------------------
  // AC1: unknown workflow name → not_found error before any instance creation
  // ---------------------------------------------------------------------------

  it("returns not_found error for unknown workflowName — no instance created", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-unknown-wf-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-001",
        context: {
          workflowName: "does-not-exist",
          goal: "do something",
          slug: "do-something",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("workflow");
      expect(result.error.id).toBe("does-not-exist");
    }

    // No instance should have been created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value).toBeNull();
  });

  it("returns validation error for empty workflowName in context", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-empty-wf-name-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-002",
        context: {
          workflowName: "",
          goal: "do something",
          slug: "do-something",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("context.workflowName");
    }

    // No instance should have been created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC2: valid workflow → instance with correct workflowName, goal, slug, currentStepName
  // ---------------------------------------------------------------------------

  it("creates WorkflowInstance with correct workflowName, goal, slug, and currentStepName", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-valid-wf-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-003",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode support",
          slug: "add-dark-mode-support",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Verify the instance was created with the correct fields
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;

    const instance = instanceResult.value;
    expect(instance.workflowName).toBe("my-feature");
    expect(instance.goal).toBe("Add dark mode support");
    expect(instance.slug).toBe("add-dark-mode-support");
    expect(instance.status).toBe("running");
  });

  // ---------------------------------------------------------------------------
  // AC2 (first-step): currentStepName is set to the first step name
  // ---------------------------------------------------------------------------

  it("sets currentStepName to the first step of the workflow", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-first-step-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-004",
        context: {
          workflowName: "my-feature",
          goal: "Implement feature X",
          slug: "implement-feature-x",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;

    // "my-feature" workflow has "plan" as first step
    expect(instanceResult.value.currentStepName).toBe("plan");
  });

  it("sets currentStepName to the single step for a single-step workflow", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-single-step-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-005",
        context: {
          workflowName: "quick-fix",
          goal: "Fix the null pointer bug",
          slug: "fix-null-pointer-bug",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;

    // "quick-fix" workflow has "fix" as its only step
    expect(instanceResult.value.currentStepName).toBe("fix");
  });

  // ---------------------------------------------------------------------------
  // AC2 (lease): ExecutionLease is acquired on success
  // ---------------------------------------------------------------------------

  it("acquires an ExecutionLease on successful start with context", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-lease-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-006",
        context: {
          workflowName: "my-feature",
          goal: "Build the thing",
          slug: "build-the-thing",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { leaseId: acquiredLeaseId } = result.value;
    expect(typeof acquiredLeaseId).toBe("string");
    expect(acquiredLeaseId.length).toBeGreaterThan(0);

    // Verify the lease is active and bound to the correct instance
    const leaseResult = await store.leases.getById(acquiredLeaseId);
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value.workflowInstanceId).toBe(instanceId);
  });

  // ---------------------------------------------------------------------------
  // AC3: single-active-execution invariant — second call returns lease_conflict
  // ---------------------------------------------------------------------------

  it("returns lease_conflict when a second startExecution is called while a lease is active", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("ctx-lease-conflict-001");

    // First call — should succeed and acquire a lease
    const firstResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-first",
        context: {
          workflowName: "my-feature",
          goal: "First execution",
          slug: "first-execution",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(firstResult.isOk()).toBe(true);
    if (!firstResult.isOk()) return;
    const firstLeaseId = firstResult.value.leaseId;

    // Second call — same instance, different owner, lease still active
    const secondResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-ctx-second",
        context: {
          workflowName: "my-feature",
          goal: "Second execution attempt",
          slug: "second-execution-attempt",
          workflows: knownWorkflows,
        },
      },
      store,
    );

    expect(secondResult.isErr()).toBe(true);
    if (!secondResult.isErr()) return;
    expect(secondResult.error.type).toBe("lease_conflict");
    if (secondResult.error.type === "lease_conflict") {
      expect(secondResult.error.workflowInstanceId).toBe(instanceId);
      expect(secondResult.error.conflictingLeaseId).toBe(firstLeaseId);
    }
  });

  it("returns lease_conflict on second call even without context (legacy path)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId(
      "ctx-lease-conflict-legacy-001",
    );

    // First call acquires a lease
    const firstResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "session-legacy-first" },
      store,
    );
    expect(firstResult.isOk()).toBe(true);

    // Second call — no context, same instance, lease still active
    const secondResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "session-legacy-second" },
      store,
    );

    expect(secondResult.isErr()).toBe(true);
    if (!secondResult.isErr()) return;
    expect(secondResult.error.type).toBe("lease_conflict");
  });

  // ---------------------------------------------------------------------------
  // WorkflowExecutionContext type is importable from @weaveio/weave-engine
  // ---------------------------------------------------------------------------

  it("WorkflowExecutionContext type is importable and structurally correct", () => {
    const ctx: WorkflowExecutionContext = {
      workflowName: "my-feature",
      goal: "Test goal",
      slug: "test-goal",
      workflows: knownWorkflows,
    };
    expect(ctx.workflowName).toBe("my-feature");
    expect(ctx.goal).toBe("Test goal");
    expect(ctx.slug).toBe("test-goal");
    expect(Object.keys(ctx.workflows)).toContain("my-feature");
  });

  // ---------------------------------------------------------------------------
  // Legacy path: no context → workflowInstanceId used as placeholder (backward compat)
  // ---------------------------------------------------------------------------

  it("without context: workflowName, goal, slug all equal workflowInstanceId (legacy)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("legacy-placeholder-001");

    const result = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "session-legacy" },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;

    const instance = instanceResult.value;
    expect(instance.workflowName).toBe(instanceId);
    expect(instance.goal).toBe(instanceId);
    expect(instance.slug).toBe(instanceId);
    // No currentStepName set in legacy path
    expect(instance.currentStepName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dispatchStep — configured workflow step resolution
// ---------------------------------------------------------------------------

describe("dispatchStep: configured workflow step resolution", () => {
  /**
   * Shared workflow fixtures for dispatch tests.
   * The "plan" step uses agent "pattern", "implement" uses "shuttle".
   */
  const dispatchWorkflows: WorkflowExecutionContext["workflows"] = {
    "my-feature": {
      version: 1,
      steps: [
        {
          name: "plan",
          type: "autonomous",
          agent: "pattern",
          prompt:
            "Create a plan for {{instance.goal}} (slug: {{instance.slug}})",
          completion: {
            method: "plan_created",
            plan_name: "{{instance.slug}}",
          },
        },
        {
          name: "implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement the plan at {{artifacts.plan_path}}",
          completion: { method: "agent_signal" },
          inputs: [{ name: "plan_path", description: "Path to the plan file" }],
        },
        {
          name: "review",
          type: "gate",
          agent: "weft",
          prompt: "Review the changes for {{instance.workflowName}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
      ],
    },
    "interactive-flow": {
      version: 1,
      steps: [
        {
          name: "confirm",
          type: "interactive",
          agent: "loom",
          prompt: "Confirm the goal: {{instance.goal}}",
          completion: { method: "user_confirm" },
        },
      ],
    },
  };

  /**
   * Helper: start an execution with workflow context and return instance ID + lease ID.
   */
  async function startWithContext(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
    workflowName = "my-feature",
    goal = "Add dark mode",
    slug = "add-dark-mode",
  ) {
    const instanceId = createWorkflowInstanceId(`cfg-dispatch-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: {
          workflowName,
          goal,
          slug,
          workflows: dispatchWorkflows,
        },
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // ---------------------------------------------------------------------------
  // AC1: step resolution order
  // ---------------------------------------------------------------------------

  it("resolves step by explicit stepName from input", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "resolve-explicit",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepName).toBe("review");
  });

  it("resolves step by instance.currentStepName when no stepName in input", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "resolve-current",
    );

    // Set currentStepName to "implement"
    await store.instances.update(instanceId, { currentStepName: "implement" });

    // Add the required artifact for "implement" step
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/add-dark-mode.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        // no stepName — should use instance.currentStepName
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.stepName).toBe("implement");
  });

  it("resolves to first step when neither stepName nor currentStepName is set", async () => {
    const store = createInMemoryRuntimeStore();
    // Create instance with context so workflowName is correctly set on the instance.
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "first-step",
    );

    // Clear currentStepName to simulate a fresh dispatch with no current step.
    await store.instances.update(instanceId, { currentStepName: null });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // First step of "my-feature" is "plan"
    expect(result.value.stepName).toBe("plan");
  });

  // ---------------------------------------------------------------------------
  // AC1: not_found when step doesn't exist in workflow config
  // ---------------------------------------------------------------------------

  it("returns not_found when step name does not exist in workflow config", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "missing-step",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "nonexistent-step",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowStep");
      expect(result.error.id).toBe("nonexistent-step");
    }
  });

  // ---------------------------------------------------------------------------
  // AC2: uses step.agent (not step name) as agent name
  // ---------------------------------------------------------------------------

  it("uses step.agent as agentName in emitted effect (not step name)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "agent-name",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      // "plan" step has agent "pattern" — NOT "plan"
      expect(effects[0].runAgent.agentName).toBe("pattern");
      expect(effects[0].runAgent.agentDescriptor.name).toBe("pattern");
    }
  });

  it("uses step.agent 'shuttle' for implement step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "agent-shuttle",
    );

    // Add required artifact
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/add-dark-mode.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      expect(effects[0].runAgent.agentName).toBe("shuttle");
    }
  });

  // ---------------------------------------------------------------------------
  // AC3: prompt rendering with instance context and artifact references
  // ---------------------------------------------------------------------------

  it("renders step.prompt with {{instance.goal}} and {{instance.slug}}", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "prompt-render",
      "my-feature",
      "Add dark mode support",
      "add-dark-mode-support",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode support",
          slug: "add-dark-mode-support",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // promptMetadata must be present and have a positive byteLength
      // (the rendered prompt "Create a plan for Add dark mode support (slug: add-dark-mode-support)"
      //  is non-empty)
      expect(effects[0].runAgent.promptMetadata).toBeDefined();
      const pm = effects[0].runAgent.promptMetadata as PromptMetadata;
      expect(pm.byteLength).toBeGreaterThan(0);
    }
  });

  it("renders step.prompt with {{artifacts.plan_path}} artifact reference", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "prompt-artifact",
    );

    // Add the artifact that the "implement" step references
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/add-dark-mode.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // The rendered prompt "Implement the plan at .weave/plans/add-dark-mode.md"
      // is non-empty — promptMetadata.byteLength reflects this
      expect(effects[0].runAgent.promptMetadata).toBeDefined();
      const pm = effects[0].runAgent.promptMetadata as PromptMetadata;
      expect(pm.byteLength).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // AC4: missing required input artifact → not_found error before dispatch
  // ---------------------------------------------------------------------------

  it("returns not_found error when required input artifact is missing", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "missing-artifact",
    );

    // "implement" step requires "plan_path" artifact — do NOT add it

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("artifact");
      expect(result.error.id).toBe("plan_path");
    }
  });

  it("succeeds when all required input artifacts are present", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "all-artifacts-present",
    );

    // Add the required artifact
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/add-dark-mode.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC5: emitted effect contains completionMethod, stepType, correlationId,
  //       promptMetadata — NO concrete harness tool names, NO session mutations
  // ---------------------------------------------------------------------------

  it("emitted effect carries completionMethod from step.completion.method", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "completion-method",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // "plan" step has completion method "plan_created"
      expect(effects[0].runAgent.completionMethod).toBe("plan_created");
    }
  });

  it("emitted effect carries stepType from step.type", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "step-type",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // "review" step has type "gate"
      expect(effects[0].runAgent.stepType).toBe("gate");
    }
  });

  it("emitted effect carries a correlationId (UUID format)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "correlation-id",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      const { correlationId } = effects[0].runAgent;
      expect(typeof correlationId).toBe("string");
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("each dispatch generates a unique correlationId", async () => {
    // Use two independent stores so each has its own active lease
    const store1 = createInMemoryRuntimeStore();
    const { instanceId: instanceId1, activeLeaseId: leaseId1 } =
      await startWithContext(store1, "unique-correlation-a");

    const store2 = createInMemoryRuntimeStore();
    const { instanceId: instanceId2, activeLeaseId: leaseId2 } =
      await startWithContext(store2, "unique-correlation-b");

    const result1 = await dispatchStep(
      {
        workflowInstanceId: instanceId1,
        leaseId: leaseId1,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store1,
    );

    const result2 = await dispatchStep(
      {
        workflowInstanceId: instanceId2,
        leaseId: leaseId2,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store2,
    );

    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);
    if (!result1.isOk() || !result2.isOk()) return;

    const id1 =
      result1.value.effects[0]?.kind === "dispatch-agent"
        ? result1.value.effects[0].runAgent.correlationId
        : undefined;
    const id2 =
      result2.value.effects[0]?.kind === "dispatch-agent"
        ? result2.value.effects[0].runAgent.correlationId
        : undefined;

    expect(id1).toBeDefined();
    expect(id2).toBeDefined();
    expect(id1).not.toBe(id2);
  });

  it("composedPrompt is always empty string — no raw prompt in effect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "no-raw-prompt",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // Security invariant: composedPrompt must never contain raw prompt text
      expect(effects[0].runAgent.agentDescriptor.composedPrompt).toBe("");
    }
  });

  it("effect contains no concrete harness tool names or session data", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "no-harness-data",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Add dark mode",
          slug: "add-dark-mode",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      const { runAgent } = effects[0];
      // No harness-specific tool names
      expect("toolName" in runAgent).toBe(false);
      expect("harnessToolName" in runAgent).toBe(false);
      expect("sessionId" in runAgent).toBe(false);
      expect("token" in runAgent).toBe(false);
      expect("apiKey" in runAgent).toBe(false);
      // resolvedSkills contains only names (empty for MVP dispatch)
      expect(runAgent.resolvedSkills).toHaveLength(0);
      // agentDescriptor has no harness-private fields
      expect("promptFilePath" in runAgent.agentDescriptor).toBe(false);
    }
  });

  it("promptMetadata carries byteLength but not raw prompt text", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "prompt-metadata-shape",
      "my-feature",
      "Build the feature",
      "build-the-feature",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "my-feature",
          goal: "Build the feature",
          slug: "build-the-feature",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      const pm = effects[0].runAgent.promptMetadata;
      expect(pm).toBeDefined();
      if (!pm) return;

      // Only byteLength is present — no raw text
      const pmKeys = Object.keys(pm);
      expect(pmKeys).toContain("byteLength");
      expect(pmKeys).not.toContain("text");
      expect(pmKeys).not.toContain("content");
      expect(pmKeys).not.toContain("prompt");
      expect(pm.byteLength).toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Interactive and gate step types
  // ---------------------------------------------------------------------------

  it("interactive step: stepType is 'interactive'", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithContext(
      store,
      "interactive-type",
      "interactive-flow",
      "Confirm the plan",
      "confirm-the-plan",
    );

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "confirm",
        context: {
          workflowName: "interactive-flow",
          goal: "Confirm the plan",
          slug: "confirm-the-plan",
          workflows: dispatchWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      expect(effects[0].runAgent.stepType).toBe("interactive");
      expect(effects[0].runAgent.completionMethod).toBe("user_confirm");
    }
  });

  // ---------------------------------------------------------------------------
  // PromptMetadata type is importable from @weaveio/weave-engine
  // ---------------------------------------------------------------------------

  it("PromptMetadata type is importable and structurally correct", () => {
    const pm: PromptMetadata = { byteLength: 42 };
    expect(pm.byteLength).toBe(42);
    // Only byteLength field
    expect(Object.keys(pm)).toEqual(["byteLength"]);
  });
});

// ---------------------------------------------------------------------------
// completeStep — configured workflow step auto-advance
// ---------------------------------------------------------------------------

describe("completeStep: configured workflow step auto-advance", () => {
  /**
   * Workflow fixture: 3 steps.
   * - "plan" outputs "plan_path" (agent_signal — no file check needed)
   * - "implement" inputs "plan_path", outputs "build_output"
   * - "review" is the final step (agent_signal — no gate approval needed)
   *
   * Uses agent_signal throughout so tests focus on auto-advance mechanics
   * without needing real plan files or gate approval fields.
   * Gate/plan_created/plan_complete logic is tested in the method-validation suite.
   */
  const threeStepWorkflow: WorkflowExecutionContext["workflows"][string] = {
    version: 1,
    steps: [
      {
        name: "plan",
        type: "autonomous",
        agent: "pattern",
        prompt: "Create a plan for {{instance.goal}}",
        completion: { method: "agent_signal" },
        outputs: [{ name: "plan_path", description: "Path to the plan file" }],
      },
      {
        name: "implement",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Implement the plan at {{artifacts.plan_path}}",
        completion: { method: "agent_signal" },
        inputs: [{ name: "plan_path", description: "Path to the plan file" }],
        outputs: [{ name: "build_output", description: "Build output path" }],
      },
      {
        name: "review",
        type: "autonomous",
        agent: "weft",
        prompt: "Review changes for {{instance.workflowName}}",
        completion: { method: "agent_signal" },
      },
    ],
  };

  const singleStepWorkflow: WorkflowExecutionContext["workflows"][string] = {
    version: 1,
    steps: [
      {
        name: "fix",
        type: "autonomous",
        agent: "shuttle",
        prompt: "Fix the bug",
        completion: { method: "agent_signal" },
      },
    ],
  };

  const completeWorkflows: WorkflowExecutionContext["workflows"] = {
    "three-step": threeStepWorkflow,
    "single-step": singleStepWorkflow,
  };

  /**
   * Helper: start an execution with workflow context.
   */
  async function startWithCtx(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
    workflowName = "three-step",
    goal = "Build feature",
    slug = "build-feature",
  ) {
    const instanceId = createWorkflowInstanceId(`cs-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: { workflowName, goal, slug, workflows: completeWorkflows },
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // ---------------------------------------------------------------------------
  // AC1: non-final step — persists artifacts and emits dispatch-agent
  // ---------------------------------------------------------------------------

  it("non-final step: emits dispatch-agent effect for next step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "non-final",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/build-feature.md" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      // Next step is "implement" with agent "shuttle"
      expect(effects[0].runAgent.agentName).toBe("shuttle");
      expect(effects[0].runAgent.stepType).toBe("autonomous");
      expect(effects[0].runAgent.completionMethod).toBe("agent_signal");
    }
  });

  it("non-final step: persists output artifacts in instance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "persist-artifacts",
    );

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/build-feature.md" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;

    const { artifacts } = instanceResult.value;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("plan_path");
    expect(artifacts[0]?.path).toBe(".weave/plans/build-feature.md");
  });

  it("non-final step: updates currentStepName to next step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "advance-step",
    );

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/build-feature.md" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.currentStepName).toBe("implement");
  });

  it("non-final step: instance status remains running after auto-advance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "status-running",
    );

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/build-feature.md" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  // ---------------------------------------------------------------------------
  // AC2: undeclared output artifact → validation error, no partial writes
  // ---------------------------------------------------------------------------

  it("undeclared output artifact returns validation error before any writes", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "undeclared-artifact",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            // "plan_path" is declared; "secret_key" is NOT declared.
            // With the new validation, the error fires for the undeclared name.
            { name: "secret_key", path: "/etc/secret" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completionSignal.artifacts");
      // The new validation checks declared outputs first (missing "plan_path"),
      // then undeclared names. Either way the error is a validation error on
      // the artifacts field.
    }

    // No artifacts should have been persisted
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.artifacts).toHaveLength(0);
  });

  it("step with no declared outputs accepts any artifacts (no restriction)", async () => {
    // "review" step has no outputs declared — any artifact should be accepted
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "no-outputs-declared",
    );

    // Manually set currentStepName to "review" (the final step)
    await store.instances.update(instanceId, { currentStepName: "review" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        completionSignal: {
          outcome: "success",
          artifacts: [{ name: "any_artifact", path: "/some/path" }],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC3: final step — completed status, lease released, complete-execution effect
  // ---------------------------------------------------------------------------

  it("final step: emits complete-execution effect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "final-step-effect",
    );

    // Set currentStepName to "review" (the final step)
    await store.instances.update(instanceId, { currentStepName: "review" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("complete-execution");
    if (effects[0]?.kind === "complete-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }
  });

  it("final step: transitions instance to completed status", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "final-step-status",
    );

    await store.instances.update(instanceId, { currentStepName: "review" });

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("completed");
  });

  it("final step: releases the active lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "final-step-lease",
    );

    await store.instances.update(instanceId, { currentStepName: "review" });

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "review",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    // After final step, no active lease should exist
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });

  it("single-step workflow: final step completes immediately", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "single-step-complete",
      "single-step",
      "Fix the bug",
      "fix-the-bug",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "fix",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "single-step",
          goal: "Fix the bug",
          slug: "fix-the-bug",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("complete-execution");

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("completed");
  });

  // ---------------------------------------------------------------------------
  // Legacy path: no context → existing behavior preserved
  // ---------------------------------------------------------------------------

  it("without context: success outcome keeps instance running, no auto-advance", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("cs-legacy-success");
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-legacy" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: startResult.value.leaseId,
        stepName: "plan",
        completionSignal: { outcome: "success" },
        // no context
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Legacy: no auto-advance effects
    expect(result.value.effects).toHaveLength(0);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
  });

  it("without context: paused outcome emits pause-execution effect", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("cs-legacy-paused");
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-legacy-paused" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: startResult.value.leaseId,
        stepName: "review",
        completionSignal: { outcome: "paused" },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
  });

  // ---------------------------------------------------------------------------
  // Auto-advance: next step's dispatch-agent effect uses persisted artifacts
  // ---------------------------------------------------------------------------

  it("auto-advance dispatch-agent effect has promptMetadata reflecting artifact in prompt", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "prompt-with-artifact",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        completionSignal: {
          outcome: "success",
          artifacts: [
            { name: "plan_path", path: ".weave/plans/build-feature.md" },
          ],
        },
        context: {
          workflowName: "three-step",
          goal: "Build feature",
          slug: "build-feature",
          workflows: completeWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    if (effects[0]?.kind === "dispatch-agent") {
      // The "implement" step prompt is "Implement the plan at {{artifacts.plan_path}}"
      // which renders to "Implement the plan at .weave/plans/build-feature.md"
      // promptMetadata.byteLength must reflect the rendered content
      expect(effects[0].runAgent.promptMetadata).toBeDefined();
      const pm = effects[0].runAgent.promptMetadata;
      if (pm) {
        expect(pm.byteLength).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// completeStep — completion method validation and gate logic
// ---------------------------------------------------------------------------

describe("completeStep: completion method validation and gate logic", () => {
  /**
   * Workflow fixture covering all 5 completion methods and gate rejection policies.
   */
  const methodWorkflows: WorkflowExecutionContext["workflows"] = {
    "method-test": {
      version: 1,
      steps: [
        {
          name: "agent-step",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Do the work",
          completion: { method: "agent_signal" },
        },
        {
          name: "confirm-step",
          type: "interactive",
          agent: "loom",
          prompt: "Confirm the plan",
          completion: { method: "user_confirm" },
        },
        {
          name: "gate-pause",
          type: "gate",
          agent: "weft",
          prompt: "Review the changes",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
        {
          name: "gate-fail",
          type: "gate",
          agent: "weft",
          prompt: "Security audit",
          completion: { method: "review_verdict" },
          on_reject: "fail",
        },
        {
          name: "gate-retry",
          type: "gate",
          agent: "weft",
          prompt: "Quality check",
          completion: { method: "review_verdict" },
          on_reject: "retry",
        },
        {
          name: "plan-created-step",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create the plan",
          completion: {
            method: "plan_created",
            plan_name: "{{instance.slug}}",
          },
        },
        {
          name: "plan-complete-step",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute the plan",
          completion: {
            method: "plan_complete",
            plan_name: "{{instance.slug}}",
          },
        },
      ],
    },
  };

  /**
   * Helper: start an execution and return instanceId + leaseId.
   */
  async function startForMethod(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
    goal = "Test goal",
    slug = "test-goal",
  ) {
    const instanceId = createWorkflowInstanceId(`method-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: {
          workflowName: "method-test",
          goal,
          slug,
          workflows: methodWorkflows,
        },
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // ---------------------------------------------------------------------------
  // AC1: completion method validation — mismatch returns typed error
  // ---------------------------------------------------------------------------

  it("method mismatch: agent_signal signal on user_confirm step returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "mismatch-agent",
    );

    // Advance currentStepName to "confirm-step" so the step order check passes.
    await store.instances.update(instanceId, {
      currentStepName: "confirm-step",
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "confirm-step",
        completionSignal: {
          outcome: "success",
          method: "agent_signal", // wrong — step declares user_confirm
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completion.method");
      expect(result.error.message).toContain("agent_signal");
      expect(result.error.message).toContain("user_confirm");
    }
  });

  it("method mismatch: review_verdict on agent_signal step returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "mismatch-review",
    );

    // currentStepName is already "agent-step" (first step) — no update needed.

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "agent-step",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completion.method");
    }
  });

  it("no method in signal: skips method validation (legacy path)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "no-method",
    );

    // No method field — should succeed without validation
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "agent-step",
        completionSignal: { outcome: "success" }, // no method
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC1: agent_signal and user_confirm — accepted when matching
  // ---------------------------------------------------------------------------

  it("agent_signal: accepted when step declares agent_signal", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "agent-signal-ok",
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "agent-step",
        completionSignal: { outcome: "success", method: "agent_signal" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Should auto-advance to next step (confirm-step)
    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      expect(effects[0].runAgent.agentName).toBe("loom"); // confirm-step agent
    }
  });

  it("user_confirm: accepted when step declares user_confirm", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "user-confirm-ok",
    );

    // Manually set currentStepName to confirm-step
    await store.instances.update(instanceId, {
      currentStepName: "confirm-step",
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "confirm-step",
        completionSignal: { outcome: "success", method: "user_confirm" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Should auto-advance to gate-pause
    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
  });

  // ---------------------------------------------------------------------------
  // AC4: approved review_verdict gate — advances normally
  // ---------------------------------------------------------------------------

  it("review_verdict approved: advances to next step (same as success)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-approved",
    );

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Should advance to gate-fail (next step)
    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      expect(effects[0].runAgent.agentName).toBe("weft"); // gate-fail agent
    }
  });

  // ---------------------------------------------------------------------------
  // AC5: rejected gate — on_reject: "pause"
  // ---------------------------------------------------------------------------

  it("review_verdict rejected + on_reject:pause → paused status, pause-execution effect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-reject-pause",
    );

    await store.instances.update(instanceId, { currentStepName: "gate-pause" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-pause",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Changes need revision",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("pause-execution");
    if (effects[0]?.kind === "pause-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }

    // Instance should be paused
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  // ---------------------------------------------------------------------------
  // AC5: rejected gate — on_reject: "fail"
  // ---------------------------------------------------------------------------

  it("review_verdict rejected + on_reject:fail → failed status, lease released, complete-execution effect", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-reject-fail",
    );

    await store.instances.update(instanceId, { currentStepName: "gate-fail" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-fail",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Security audit failed",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("complete-execution");
    if (effects[0]?.kind === "complete-execution") {
      expect(effects[0].workflowInstanceId).toBe(instanceId);
    }

    // Instance should be failed
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("failed");

    // Lease should be released
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });

  it("review_verdict rejected + on_reject:fail → errorMessage set from signal.message", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-fail-msg",
    );

    await store.instances.update(instanceId, { currentStepName: "gate-fail" });

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-fail",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Critical security vulnerability found",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.errorMessage).toBe(
      "Critical security vulnerability found",
    );
  });

  // ---------------------------------------------------------------------------
  // AC5: rejected gate — on_reject: "retry"
  // ---------------------------------------------------------------------------

  it("review_verdict rejected + on_reject:retry → dispatch-agent effect for same step", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-reject-retry",
    );

    await store.instances.update(instanceId, {
      currentStepName: "gate-retry",
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-retry",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
          message: "Quality check failed — please revise",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { effects } = result.value;
    expect(effects).toHaveLength(1);
    expect(effects[0]?.kind).toBe("dispatch-agent");
    if (effects[0]?.kind === "dispatch-agent") {
      // Re-dispatches the SAME gate step (gate-retry uses agent "weft")
      expect(effects[0].runAgent.agentName).toBe("weft");
      expect(effects[0].runAgent.stepType).toBe("gate");
      expect(effects[0].runAgent.completionMethod).toBe("review_verdict");
      // Fresh correlation ID
      expect(typeof effects[0].runAgent.correlationId).toBe("string");
      expect(effects[0].runAgent.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("review_verdict rejected + on_reject:retry → instance stays running (not paused/failed)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "gate-retry-status",
    );

    await store.instances.update(instanceId, {
      currentStepName: "gate-retry",
    });

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-retry",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store,
    );

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    // Retry keeps the instance running (re-dispatches same step)
    expect(instanceResult.value.status).toBe("running");
  });

  it("review_verdict rejected + on_reject:retry → each retry has a unique correlationId", async () => {
    const store1 = createInMemoryRuntimeStore();
    const { instanceId: id1, activeLeaseId: lease1 } = await startForMethod(
      store1,
      "retry-unique-a",
    );
    await store1.instances.update(id1, { currentStepName: "gate-retry" });

    const store2 = createInMemoryRuntimeStore();
    const { instanceId: id2, activeLeaseId: lease2 } = await startForMethod(
      store2,
      "retry-unique-b",
    );
    await store2.instances.update(id2, { currentStepName: "gate-retry" });

    const r1 = await completeStep(
      {
        workflowInstanceId: id1,
        leaseId: lease1,
        stepName: "gate-retry",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store1,
    );

    const r2 = await completeStep(
      {
        workflowInstanceId: id2,
        leaseId: lease2,
        stepName: "gate-retry",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: false,
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "test-goal",
          workflows: methodWorkflows,
        },
      },
      store2,
    );

    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
    if (!r1.isOk() || !r2.isOk()) return;

    const cid1 =
      r1.value.effects[0]?.kind === "dispatch-agent"
        ? r1.value.effects[0].runAgent.correlationId
        : undefined;
    const cid2 =
      r2.value.effects[0]?.kind === "dispatch-agent"
        ? r2.value.effects[0].runAgent.correlationId
        : undefined;

    expect(cid1).toBeDefined();
    expect(cid2).toBeDefined();
    expect(cid1).not.toBe(cid2);
  });

  // ---------------------------------------------------------------------------
  // AC2: plan_created — checks plan file exists
  // ---------------------------------------------------------------------------

  it("plan_created: returns not_found when plan file does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "plan-created-missing",
      "Test goal",
      "nonexistent-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-created-step",
    });

    // Provider reports the plan does not exist
    const planStateProvider = new MockPlanStateProvider({
      "nonexistent-plan-slug": false,
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: {
          outcome: "success",
          method: "plan_created",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "nonexistent-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("plan_file");
      expect(result.error.id).toContain("nonexistent-plan-slug");
    }
  });

  it("plan_created: succeeds when plan file exists", async () => {
    const planSlug = `test-plan-created-${Date.now()}`;

    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      `plan-created-ok-${Date.now()}`,
      "Test goal",
      planSlug,
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-created-step",
    });

    // Provider reports the plan exists
    const planStateProvider = new MockPlanStateProvider({ [planSlug]: true });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: {
          outcome: "success",
          method: "plan_created",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: planSlug,
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC3: plan_complete — checks no incomplete checkboxes
  // ---------------------------------------------------------------------------

  it("plan_complete: returns validation error when plan has incomplete checkboxes", async () => {
    const planSlug = `test-plan-incomplete-${Date.now()}`;

    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      `plan-incomplete-${Date.now()}`,
      "Test goal",
      planSlug,
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    // Provider reports the plan is NOT complete (has incomplete checkboxes)
    const planStateProvider = new MockPlanStateProvider(
      {},
      { [planSlug]: false },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: {
          outcome: "success",
          method: "plan_complete",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: planSlug,
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_complete");
      expect(result.error.message).toContain("incomplete");
    }
  });

  it("plan_complete: succeeds when all checkboxes are checked", async () => {
    const planSlug = `test-plan-complete-${Date.now()}`;

    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      `plan-complete-ok-${Date.now()}`,
      "Test goal",
      planSlug,
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    // Provider reports the plan IS complete (all checkboxes checked)
    const planStateProvider = new MockPlanStateProvider(
      {},
      { [planSlug]: true },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: {
          outcome: "success",
          method: "plan_complete",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: planSlug,
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("plan_complete: returns persistence error when provider is unavailable", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "plan-complete-missing",
      "Test goal",
      "no-such-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    // Provider returns ProviderUnavailable (simulates missing file / I/O error)
    const planStateProvider = new MockPlanStateProvider({}, {}, undefined, {
      type: "ProviderUnavailable",
      cause: new Error("file not found"),
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: {
          outcome: "success",
          method: "plan_complete",
        },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "no-such-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });

  // ---------------------------------------------------------------------------
  // StepCompletionSignal type: new fields are importable
  // ---------------------------------------------------------------------------

  it("StepCompletionSignal accepts method and approved fields", () => {
    const agentSignal: StepCompletionSignal = {
      outcome: "success",
      method: "agent_signal",
    };
    expect(agentSignal.method).toBe("agent_signal");

    const reviewApproved: StepCompletionSignal = {
      outcome: "success",
      method: "review_verdict",
      approved: true,
    };
    expect(reviewApproved.approved).toBe(true);

    const reviewRejected: StepCompletionSignal = {
      outcome: "success",
      method: "review_verdict",
      approved: false,
    };
    expect(reviewRejected.approved).toBe(false);

    const planCreated: StepCompletionSignal = {
      outcome: "success",
      method: "plan_created",
    };
    expect(planCreated.method).toBe("plan_created");

    const planComplete: StepCompletionSignal = {
      outcome: "success",
      method: "plan_complete",
    };
    expect(planComplete.method).toBe("plan_complete");
  });

  // ---------------------------------------------------------------------------
  // AC4: absent planStateProvider returns policy_decision error
  // ---------------------------------------------------------------------------

  it("plan_created: absent planStateProvider returns policy_decision error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "absent-provider-created",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-created-step",
    });

    // No planStateProvider supplied
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success", method: "plan_created" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        // planStateProvider intentionally absent
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("plan_state_provider");
    }
  });

  it("plan_complete: absent planStateProvider returns policy_decision error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "absent-provider-complete",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    // No planStateProvider supplied
    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        // planStateProvider intentionally absent
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("plan_state_provider");
    }
  });

  // ---------------------------------------------------------------------------
  // AC5: provider errors are mapped to LifecycleError
  // ---------------------------------------------------------------------------

  it("plan_created: provider returns InvalidPlanName → validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "invalid-name-created",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-created-step",
    });

    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "InvalidPlanName", planName: "some-plan-slug" },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success", method: "plan_created" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
    }
  });

  it("plan_created: provider returns ProviderUnavailable → persistence error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "unavailable-created",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-created-step",
    });

    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "ProviderUnavailable", cause: new Error("disk error") },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success", method: "plan_created" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });

  it("plan_complete: provider returns InvalidPlanName → validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "invalid-name-complete",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    const planStateProvider = new MockPlanStateProvider({}, {}, undefined, {
      type: "InvalidPlanName",
      planName: "some-plan-slug",
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
    }
  });

  it("plan_complete: provider returns ProviderUnavailable → persistence error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startForMethod(
      store,
      "unavailable-complete",
      "Test goal",
      "some-plan-slug",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan-complete-step",
    });

    const planStateProvider = new MockPlanStateProvider({}, {}, undefined, {
      type: "ProviderUnavailable",
      cause: new Error("disk error"),
    });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-complete-step",
        completionSignal: { outcome: "success", method: "plan_complete" },
        context: {
          workflowName: "method-test",
          goal: "Test goal",
          slug: "some-plan-slug",
          workflows: methodWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });
});

// ---------------------------------------------------------------------------
// Security and correctness fixes (Issues 1–4)
// ---------------------------------------------------------------------------

describe("completeStep: blocking issue fixes", () => {
  /**
   * Shared workflow fixture for fix tests.
   * Uses plan_created, plan_complete, review_verdict, and agent_signal steps.
   */
  const fixWorkflows: WorkflowExecutionContext["workflows"] = {
    "fix-test": {
      version: 1,
      steps: [
        {
          name: "plan-created-step",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create the plan",
          completion: {
            method: "plan_created",
            plan_name: "{{instance.slug}}",
          },
        },
        {
          name: "plan-complete-step",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute the plan",
          completion: {
            method: "plan_complete",
            plan_name: "{{instance.slug}}",
          },
        },
        {
          name: "gate-step",
          type: "gate",
          agent: "weft",
          prompt: "Review the work",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
        {
          name: "final-step",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Wrap up",
          completion: { method: "agent_signal" },
          outputs: [{ name: "result", description: "Final result" }],
        },
      ],
    },
  };

  async function startFix(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
    slug = "fix-slug",
  ) {
    const instanceId = createWorkflowInstanceId(`fix-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-fix-${suffix}`,
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug,
          workflows: fixWorkflows,
        },
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // ---------------------------------------------------------------------------
  // Issue 1: plan_created check runs even when signal.method is absent
  // ---------------------------------------------------------------------------

  it("Issue 1: plan_created step without signal.method still runs plan file check", async () => {
    const store = createInMemoryRuntimeStore();
    const slug = `issue1-plan-created-${Date.now()}`;
    const { instanceId, activeLeaseId } = await startFix(store, "i1-pc", slug);

    // currentStepName is "plan-created-step" (first step)
    // Provider reports the plan does NOT exist — the check should fail
    const planStateProvider = new MockPlanStateProvider({ [slug]: false });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: {
          outcome: "success",
          // method is intentionally absent — Issue 1 fix ensures check still runs
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug,
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("plan_file");
    }
  });

  it("Issue 1: plan_created step with signal.method absent succeeds when file exists", async () => {
    const slug = `issue1-plan-ok-${Date.now()}`;

    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(
      store,
      `i1-ok-${Date.now()}`,
      slug,
    );

    // Provider reports the plan exists
    const planStateProvider = new MockPlanStateProvider({ [slug]: true });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" }, // no method
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug,
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("Issue 1: review_verdict step without signal.approved returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i1-rv");

    // Advance to gate-step
    await store.instances.update(instanceId, { currentStepName: "gate-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-step",
        completionSignal: {
          outcome: "success",
          // approved is absent — Issue 1 fix requires it for review_verdict steps
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completionSignal.approved");
      expect(result.error.message).toContain("review_verdict");
    }
  });

  // ---------------------------------------------------------------------------
  // Issue 2: validateOutputArtifacts requires all declared outputs
  // ---------------------------------------------------------------------------

  it("Issue 2: declared output missing from artifacts returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i2-missing");

    // Advance to final-step which declares output "result"
    await store.instances.update(instanceId, { currentStepName: "final-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "final-step",
        completionSignal: {
          outcome: "success",
          // artifacts is absent — "result" is declared but not provided
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completionSignal.artifacts");
      expect(result.error.message).toContain("result");
    }
  });

  it("Issue 2: empty artifacts array when outputs declared returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i2-empty");

    await store.instances.update(instanceId, { currentStepName: "final-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "final-step",
        completionSignal: {
          outcome: "success",
          artifacts: [], // empty — "result" is declared but not provided
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("completionSignal.artifacts");
    }
  });

  it("Issue 2: all declared outputs provided — succeeds", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i2-ok");

    await store.instances.update(instanceId, { currentStepName: "final-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "final-step",
        completionSignal: {
          outcome: "success",
          artifacts: [{ name: "result", path: "/output/result.txt" }],
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("Issue 2: step with no declared outputs accepts any artifacts", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i2-no-decl");

    // gate-step has no declared outputs
    await store.instances.update(instanceId, { currentStepName: "gate-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-step",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
          artifacts: [{ name: "any_artifact", path: "/some/path" }],
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Issue 3: step order validation
  // ---------------------------------------------------------------------------

  it("Issue 3: completing a step that is not currentStepName returns validation error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i3-order");

    // currentStepName is "plan-created-step" (first step)
    // Attempt to complete "final-step" — out of order

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "final-step", // wrong — current is "plan-created-step"
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("stepName");
      expect(result.error.message).toContain("final-step");
      expect(result.error.message).toContain("plan-created-step");
    }
  });

  it("Issue 3: step order check fires before any state mutation", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i3-no-mut");

    // currentStepName is "plan-created-step"
    // Attempt to complete "gate-step" — out of order

    await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "gate-step",
        completionSignal: {
          outcome: "success",
          method: "review_verdict",
          approved: true,
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    // Instance should be unchanged — no status mutation
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("running");
    expect(instanceResult.value.currentStepName).toBe("plan-created-step");
  });

  it("Issue 3: completing the correct currentStepName succeeds", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(store, "i3-correct");

    // Advance to final-step
    await store.instances.update(instanceId, { currentStepName: "final-step" });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "final-step",
        completionSignal: {
          outcome: "success",
          artifacts: [{ name: "result", path: "/output/result.txt" }],
        },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "fix-slug",
          workflows: fixWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Issue 4: path traversal prevention in plan name
  // ---------------------------------------------------------------------------

  it("Issue 4: plan name with ../ is rejected as unsafe", async () => {
    const store = createInMemoryRuntimeStore();
    // Use a slug that renders to a traversal path
    const { instanceId, activeLeaseId } = await startFix(
      store,
      "i4-traversal",
      "../etc/passwd",
    );

    // Provider returns InvalidPlanName for the unsafe slug
    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "InvalidPlanName", planName: "../etc/passwd" },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "../etc/passwd",
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
      expect(result.error.message).toContain("unsafe");
    }
  });

  it("Issue 4: plan name with / is rejected as unsafe", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(
      store,
      "i4-slash",
      "some/path",
    );

    // Provider returns InvalidPlanName for the unsafe slug
    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "InvalidPlanName", planName: "some/path" },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "some/path",
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
    }
  });

  it("Issue 4: plan name with . is rejected as unsafe", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(
      store,
      "i4-dot",
      "plan.name",
    );

    // Provider returns InvalidPlanName for the unsafe slug
    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "InvalidPlanName", planName: "plan.name" },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "plan.name",
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
    }
  });

  it("Issue 4: valid plan name (alphanumeric, hyphens, underscores) passes sanitization", async () => {
    const slug = `valid-plan-name-${Date.now()}`;

    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(
      store,
      `i4-valid-${Date.now()}`,
      slug,
    );

    // Provider reports the plan exists (valid name passes)
    const planStateProvider = new MockPlanStateProvider({ [slug]: true });

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug,
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    // Should pass sanitization and succeed (provider says file exists)
    expect(result.isOk()).toBe(true);
  });

  it("Issue 4: plan name with spaces is rejected as unsafe", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startFix(
      store,
      "i4-spaces",
      "plan name with spaces",
    );

    // Provider returns InvalidPlanName for the unsafe slug
    const planStateProvider = new MockPlanStateProvider(
      {},
      {},
      { type: "InvalidPlanName", planName: "plan name with spaces" },
    );

    const result = await completeStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan-created-step",
        completionSignal: { outcome: "success" },
        context: {
          workflowName: "fix-test",
          goal: "Fix test goal",
          slug: "plan name with spaces",
          workflows: fixWorkflows,
        },
        planStateProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("plan_name");
    }
  });
});

// ---------------------------------------------------------------------------
// Spec 22 Unit 1: ExecutionOperationKind — explicit operations are first-class
// ---------------------------------------------------------------------------

describe("ExecutionOperationKind (Spec 22 Unit 1)", () => {
  it("EXECUTION_OPERATION_KINDS contains all 5 explicit operation kinds", () => {
    expect(EXECUTION_OPERATION_KINDS).toHaveLength(5);
    expect(EXECUTION_OPERATION_KINDS).toContain("start");
    expect(EXECUTION_OPERATION_KINDS).toContain("resume");
    expect(EXECUTION_OPERATION_KINDS).toContain("pause");
    expect(EXECUTION_OPERATION_KINDS).toContain("inspect");
    expect(EXECUTION_OPERATION_KINDS).toContain("advance");
  });

  it("ExecutionOperationKind type covers start, resume, pause, inspect, advance", () => {
    // Type-level check: all 5 variants are assignable to ExecutionOperationKind
    const kinds: ExecutionOperationKind[] = [
      "start",
      "resume",
      "pause",
      "inspect",
      "advance",
    ];
    expect(kinds).toHaveLength(5);
    for (const kind of kinds) {
      expect(EXECUTION_OPERATION_KINDS).toContain(kind);
    }
  });

  it("observeSession is NOT in EXECUTION_OPERATION_KINDS (it is an observation, not an execution op)", () => {
    // observeSession is a passive observation — not an execution operation.
    // This test documents the boundary: calling observeSession never starts execution.
    expect(EXECUTION_OPERATION_KINDS).not.toContain("observe");
    expect(EXECUTION_OPERATION_KINDS).not.toContain("observeSession");
  });

  it("beforeTool is NOT in EXECUTION_OPERATION_KINDS (it is a policy evaluation, not an execution op)", () => {
    expect(EXECUTION_OPERATION_KINDS).not.toContain("beforeTool");
    expect(EXECUTION_OPERATION_KINDS).not.toContain("tool");
  });
});

// ---------------------------------------------------------------------------
// Spec 22 Unit 1: inspectExecution — read-only, no side effects
// ---------------------------------------------------------------------------

describe("inspectExecution (Spec 22 Unit 1)", () => {
  it("InspectExecutionInput / InspectExecutionOutput type shapes are correct", () => {
    const input: InspectExecutionInput = {
      workflowInstanceId: wfId,
      metadata: { source: "dashboard" },
    };
    expect(input.workflowInstanceId).toBe(wfId);
    expect(input.metadata?.source).toBe("dashboard");

    const output: InspectExecutionOutput = {
      workflowInstanceId: wfId,
      status: "running",
      workflowName: "my-workflow",
      goal: "Build a feature",
      slug: "build-a-feature",
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:01:00.000Z",
      artifacts: [],
      hasActiveLease: true,
    };
    expect(output.status).toBe("running");
    expect(output.hasActiveLease).toBe(true);
  });

  it("returns not_found for a non-existent workflow instance", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("inspect-non-existent");

    const result = await inspectExecution(
      { workflowInstanceId: nonExistentId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
      expect(result.error.id).toBe(nonExistentId);
    }
  });

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await inspectExecution(
      { workflowInstanceId: "" as typeof wfId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns the current instance state without modifying it", async () => {
    const store = createInMemoryRuntimeStore();

    // Create and start an instance
    const instanceId = createWorkflowInstanceId("inspect-readonly-001");
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-inspect-001" },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    // Inspect the instance
    const inspectResult = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(inspectResult.isOk()).toBe(true);
    if (!inspectResult.isOk()) return;

    const output = inspectResult.value;
    expect(output.workflowInstanceId).toBe(instanceId);
    expect(output.status).toBe("running");
    expect(output.hasActiveLease).toBe(true);

    // Verify the instance was NOT modified by inspectExecution
    const instanceAfter = await store.instances.getById(instanceId);
    expect(instanceAfter.isOk()).toBe(true);
    if (!instanceAfter.isOk()) return;
    expect(instanceAfter.value.status).toBe("running");
  });

  it("reports hasActiveLease: false when no active lease exists", async () => {
    const store = createInMemoryRuntimeStore();

    // Create an instance without starting execution (no lease)
    const createResult = await store.instances.create({
      workflowName: "inspect-no-lease",
      goal: "inspect goal",
      slug: "inspect-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.hasActiveLease).toBe(false);
    expect(result.value.status).toBe("created");
  });

  it("reports hasActiveLease: true when an active lease exists for this instance", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-with-lease-001");

    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-lease-check" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.hasActiveLease).toBe(true);
  });

  it("reports hasActiveLease: false when the active lease belongs to a different instance", async () => {
    const store = createInMemoryRuntimeStore();

    // Start instance A (acquires the active lease)
    const instanceA = createWorkflowInstanceId("inspect-lease-a");
    const startA = await startExecution(
      { workflowInstanceId: instanceA, ownerId: "owner-a" },
      store,
    );
    expect(startA.isOk()).toBe(true);

    // Create instance B without starting it
    const createB = await store.instances.create({
      workflowName: "inspect-lease-b",
      goal: "goal b",
      slug: "goal-b",
    });
    expect(createB.isOk()).toBe(true);
    if (!createB.isOk()) return;
    const instanceB = createB.value.id;

    // Inspect instance B — the active lease belongs to A, not B
    const result = await inspectExecution(
      { workflowInstanceId: instanceB },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.hasActiveLease).toBe(false);
  });

  it("returns all instance fields in the output snapshot", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-fields-001");

    await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-fields" },
      store,
    );
    await store.instances.update(instanceId, { currentStepName: "plan" });

    const result = await inspectExecution(
      { workflowInstanceId: instanceId },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const output = result.value;
    expect(output.workflowInstanceId).toBe(instanceId);
    expect(output.status).toBe("running");
    expect(output.currentStepName).toBe("plan");
    expect(output.workflowName).toBeDefined();
    expect(output.goal).toBeDefined();
    expect(output.slug).toBeDefined();
    expect(output.createdAt).toBeDefined();
    expect(output.updatedAt).toBeDefined();
    expect(Array.isArray(output.artifacts)).toBe(true);
  });

  it("does NOT create a WorkflowInstance or ExecutionLease (read-only invariant)", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("inspect-no-create");

    // inspectExecution on a non-existent instance returns not_found
    // and MUST NOT create any instance or lease as a side effect
    const result = await inspectExecution(
      { workflowInstanceId: nonExistentId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");

    // Verify no instance was created
    const instanceCheck = await store.instances.findById(nonExistentId);
    expect(instanceCheck.isOk()).toBe(true);
    expect(instanceCheck._unsafeUnwrap()).toBeNull();

    // Verify no lease was created
    const leaseCheck = await store.leases.findActive();
    expect(leaseCheck.isOk()).toBe(true);
    expect(leaseCheck._unsafeUnwrap()).toBeNull();
  });

  it("rejects metadata with denied field names", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("inspect-meta-deny");
    await store.instances.create({
      workflowName: "wf",
      goal: "g",
      slug: "g",
    });

    const result = await inspectExecution(
      {
        workflowInstanceId: instanceId,
        metadata: { token: "secret" } as Record<string, string>,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// Spec 22 Unit 1 / ADR 0004: observeSession boundary invariants
// ---------------------------------------------------------------------------

describe("observeSession boundary invariants (ADR 0004)", () => {
  it("observeSession does NOT create a WorkflowInstance", async () => {
    const store = createInMemoryRuntimeStore();
    const newId = createWorkflowInstanceId("observe-no-create-001");

    // observeSession with a non-existent workflowInstanceId still records a
    // snapshot (the store does not enforce FK constraints in the in-memory impl),
    // but it MUST NOT create a WorkflowInstance record.
    await observeSession(
      {
        workflowInstanceId: newId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    // The instance must not have been created by observeSession
    const instanceCheck = await store.instances.findById(newId);
    expect(instanceCheck.isOk()).toBe(true);
    expect(instanceCheck._unsafeUnwrap()).toBeNull();
  });

  it("observeSession does NOT acquire an ExecutionLease", async () => {
    const store = createInMemoryRuntimeStore();

    // Call observeSession — it must not acquire any lease
    await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    // No lease should have been acquired
    const leaseCheck = await store.leases.findActive();
    expect(leaseCheck.isOk()).toBe(true);
    expect(leaseCheck._unsafeUnwrap()).toBeNull();
  });

  it("observeSession does NOT transition WorkflowInstance status", async () => {
    const store = createInMemoryRuntimeStore();

    // Create an instance in 'created' status
    const createResult = await store.instances.create({
      workflowName: "observe-boundary-wf",
      goal: "observe boundary goal",
      slug: "observe-boundary-goal",
    });
    expect(createResult.isOk()).toBe(true);
    if (!createResult.isOk()) return;
    const instanceId = createResult.value.id;
    expect(createResult.value.status).toBe("created");

    // Call observeSession — it must not change the instance status
    await observeSession(
      {
        workflowInstanceId: instanceId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    // Status must remain 'created' — observeSession cannot start execution
    const instanceAfter = await store.instances.getById(instanceId);
    expect(instanceAfter.isOk()).toBe(true);
    if (!instanceAfter.isOk()) return;
    expect(instanceAfter.value.status).toBe("created");
  });

  it("observeSession does NOT emit LifecycleEffect values", async () => {
    const store = createInMemoryRuntimeStore();

    const result = await observeSession(
      {
        workflowInstanceId: wfId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    // observeSession returns ObserveSessionOutput — no effects field
    if (result.isOk()) {
      const output = result.value;
      // The output has only snapshotId — no effects
      expect("effects" in output).toBe(false);
      expect(output.snapshotId).toBeDefined();
    }
    // Whether ok or err, there are no effects emitted
  });

  it("startExecution is the only path that creates a WorkflowInstance and acquires a lease", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("boundary-only-start-001");

    // Before startExecution: no instance, no lease
    const beforeInstance = await store.instances.findById(instanceId);
    expect(beforeInstance._unsafeUnwrap()).toBeNull();
    const beforeLease = await store.leases.findActive();
    expect(beforeLease._unsafeUnwrap()).toBeNull();

    // Call observeSession — must not create instance or lease
    await observeSession(
      {
        workflowInstanceId: instanceId,
        leaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    const afterObserveInstance = await store.instances.findById(instanceId);
    expect(afterObserveInstance._unsafeUnwrap()).toBeNull();
    const afterObserveLease = await store.leases.findActive();
    expect(afterObserveLease._unsafeUnwrap()).toBeNull();

    // Only startExecution creates the instance and lease
    const startResult = await startExecution(
      { workflowInstanceId: instanceId, ownerId: "owner-boundary-001" },
      store,
    );
    expect(startResult.isOk()).toBe(true);

    const afterStartInstance = await store.instances.findById(instanceId);
    expect(afterStartInstance._unsafeUnwrap()).not.toBeNull();
    const afterStartLease = await store.leases.findActive();
    expect(afterStartLease._unsafeUnwrap()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ExecutionAuthorizationSource — type and constant tests (Task 1.3)
// ---------------------------------------------------------------------------

describe("ExecutionAuthorizationSource type and constants", () => {
  it("EXECUTION_AUTHORIZATION_SOURCES contains all 4 valid source values", () => {
    expect(EXECUTION_AUTHORIZATION_SOURCES).toHaveLength(4);
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("user");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("agent");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("hook");
    expect(EXECUTION_AUTHORIZATION_SOURCES).toContain("event");
  });

  it("ExecutionAuthorizationSource type accepts all 4 variants", () => {
    const sources: ExecutionAuthorizationSource[] = [
      "user",
      "agent",
      "hook",
      "event",
    ];
    expect(sources).toHaveLength(4);
  });

  it("'user' is the only authorized source — all others are forbidden", () => {
    const forbidden: ExecutionAuthorizationSource[] = [
      "agent",
      "hook",
      "event",
    ];
    for (const source of forbidden) {
      const result = validateAuthorizationSource(source, "startExecution");
      expect(result.isErr()).toBe(true);
      if (!result.isErr()) continue;
      expect(result.error.type).toBe("policy_decision");
      if (result.error.type === "policy_decision") {
        expect(result.error.rule).toBe("authorizationSource");
        expect(result.error.message).toContain(source);
        expect(result.error.message).toContain("startExecution");
      }
    }
  });

  it("validateAuthorizationSource: 'user' returns ok", () => {
    const result = validateAuthorizationSource("user", "startExecution");
    expect(result.isOk()).toBe(true);
  });

  it("validateAuthorizationSource: 'user' returns ok for resumeExecution", () => {
    const result = validateAuthorizationSource("user", "resumeExecution");
    expect(result.isOk()).toBe(true);
  });

  it("validateAuthorizationSource: 'agent' returns policy_decision error for startExecution", () => {
    const result = validateAuthorizationSource("agent", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("agent");
    expect(result.error.message).toContain("startExecution");
  });

  it("validateAuthorizationSource: 'hook' returns policy_decision error for resumeExecution", () => {
    const result = validateAuthorizationSource("hook", "resumeExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("hook");
    expect(result.error.message).toContain("resumeExecution");
  });

  it("validateAuthorizationSource: 'event' returns policy_decision error", () => {
    const result = validateAuthorizationSource("event", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("event");
  });

  it("error message references ADR 0004", () => {
    const result = validateAuthorizationSource("hook", "startExecution");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.message).toContain("0004");
  });
});

// ---------------------------------------------------------------------------
// startExecution — explicit authorization enforcement (Task 1.3 / ADR 0004)
// ---------------------------------------------------------------------------

describe("startExecution: explicit authorization enforcement (ADR 0004)", () => {
  it("succeeds with authorizationSource: 'user' (explicit)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-user-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-auth-user",
        authorizationSource: "user",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(typeof result.value.leaseId).toBe("string");
  });

  it("succeeds when authorizationSource is omitted (backward-compat default: 'user')", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-omit-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-auth-omit",
        // authorizationSource omitted — defaults to "user"
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("rejects agent-initiated self-start: authorizationSource: 'agent'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-agent-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-agent-self-start",
        authorizationSource: "agent",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("agent");
    }

    // No instance or lease should have been created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value).toBeNull();

    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });

  it("rejects hook-initiated self-start: authorizationSource: 'hook'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-hook-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-hook-self-start",
        authorizationSource: "hook",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("hook");
    }

    // Fail closed: no instance or lease created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();
    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("rejects event-initiated self-start: authorizationSource: 'event'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-event-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-event-self-start",
        authorizationSource: "event",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("event");
    }

    // Fail closed: no instance or lease created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();
    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("authorization check fires BEFORE workflow context validation (fail-fast order)", async () => {
    // If authorizationSource is rejected, the engine must not proceed to
    // validate the workflow context or create any store records.
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("auth-order-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-order-test",
        authorizationSource: "agent",
        context: {
          workflowName: "does-not-exist",
          goal: "test",
          slug: "test",
          workflows: {},
        },
      },
      store,
    );

    // Must fail with policy_decision (authorization), not not_found (workflow)
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });
});

// ---------------------------------------------------------------------------
// resumeExecution — explicit authorization enforcement (Task 1.3 / ADR 0004)
// ---------------------------------------------------------------------------

describe("resumeExecution: explicit authorization enforcement (ADR 0004)", () => {
  /**
   * Helper: create a paused workflow instance for resume tests.
   */
  async function createPausedInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`auth-resume-wf-${suffix}`);
    // Start with user authorization, then pause
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        authorizationSource: "user",
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const { leaseId: activeLeaseId } = startResult.value;

    // Pause the instance
    await store.instances.update(instanceId, { status: "paused" });
    // Release the lease so resume can acquire a new one
    await store.leases.release(activeLeaseId, createOwnerId(`owner-${suffix}`));

    return instanceId;
  }

  it("succeeds with authorizationSource: 'user' (explicit)", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = await createPausedInstance(store, "user-resume");

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-resume-user",
        authorizationSource: "user",
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(typeof result.value.leaseId).toBe("string");
  });

  it("succeeds when authorizationSource is omitted (backward-compat default: 'user')", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = await createPausedInstance(store, "omit-resume");

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-resume-omit",
        // authorizationSource omitted — defaults to "user"
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  it("rejects hook-initiated implicit resume: authorizationSource: 'hook'", async () => {
    // This is the ADR 0004 scenario: the legacy workContinuation hook fired
    // on session.idle and implicitly resumed Tapestry. That path is now
    // rejected by the engine regardless of adapter intent.
    const store = createInMemoryRuntimeStore();
    const instanceId = await createPausedInstance(store, "hook-resume");

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-hook-resume",
        authorizationSource: "hook",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("hook");
      expect(result.error.message).toContain("resumeExecution");
    }

    // Instance must remain paused — no state change on rejection
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("rejects agent-initiated resume: authorizationSource: 'agent'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = await createPausedInstance(store, "agent-resume");

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-agent-resume",
        authorizationSource: "agent",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("agent");
    }

    // Instance must remain paused — fail closed
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  it("rejects event-initiated resume: authorizationSource: 'event'", async () => {
    const store = createInMemoryRuntimeStore();
    const instanceId = await createPausedInstance(store, "event-resume");

    const result = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-event-resume",
        authorizationSource: "event",
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("authorizationSource");
      expect(result.error.message).toContain("event");
    }
  });

  it("authorization check fires BEFORE instance lookup (fail-fast order)", async () => {
    // Even for a non-existent instance, the authorization check must fire first.
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("auth-order-resume-001");

    const result = await resumeExecution(
      {
        workflowInstanceId: nonExistentId,
        ownerId: "session-order-resume",
        authorizationSource: "hook",
      },
      store,
    );

    // Must fail with policy_decision (authorization), not not_found (instance)
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });
});

// ---------------------------------------------------------------------------
// observeSession — side-effect-free boundary (Task 1.3 / ADR 0004)
// ---------------------------------------------------------------------------

describe("observeSession: side-effect-free boundary (ADR 0004)", () => {
  it("observeSession does not accept authorizationSource — it is not an execution operation", () => {
    // ObserveSessionInput must NOT have an authorizationSource field.
    // This is a structural test: the type should not include the field.
    const input: ObserveSessionInput = {
      workflowInstanceId: createWorkflowInstanceId("obs-boundary-001"),
      leaseId: createExecutionLeaseId("lease-obs-001"),
      harnessName: "opencode",
      agentName: "loom",
      sessionStatus: "active",
    };

    // authorizationSource must NOT be a field on ObserveSessionInput
    expect("authorizationSource" in input).toBe(false);
  });

  it("observeSession called from an idle-hook context does not start execution", async () => {
    // Simulates the legacy workContinuation hook scenario:
    // An idle hook calls observeSession — this must NOT create a WorkflowInstance
    // or acquire an ExecutionLease, regardless of how many times it is called.
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("obs-idle-hook-001");
    const leaseId = createExecutionLeaseId("lease-idle-hook-001");

    // Call observeSession multiple times (simulating repeated idle events)
    for (let i = 0; i < 3; i++) {
      await observeSession(
        {
          workflowInstanceId: instanceId,
          leaseId,
          harnessName: "opencode",
          agentName: "loom",
          sessionStatus: "idle",
          metadata: { idleCount: i },
        },
        store,
      );
    }

    // No WorkflowInstance should have been created
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value).toBeNull();

    // No ExecutionLease should have been acquired
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    if (!leaseResult.isOk()) return;
    expect(leaseResult.value).toBeNull();
  });

  it("observeSession called from a continuation-hook context does not resume execution", async () => {
    // Simulates the legacy compaction-recovery scenario:
    // A continuation hook calls observeSession — this must NOT transition
    // a paused instance to running or acquire a new lease.
    const store = createInMemoryRuntimeStore();

    // Create a paused instance via the authorized path
    const instanceId = createWorkflowInstanceId("obs-continuation-001");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-continuation",
        authorizationSource: "user",
      },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    await store.instances.update(instanceId, { status: "paused" });
    await store.leases.release(
      startResult.value.leaseId,
      createOwnerId("owner-continuation"),
    );

    // Verify the instance is paused and no active lease exists
    const beforeInstance = await store.instances.getById(instanceId);
    expect(beforeInstance._unsafeUnwrap().status).toBe("paused");
    const beforeLease = await store.leases.findActive();
    expect(beforeLease._unsafeUnwrap()).toBeNull();

    // Call observeSession (simulating a continuation hook)
    await observeSession(
      {
        workflowInstanceId: instanceId,
        leaseId: createExecutionLeaseId("fake-continuation-lease"),
        harnessName: "opencode",
        agentName: "tapestry",
        sessionStatus: "active",
        metadata: { source: "continuation-hook" },
      },
      store,
    );

    // Instance must still be paused — observeSession cannot resume execution
    const afterInstance = await store.instances.getById(instanceId);
    expect(afterInstance._unsafeUnwrap().status).toBe("paused");

    // No new lease should have been acquired
    const afterLease = await store.leases.findActive();
    expect(afterLease._unsafeUnwrap()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 1.4: No implicit execution — ordinary conversation, idle, and session
// observation paths (ADR 0004 / Spec 22 Unit 1)
// ---------------------------------------------------------------------------

describe("No implicit execution: ordinary conversation-adjacent paths (ADR 0004)", () => {
  it("ordinary Loom conversation: observeSession with sessionStatus 'active' does not create a WorkflowInstance", async () => {
    // Simulates the most common path: Loom is responding to a user message
    // in a normal conversation (no workflow). The adapter calls observeSession
    // to record the session state. This MUST NOT create a WorkflowInstance.
    const store = createInMemoryRuntimeStore();
    const conversationInstanceId = createWorkflowInstanceId(
      "conv-loom-active-001",
    );
    const conversationLeaseId = createExecutionLeaseId("conv-lease-001");

    await observeSession(
      {
        workflowInstanceId: conversationInstanceId,
        leaseId: conversationLeaseId,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { turnIndex: 1 },
      },
      store,
    );

    // No WorkflowInstance must have been created
    const instanceResult = await store.instances.findById(
      conversationInstanceId,
    );
    expect(instanceResult.isOk()).toBe(true);
    expect(instanceResult._unsafeUnwrap()).toBeNull();
  });

  it("ordinary Loom conversation: observeSession with sessionStatus 'active' does not acquire an ExecutionLease", async () => {
    // Same scenario as above — verifies the lease side of the invariant.
    const store = createInMemoryRuntimeStore();

    await observeSession(
      {
        workflowInstanceId: createWorkflowInstanceId("conv-loom-lease-001"),
        leaseId: createExecutionLeaseId("conv-lease-002"),
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
        metadata: { turnIndex: 2 },
      },
      store,
    );

    // No ExecutionLease must have been acquired
    const leaseResult = await store.leases.findActive();
    expect(leaseResult.isOk()).toBe(true);
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("repeated conversation turns: multiple observeSession calls do not accumulate instances or leases", async () => {
    // Simulates a multi-turn conversation where the adapter calls observeSession
    // after each turn. None of these calls should create instances or leases.
    const store = createInMemoryRuntimeStore();
    const conversationId = createWorkflowInstanceId("conv-multi-turn-001");
    const leaseRef = createExecutionLeaseId("conv-lease-multi-001");

    for (let turn = 0; turn < 5; turn++) {
      await observeSession(
        {
          workflowInstanceId: conversationId,
          leaseId: leaseRef,
          harnessName: "opencode",
          agentName: "loom",
          sessionStatus: "active",
          metadata: { turnIndex: turn },
        },
        store,
      );
    }

    // After 5 turns, still no instance or lease
    const instanceResult = await store.instances.findById(conversationId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();

    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("inspectExecution called from a conversation context does not create instances or leases", async () => {
    // An adapter may call inspectExecution during a conversation to check
    // whether a workflow is running. This is a read-only operation and must
    // not create any state even when the instance does not exist.
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("conv-inspect-001");

    // inspectExecution on a non-existent instance returns not_found
    const result = await inspectExecution(
      { workflowInstanceId: nonExistentId },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");

    // No instance or lease created as a side effect
    const instanceCheck = await store.instances.findById(nonExistentId);
    expect(instanceCheck._unsafeUnwrap()).toBeNull();

    const leaseCheck = await store.leases.findActive();
    expect(leaseCheck._unsafeUnwrap()).toBeNull();
  });

  it("idle session observation: observeSession with sessionStatus 'idle' does not create instances or leases", async () => {
    // Simulates the session going idle between conversation turns.
    // The adapter may call observeSession with 'idle' status — this must not
    // trigger any execution state changes.
    const store = createInMemoryRuntimeStore();
    const idleId = createWorkflowInstanceId("conv-idle-obs-001");

    await observeSession(
      {
        workflowInstanceId: idleId,
        leaseId: createExecutionLeaseId("conv-idle-lease-001"),
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "idle",
      },
      store,
    );

    const instanceResult = await store.instances.findById(idleId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();

    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("terminated session observation: observeSession with sessionStatus 'terminated' does not create instances or leases", async () => {
    // Simulates the session ending. The adapter calls observeSession with
    // 'terminated' status — this must not create any execution state.
    const store = createInMemoryRuntimeStore();
    const terminatedId = createWorkflowInstanceId("conv-terminated-obs-001");

    await observeSession(
      {
        workflowInstanceId: terminatedId,
        leaseId: createExecutionLeaseId("conv-terminated-lease-001"),
        harnessName: "claude-code",
        agentName: "shuttle",
        sessionStatus: "terminated",
      },
      store,
    );

    const instanceResult = await store.instances.findById(terminatedId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();

    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("conversation path cannot bypass the execution boundary: observeSession + inspectExecution together do not start execution", async () => {
    // Verifies that combining observation and inspection (the two read-side
    // operations available during ordinary conversation) cannot implicitly
    // start durable execution. Only startExecution (with user authorization)
    // may do so.
    const store = createInMemoryRuntimeStore();
    const id = createWorkflowInstanceId("conv-combined-obs-inspect-001");
    const leaseRef = createExecutionLeaseId("conv-combined-lease-001");

    // Step 1: observe the session (as an adapter would during conversation)
    await observeSession(
      {
        workflowInstanceId: id,
        leaseId: leaseRef,
        harnessName: "opencode",
        agentName: "loom",
        sessionStatus: "active",
      },
      store,
    );

    // Step 2: inspect execution state (as an adapter would to check status)
    const inspectResult = await inspectExecution(
      { workflowInstanceId: id },
      store,
    );

    // inspectExecution returns not_found — no instance was created by observeSession
    expect(inspectResult.isErr()).toBe(true);
    if (!inspectResult.isErr()) return;
    expect(inspectResult.error.type).toBe("not_found");

    // Confirm: no instance, no lease
    const instanceCheck = await store.instances.findById(id);
    expect(instanceCheck._unsafeUnwrap()).toBeNull();

    const leaseCheck = await store.leases.findActive();
    expect(leaseCheck._unsafeUnwrap()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// beforeTool — side-effect-free boundary (Task 1.3 / ADR 0004)
// ---------------------------------------------------------------------------

describe("beforeTool: side-effect-free boundary (ADR 0004)", () => {
  it("beforeTool does not accept authorizationSource — it is not an execution operation", () => {
    // BeforeToolInput must NOT have an authorizationSource field.
    const input: BeforeToolInput = {
      workflowInstanceId: createWorkflowInstanceId("bt-boundary-001"),
      leaseId: createExecutionLeaseId("lease-bt-001"),
      agentName: "shuttle",
      toolCapability: "read",
      toolName: "read_file",
      effectiveToolPolicy: evaluateEffectiveToolPolicy({ read: "allow" }),
    };

    expect("authorizationSource" in input).toBe(false);
  });

  it("beforeTool does not create WorkflowInstances or acquire leases", async () => {
    // beforeTool is a pure policy evaluation — it must not touch the store.
    // We verify this by calling it without a store and confirming it succeeds.
    const input: BeforeToolInput = {
      workflowInstanceId: createWorkflowInstanceId("bt-no-store-001"),
      leaseId: createExecutionLeaseId("lease-bt-no-store-001"),
      agentName: "shuttle",
      toolCapability: "write",
      toolName: "write_file",
      effectiveToolPolicy: evaluateEffectiveToolPolicy({ write: "allow" }),
    };

    // beforeTool takes no store argument — it is a pure policy evaluation
    const result = await beforeTool(input);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.decision).toBe("allow");
  });

  it("beforeTool called repeatedly does not accumulate state", async () => {
    // Calling beforeTool multiple times must produce the same result each time.
    const policy = evaluateEffectiveToolPolicy({ execute: "ask" });
    const input: BeforeToolInput = {
      workflowInstanceId: createWorkflowInstanceId("bt-idempotent-001"),
      leaseId: createExecutionLeaseId("lease-bt-idempotent-001"),
      agentName: "shuttle",
      toolCapability: "execute",
      toolName: "run_command",
      effectiveToolPolicy: policy,
    };

    const results = await Promise.all([
      beforeTool(input),
      beforeTool(input),
      beforeTool(input),
    ]);

    for (const result of results) {
      expect(result.isOk()).toBe(true);
      if (!result.isOk()) continue;
      expect(result.value.decision).toBe("ask");
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed invariant — execution boundary (Task 1.3 / ADR 0004)
// ---------------------------------------------------------------------------

describe("Fail-closed invariant: execution boundary (ADR 0004)", () => {
  it("startExecution with forbidden source fails closed — no partial state written", async () => {
    // When authorization is rejected, the engine must not write any partial
    // state to the store. This is the "fail closed" invariant.
    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("fail-closed-start-001");

    const result = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-fail-closed",
        authorizationSource: "agent",
      },
      store,
    );

    expect(result.isErr()).toBe(true);

    // No instance written
    const instanceResult = await store.instances.findById(instanceId);
    expect(instanceResult._unsafeUnwrap()).toBeNull();

    // No lease acquired
    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("resumeExecution with forbidden source fails closed — instance status unchanged", async () => {
    const store = createInMemoryRuntimeStore();

    // Create a paused instance via the authorized path
    const instanceId = createWorkflowInstanceId("fail-closed-resume-001");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-fail-closed",
        authorizationSource: "user",
      },
      store,
    );
    expect(startResult.isOk()).toBe(true);
    if (!startResult.isOk()) return;

    await store.instances.update(instanceId, { status: "paused" });
    await store.leases.release(
      startResult.value.leaseId,
      createOwnerId("owner-fail-closed"),
    );

    // Attempt hook-initiated resume — must fail closed
    const resumeResult = await resumeExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "session-hook-fail-closed",
        authorizationSource: "hook",
      },
      store,
    );

    expect(resumeResult.isErr()).toBe(true);
    if (!resumeResult.isErr()) return;
    expect(resumeResult.error.type).toBe("policy_decision");

    // Instance must still be paused — no state change
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult._unsafeUnwrap().status).toBe("paused");

    // No new lease acquired
    const leaseResult = await store.leases.findActive();
    expect(leaseResult._unsafeUnwrap()).toBeNull();
  });

  it("all three forbidden sources produce policy_decision errors (not validation or not_found)", async () => {
    // The error type must be policy_decision — not validation or not_found.
    // This distinguishes authorization failures from input errors.
    const store = createInMemoryRuntimeStore();
    const forbiddenSources: ExecutionAuthorizationSource[] = [
      "agent",
      "hook",
      "event",
    ];

    for (const source of forbiddenSources) {
      const instanceId = createWorkflowInstanceId(
        `fail-closed-type-${source}-001`,
      );
      const result = await startExecution(
        {
          workflowInstanceId: instanceId,
          ownerId: `session-${source}`,
          authorizationSource: source,
        },
        store,
      );

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) continue;
      expect(result.error.type).toBe("policy_decision");
      // Must NOT be validation or not_found
      expect(result.error.type).not.toBe("validation");
      expect(result.error.type).not.toBe("not_found");
    }
  });
});

// ---------------------------------------------------------------------------
// Task 3.2: Normative vs informational artifact input interfaces
// ---------------------------------------------------------------------------

describe("ArtifactInputRole — type and constant surface", () => {
  it("ARTIFACT_INPUT_ROLES contains 'normative' and 'informational'", () => {
    expect(ARTIFACT_INPUT_ROLES).toContain("normative");
    expect(ARTIFACT_INPUT_ROLES).toContain("informational");
    expect(ARTIFACT_INPUT_ROLES).toHaveLength(2);
  });

  it("ArtifactInputRole type accepts 'normative' and 'informational'", () => {
    const normative: ArtifactInputRole = "normative";
    const informational: ArtifactInputRole = "informational";
    expect(normative).toBe("normative");
    expect(informational).toBe("informational");
  });

  it("ArtifactInputDecl accepts name, description, and optional role", () => {
    const normativeDecl: ArtifactInputDecl = {
      name: "plan_path",
      description: "Path to the plan file",
      role: "normative",
    };
    const informationalDecl: ArtifactInputDecl = {
      name: "context_doc",
      description: "Optional context document",
      role: "informational",
    };
    const noRoleDecl: ArtifactInputDecl = {
      name: "spec_file",
      description: "Specification file",
      // role omitted — engine defaults to normative
    };

    expect(normativeDecl.role).toBe("normative");
    expect(informationalDecl.role).toBe("informational");
    expect(noRoleDecl.role).toBeUndefined();
  });

  it("ArtifactInputSummary carries three readonly arrays", () => {
    const summary: ArtifactInputSummary = {
      normativeSatisfied: ["plan_path"],
      informationalPresent: ["context_doc"],
      informationalAbsent: ["optional_spec"],
    };
    expect(summary.normativeSatisfied).toContain("plan_path");
    expect(summary.informationalPresent).toContain("context_doc");
    expect(summary.informationalAbsent).toContain("optional_spec");
  });
});

// ---------------------------------------------------------------------------
// dispatchStep — normative vs informational artifact input validation
// ---------------------------------------------------------------------------

describe("dispatchStep: normative vs informational artifact inputs (Task 3.2)", () => {
  /**
   * Workflow fixture with mixed normative and informational inputs.
   *
   * "implement" step:
   *   - normative input: "plan_path" (required — blocks dispatch if absent)
   *   - informational input: "context_doc" (advisory — dispatch proceeds if absent)
   *
   * "review" step:
   *   - informational input only: "build_report" (advisory)
   *
   * "plan" step:
   *   - no inputs (produces plan_path)
   */
  const mixedInputWorkflows: WorkflowExecutionContext["workflows"] = {
    "mixed-inputs": {
      version: 1,
      steps: [
        {
          name: "plan",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          outputs: [{ name: "plan_path", description: "Path to the plan" }],
        },
        {
          name: "implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement using {{artifacts.plan_path}}",
          completion: { method: "agent_signal" },
          inputs: [
            {
              name: "plan_path",
              description: "Path to the plan file",
              // no role — defaults to normative
            },
            {
              name: "context_doc",
              description: "Optional context document",
              role: "informational",
            } as ArtifactInputDecl,
          ],
        },
        {
          name: "review",
          type: "gate",
          agent: "weft",
          prompt: "Review changes for {{instance.workflowName}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
          inputs: [
            {
              name: "build_report",
              description: "Build report (advisory)",
              role: "informational",
            } as ArtifactInputDecl,
          ],
        },
      ],
    },
    "normative-only": {
      version: 1,
      steps: [
        {
          name: "execute",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Execute using {{artifacts.required_spec}}",
          completion: { method: "agent_signal" },
          inputs: [
            {
              name: "required_spec",
              description: "Required specification",
              role: "normative",
            } as ArtifactInputDecl,
          ],
        },
      ],
    },
    "informational-only": {
      version: 1,
      steps: [
        {
          name: "analyze",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Analyze the codebase",
          completion: { method: "agent_signal" },
          inputs: [
            {
              name: "prior_analysis",
              description: "Prior analysis (advisory)",
              role: "informational",
            } as ArtifactInputDecl,
          ],
        },
      ],
    },
  };

  /**
   * Helper: start an execution with workflow context.
   */
  async function startWithCtx(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
    workflowName = "mixed-inputs",
    goal = "Build feature",
    slug = "build-feature",
  ) {
    const instanceId = createWorkflowInstanceId(`t32-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: {
          workflowName,
          goal,
          slug,
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // ---------------------------------------------------------------------------
  // Normative input — blocks dispatch when absent
  // ---------------------------------------------------------------------------

  it("normative input absent: returns not_found error, dispatch blocked", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "norm-absent",
    );

    // Do NOT add "plan_path" — normative input is absent

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("artifact");
      expect(result.error.id).toBe("plan_path");
    }
  });

  it("normative input present: dispatch succeeds", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "norm-present",
    );

    // Add the normative input
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/build-feature.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Informational input — dispatch proceeds even when absent
  // ---------------------------------------------------------------------------

  it("informational input absent: dispatch succeeds (advisory only)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "info-absent",
    );

    // Add normative input but NOT the informational "context_doc"
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/build-feature.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    // Dispatch must succeed even though "context_doc" is absent
    expect(result.isOk()).toBe(true);
  });

  it("all-informational step: dispatch succeeds with no artifacts present", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "all-info-absent",
      "informational-only",
      "Analyze codebase",
      "analyze-codebase",
    );

    // Do NOT add "prior_analysis" — it is informational

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "analyze",
        context: {
          workflowName: "informational-only",
          goal: "Analyze codebase",
          slug: "analyze-codebase",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // ArtifactInputSummary — present in DispatchStepOutput when step has inputs
  // ---------------------------------------------------------------------------

  it("artifactInputSummary: normative satisfied, informational absent", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "summary-norm-sat-info-absent",
    );

    // Add normative "plan_path" but NOT informational "context_doc"
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/build-feature.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { artifactInputSummary } = result.value;
    expect(artifactInputSummary).toBeDefined();
    if (!artifactInputSummary) return;

    expect(artifactInputSummary.normativeSatisfied).toContain("plan_path");
    expect(artifactInputSummary.informationalAbsent).toContain("context_doc");
    expect(artifactInputSummary.informationalPresent).toHaveLength(0);
  });

  it("artifactInputSummary: normative satisfied, informational present", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "summary-both-present",
    );

    // Add both normative and informational inputs
    await store.instances.addArtifact(instanceId, {
      name: "plan_path",
      path: ".weave/plans/build-feature.md",
    });
    await store.instances.addArtifact(instanceId, {
      name: "context_doc",
      path: ".weave/context/context.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { artifactInputSummary } = result.value;
    expect(artifactInputSummary).toBeDefined();
    if (!artifactInputSummary) return;

    expect(artifactInputSummary.normativeSatisfied).toContain("plan_path");
    expect(artifactInputSummary.informationalPresent).toContain("context_doc");
    expect(artifactInputSummary.informationalAbsent).toHaveLength(0);
  });

  it("artifactInputSummary: all-informational step, artifact absent", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "summary-all-info-absent",
      "informational-only",
      "Analyze codebase",
      "analyze-codebase",
    );

    // Do NOT add "prior_analysis"

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "analyze",
        context: {
          workflowName: "informational-only",
          goal: "Analyze codebase",
          slug: "analyze-codebase",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { artifactInputSummary } = result.value;
    expect(artifactInputSummary).toBeDefined();
    if (!artifactInputSummary) return;

    expect(artifactInputSummary.normativeSatisfied).toHaveLength(0);
    expect(artifactInputSummary.informationalPresent).toHaveLength(0);
    expect(artifactInputSummary.informationalAbsent).toContain(
      "prior_analysis",
    );
  });

  it("artifactInputSummary: absent for steps with no declared inputs", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "summary-no-inputs",
    );

    // "plan" step has no inputs
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // No inputs declared — summary should be absent
    expect(result.value.artifactInputSummary).toBeUndefined();
  });

  it("artifactInputSummary: absent for legacy dispatch (no context)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "summary-legacy",
    );

    // Legacy dispatch — no context
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "plan",
        // no context
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Legacy dispatch never produces a summary
    expect(result.value.artifactInputSummary).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Role defaulting — absent role treated as normative
  // ---------------------------------------------------------------------------

  it("input without explicit role defaults to normative (blocks dispatch when absent)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "default-role-normative",
      "normative-only",
      "Execute spec",
      "execute-spec",
    );

    // "required_spec" has explicit role: "normative" — absent → blocked
    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "execute",
        context: {
          workflowName: "normative-only",
          goal: "Execute spec",
          slug: "execute-spec",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("artifact");
      expect(result.error.id).toBe("required_spec");
    }
  });

  it("input without explicit role defaults to normative (succeeds when present)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "default-role-normative-present",
      "normative-only",
      "Execute spec",
      "execute-spec",
    );

    // Add the normative artifact
    await store.instances.addArtifact(instanceId, {
      name: "required_spec",
      path: ".weave/specs/required.md",
    });

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "execute",
        context: {
          workflowName: "normative-only",
          goal: "Execute spec",
          slug: "execute-spec",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { artifactInputSummary } = result.value;
    expect(artifactInputSummary).toBeDefined();
    if (!artifactInputSummary) return;
    expect(artifactInputSummary.normativeSatisfied).toContain("required_spec");
  });

  // ---------------------------------------------------------------------------
  // Error message quality — normative error names the artifact
  // ---------------------------------------------------------------------------

  it("normative not_found error message names the missing artifact", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startWithCtx(
      store,
      "error-message-quality",
    );

    // "plan_path" is normative — absent

    const result = await dispatchStep(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        stepName: "implement",
        context: {
          workflowName: "mixed-inputs",
          goal: "Build feature",
          slug: "build-feature",
          workflows: mixedInputWorkflows,
        },
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      // Error message must name the artifact
      expect(result.error.message).toContain("plan_path");
      // Error message must indicate it is normative
      expect(result.error.message).toContain("normative");
    }
  });

  // ---------------------------------------------------------------------------
  // DispatchStepOutput type shape — artifactInputSummary is optional
  // ---------------------------------------------------------------------------

  it("DispatchStepOutput.artifactInputSummary is optional (absent for no-input steps)", () => {
    // Structural type test: DispatchStepOutput must accept absence of summary
    const output: DispatchStepOutput = {
      stepName: "plan",
      effects: [],
      // artifactInputSummary absent — valid
    };
    expect(output.artifactInputSummary).toBeUndefined();
  });

  it("DispatchStepOutput.artifactInputSummary carries three arrays when present", () => {
    const summary: ArtifactInputSummary = {
      normativeSatisfied: ["plan_path"],
      informationalPresent: [],
      informationalAbsent: ["context_doc"],
    };
    const output: DispatchStepOutput = {
      stepName: "implement",
      effects: [],
      artifactInputSummary: summary,
    };
    expect(output.artifactInputSummary?.normativeSatisfied).toContain(
      "plan_path",
    );
    expect(output.artifactInputSummary?.informationalAbsent).toContain(
      "context_doc",
    );
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — type shapes and static validation
// ---------------------------------------------------------------------------

describe("ReconciliationAuthorizationSource type and constants", () => {
  it("RECONCILIATION_AUTHORIZATION_SOURCES contains all four valid sources", () => {
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("user");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("runtime");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("review-gate");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toContain("security-gate");
    expect(RECONCILIATION_AUTHORIZATION_SOURCES).toHaveLength(4);
  });

  it("RECONCILIATION_REASONS contains all four closed built-in values", () => {
    expect(RECONCILIATION_REASONS).toContain("execution-mismatch");
    expect(RECONCILIATION_REASONS).toContain("user-revision-request");
    expect(RECONCILIATION_REASONS).toContain("review-rejection");
    expect(RECONCILIATION_REASONS).toContain("security-rejection");
    expect(RECONCILIATION_REASONS).toHaveLength(4);
  });

  it("ReconcileExecutionInput type accepts all required fields", () => {
    const input: ReconcileExecutionInput = {
      workflowInstanceId: wfId,
      leaseId,
      reason: "user-revision-request",
      authorizationSource: "user",
    };
    expect(input.reason).toBe("user-revision-request");
    expect(input.authorizationSource).toBe("user");
  });

  it("ReconcileExecutionInput accepts optional triggeringStepName and context", () => {
    const input: ReconcileExecutionInput = {
      workflowInstanceId: wfId,
      leaseId,
      reason: "review-rejection",
      authorizationSource: "review-gate",
      triggeringStepName: "security-review",
      metadata: { stepIndex: 2 },
    };
    expect(input.triggeringStepName).toBe("security-review");
    expect(input.metadata?.stepIndex).toBe(2);
  });

  it("ReconcileExecutionOutput type shape: handlerFound, handlerStepName, effects", () => {
    const output: ReconcileExecutionOutput = {
      handlerFound: true,
      handlerStepName: "plan",
      effects: [
        {
          kind: "dispatch-agent",
          runAgent: {
            kind: "run-agent",
            agentName: "pattern",
            agentDescriptor: {
              name: "pattern",
              composedPrompt: "",
              models: [],
              mode: "subagent",
              skills: [],
              delegationTargets: [],
              effectiveToolPolicy: {
                read: "allow",
                write: "allow",
                execute: "allow",
                delegate: "deny",
                network: "ask",
              },
              rawToolPolicy: undefined,
            },
            effectiveToolPolicy: {
              read: "allow",
              write: "allow",
              execute: "allow",
              delegate: "deny",
              network: "ask",
            },
            rawToolPolicy: undefined,
            resolvedSkills: [],
          },
        },
      ],
    };
    expect(output.handlerFound).toBe(true);
    expect(output.handlerStepName).toBe("plan");
    expect(output.effects).toHaveLength(1);
  });

  it("ReconcileExecutionOutput with handlerFound: false has no handlerStepName", () => {
    const output: ReconcileExecutionOutput = {
      handlerFound: false,
      effects: [
        {
          kind: "pause-execution",
          workflowInstanceId: wfId,
          reason: "Reconciliation: no handler found",
        },
      ],
    };
    expect(output.handlerFound).toBe(false);
    expect(output.handlerStepName).toBeUndefined();
    expect(output.effects[0]?.kind).toBe("pause-execution");
  });
});

// ---------------------------------------------------------------------------
// validateReconciliationSource — authorized source enforcement
// ---------------------------------------------------------------------------

describe("validateReconciliationSource", () => {
  it("accepts 'user' for 'user-revision-request'", () => {
    const result = validateReconciliationSource(
      "user-revision-request",
      "user",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'runtime' for 'execution-mismatch'", () => {
    const result = validateReconciliationSource(
      "execution-mismatch",
      "runtime",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'review-gate' for 'review-rejection'", () => {
    const result = validateReconciliationSource(
      "review-rejection",
      "review-gate",
    );
    expect(result.isOk()).toBe(true);
  });

  it("accepts 'security-gate' for 'security-rejection'", () => {
    const result = validateReconciliationSource(
      "security-rejection",
      "security-gate",
    );
    expect(result.isOk()).toBe(true);
  });

  it("rejects 'user' for 'execution-mismatch' (must be 'runtime')", () => {
    const result = validateReconciliationSource("execution-mismatch", "user");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("execution-mismatch");
    expect(result.error.message).toContain("runtime");
    expect(result.error.rule).toBe("reconciliationSource");
  });

  it("rejects 'user' for 'review-rejection' (must be 'review-gate')", () => {
    const result = validateReconciliationSource("review-rejection", "user");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("review-rejection");
    expect(result.error.message).toContain("review-gate");
  });

  it("rejects 'user' for 'security-rejection' (must be 'security-gate')", () => {
    const result = validateReconciliationSource("security-rejection", "user");
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("security-rejection");
    expect(result.error.message).toContain("security-gate");
  });

  it("rejects 'runtime' for 'user-revision-request' (must be 'user')", () => {
    const result = validateReconciliationSource(
      "user-revision-request",
      "runtime",
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    expect(result.error.message).toContain("user-revision-request");
    expect(result.error.message).toContain('"user"');
  });

  it("rejects 'review-gate' for 'security-rejection' (must be 'security-gate')", () => {
    const result = validateReconciliationSource(
      "security-rejection",
      "review-gate",
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("rejects 'security-gate' for 'review-rejection' (must be 'review-gate')", () => {
    const result = validateReconciliationSource(
      "review-rejection",
      "security-gate",
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — runtime enforcement tests
// ---------------------------------------------------------------------------

describe("reconcileExecution (Runtime Store)", () => {
  /**
   * Minimal workflow config for reconciliation tests.
   *
   * Step order: plan → implement → security-review
   * - plan: has reconciliation_handlers for execution-mismatch and user-revision-request
   * - implement: has reconciliation_handlers for user-revision-request
   * - security-review: no handlers (gate step)
   */
  const reconcileWorkflows: Record<
    string,
    WorkflowExecutionContext["workflows"][string]
  > = {
    "reconcile-workflow": {
      name: "reconcile-workflow",
      description: "Test workflow for reconciliation",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create plan",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: {
            method: "plan_created",
            plan_name: "{{instance.slug}}",
          },
          reconciliation_handlers: [
            { reason: "execution-mismatch" },
            { reason: "user-revision-request" },
          ],
        },
        {
          name: "implement",
          display_name: "Implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement the plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "security-review",
          display_name: "Security review",
          type: "gate",
          agent: "warp",
          prompt: "Review security for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
          // No reconciliation_handlers — fail-closed path
        },
      ],
    },
  };

  const reconcileContext: WorkflowExecutionContext = {
    workflowName: "reconcile-workflow",
    goal: "Build secure feature",
    slug: "build-secure-feature",
    workflows: reconcileWorkflows,
  };

  /**
   * Helper: start an execution for a new workflow instance and return both
   * the instance ID and the acquired lease ID.
   */
  async function startReconcileInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`reconcile-wf-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: reconcileContext,
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // -------------------------------------------------------------------------
  // Validation errors
  // -------------------------------------------------------------------------

  it("returns validation error for missing workflowInstanceId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: "" as typeof wfId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("workflowInstanceId");
    }
  });

  it("returns validation error for missing leaseId", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId: "" as typeof leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("leaseId");
    }
  });

  it("returns validation error for missing reason", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "" as "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("reason");
    }
  });

  it("returns validation error for missing authorizationSource", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "" as ReconciliationAuthorizationSource,
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
    if (result.error.type === "validation") {
      expect(result.error.field).toBe("authorizationSource");
    }
  });

  // -------------------------------------------------------------------------
  // Authorized source enforcement
  // -------------------------------------------------------------------------

  it("rejects unauthorized source for 'user-revision-request' (must be 'user')", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "runtime", // wrong source
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("reconciliationSource");
      expect(result.error.message).toContain("user-revision-request");
    }
  });

  it("rejects unauthorized source for 'execution-mismatch' (must be 'runtime')", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "execution-mismatch",
        authorizationSource: "user", // wrong source
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.message).toContain("execution-mismatch");
      expect(result.error.message).toContain("runtime");
    }
  });

  it("rejects unauthorized source for 'review-rejection' (must be 'review-gate')", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "review-rejection",
        authorizationSource: "user", // wrong source
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  it("rejects unauthorized source for 'security-rejection' (must be 'security-gate')", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "security-rejection",
        authorizationSource: "review-gate", // wrong source
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
  });

  // -------------------------------------------------------------------------
  // Lease validation
  // -------------------------------------------------------------------------

  it("returns lease_conflict when no active lease exists", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  it("returns lease_conflict when leaseId does not match active lease", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId } = await startReconcileInstance(
      store,
      "lease-mismatch",
    );
    const fakeLeaseId = createExecutionLeaseId("fake-lease-id-reconcile");

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: fakeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("lease_conflict");
  });

  // -------------------------------------------------------------------------
  // Fail-closed: no context provided
  // -------------------------------------------------------------------------

  it("fails closed with pause-execution when no context is provided", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "no-context",
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        // no context
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(false);
    expect(result.value.handlerStepName).toBeUndefined();
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");

    // Verify instance is paused
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  // -------------------------------------------------------------------------
  // Fail-closed: no handler declared for the reason
  // -------------------------------------------------------------------------

  it("fails closed with pause-execution when no upstream handler exists for the reason", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "no-handler",
    );

    // Set currentStepName to 'security-review' (no handlers declared)
    await store.instances.update(instanceId, {
      currentStepName: "security-review",
    });

    // Trigger reconciliation with 'security-rejection' from security-review step.
    // No step upstream of security-review has a security-rejection handler.
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "security-rejection",
        authorizationSource: "security-gate",
        triggeringStepName: "security-review",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(false);
    expect(result.value.handlerStepName).toBeUndefined();
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");

    // Verify instance is paused
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("paused");
  });

  // -------------------------------------------------------------------------
  // Nearest-upstream handler resolution
  // -------------------------------------------------------------------------

  it("routes to nearest upstream handler for 'user-revision-request' from 'security-review'", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "nearest-upstream",
    );

    // Set currentStepName to 'security-review'
    await store.instances.update(instanceId, {
      currentStepName: "security-review",
    });

    // Trigger reconciliation from security-review.
    // Nearest upstream handler for 'user-revision-request':
    //   - implement (index 1) has user-revision-request handler → nearest
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "security-review",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    // 'implement' is the nearest upstream handler (closer than 'plan')
    expect(result.value.handlerStepName).toBe("implement");
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("dispatch-agent");
    if (result.value.effects[0]?.kind === "dispatch-agent") {
      expect(result.value.effects[0].runAgent.agentName).toBe("shuttle");
    }

    // Verify instance currentStepName updated to handler step
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.currentStepName).toBe("implement");
    expect(instanceResult.value.status).toBe("running");
  });

  it("routes to 'plan' for 'user-revision-request' from 'implement' (skips implement itself)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "from-implement",
    );

    // Set currentStepName to 'implement'
    await store.instances.update(instanceId, {
      currentStepName: "implement",
    });

    // Trigger reconciliation from implement.
    // Nearest upstream handler for 'user-revision-request':
    //   - plan (index 0) has user-revision-request handler → only option upstream of implement
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "implement",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
    expect(result.value.effects).toHaveLength(1);
    expect(result.value.effects[0]?.kind).toBe("dispatch-agent");
    if (result.value.effects[0]?.kind === "dispatch-agent") {
      expect(result.value.effects[0].runAgent.agentName).toBe("pattern");
    }
  });

  it("routes to 'plan' for 'execution-mismatch' from 'security-review'", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "exec-mismatch",
    );

    await store.instances.update(instanceId, {
      currentStepName: "security-review",
    });

    // Only 'plan' has an execution-mismatch handler
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "execution-mismatch",
        authorizationSource: "runtime",
        triggeringStepName: "security-review",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
    expect(result.value.effects[0]?.kind).toBe("dispatch-agent");
  });

  it("fails closed for 'execution-mismatch' from 'plan' (no upstream steps)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "from-plan",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan",
    });

    // 'plan' is the first step — no upstream steps to search
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "execution-mismatch",
        authorizationSource: "runtime",
        triggeringStepName: "plan",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
  });

  it("uses instance.currentStepName when triggeringStepName is omitted", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "current-step",
    );

    // Set currentStepName to 'security-review'
    await store.instances.update(instanceId, {
      currentStepName: "security-review",
    });

    // No triggeringStepName — engine uses instance.currentStepName
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        // triggeringStepName omitted
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Should route to 'implement' (nearest upstream handler for user-revision-request)
    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("implement");
  });

  it("dispatched handler effect has composedPrompt === '' (security invariant)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "security-prompt",
    );

    await store.instances.update(instanceId, {
      currentStepName: "security-review",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "security-review",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const effect = result.value.effects[0];
    if (effect?.kind === "dispatch-agent") {
      // Security invariant: composedPrompt must be empty string
      expect(effect.runAgent.agentDescriptor.composedPrompt).toBe("");
    }
  });

  it("returns not_found when workflow instance does not exist", async () => {
    const store = createInMemoryRuntimeStore();
    const nonExistentId = createWorkflowInstanceId("non-existent-reconcile-id");

    // Acquire a lease bound to the non-existent ID so lease check passes
    const leaseResult = await store.leases.acquire({
      workflowInstanceId: nonExistentId,
      ownerId: createOwnerId("owner-reconcile-not-found"),
      ttlMs: 3_600_000,
    });
    if (!leaseResult.isOk()) throw new Error("lease acquire failed");
    const boundLeaseId = leaseResult.value.id;

    const result = await reconcileExecution(
      {
        workflowInstanceId: nonExistentId,
        leaseId: boundLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        context: reconcileContext,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowInstance");
    }
  });

  it("returns not_found when workflow config is not in context.workflows", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startReconcileInstance(
      store,
      "missing-workflow",
    );

    // Context with an empty workflows map
    const emptyContext: WorkflowExecutionContext = {
      workflowName: "reconcile-workflow",
      goal: "Build secure feature",
      slug: "build-secure-feature",
      workflows: {}, // workflow not present
    };

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        context: emptyContext,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("not_found");
    if (result.error.type === "not_found") {
      expect(result.error.entity).toBe("WorkflowConfig");
    }
  });

  it("metadata with denied key is rejected before any store operations", async () => {
    const store = createInMemoryRuntimeStore();
    const result = await reconcileExecution(
      {
        workflowInstanceId: wfId,
        leaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        metadata: { token: "secret" } as Record<
          string,
          string | number | boolean
        >,
      },
      store,
    );
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("validation");
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — gate re-run behavior (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("reconcileExecution — gate re-run (Spec 22 Unit 3)", () => {
  /**
   * Workflow for gate re-run tests.
   *
   * Step order: plan → implement → review-gate → security-gate
   * - plan: has reconciliation_handlers for execution-mismatch and user-revision-request
   * - implement: has reconciliation_handlers for user-revision-request, review-rejection, security-rejection
   * - review-gate: gate step (no handlers)
   * - security-gate: gate step (no handlers)
   */
  const gateReRunWorkflows: Record<
    string,
    WorkflowExecutionContext["workflows"][string]
  > = {
    "gate-rerun-workflow": {
      name: "gate-rerun-workflow",
      description: "Test workflow for gate re-run tests",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create plan",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          reconciliation_handlers: [
            { reason: "execution-mismatch" },
            { reason: "user-revision-request" },
          ],
        },
        {
          name: "implement",
          display_name: "Implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement the plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          reconciliation_handlers: [
            { reason: "user-revision-request" },
            { reason: "review-rejection" },
            { reason: "security-rejection" },
          ],
        },
        {
          name: "review-gate",
          display_name: "Review gate",
          type: "gate",
          agent: "weft",
          prompt: "Review the implementation for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
          // No reconciliation_handlers — gate step
        },
        {
          name: "security-gate",
          display_name: "Security gate",
          type: "gate",
          agent: "warp",
          prompt: "Security audit for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
          // No reconciliation_handlers — gate step
        },
      ],
    },
  };

  const gateReRunContext: WorkflowExecutionContext = {
    workflowName: "gate-rerun-workflow",
    goal: "Build secure feature",
    slug: "build-secure-feature",
    workflows: gateReRunWorkflows,
  };

  async function startGateReRunInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`gate-rerun-wf-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: gateReRunContext,
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  it("review-rejection: gateReRunStepName is set to the triggering step name", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startGateReRunInstance(
      store,
      "review-rerun",
    );

    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "review-rejection",
        authorizationSource: "review-gate",
        triggeringStepName: "review-gate",
        context: gateReRunContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("implement");
    // Gate re-run: gateReRunStepName must be set to the triggering gate step
    expect(result.value.gateReRunStepName).toBe("review-gate");
  });

  it("security-rejection: gateReRunStepName is set to the triggering step name", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startGateReRunInstance(
      store,
      "security-rerun",
    );

    await store.instances.update(instanceId, {
      currentStepName: "security-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "security-rejection",
        authorizationSource: "security-gate",
        triggeringStepName: "security-gate",
        context: gateReRunContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("implement");
    // Gate re-run: gateReRunStepName must be set to the triggering gate step
    expect(result.value.gateReRunStepName).toBe("security-gate");
  });

  it("user-revision-request: gateReRunStepName is NOT set (not gate-originated)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startGateReRunInstance(
      store,
      "user-revision-no-rerun",
    );

    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "review-gate",
        context: gateReRunContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // No gate re-run for user-revision-request
    expect(result.value.gateReRunStepName).toBeUndefined();
  });

  it("execution-mismatch: gateReRunStepName is NOT set (not gate-originated)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startGateReRunInstance(
      store,
      "exec-mismatch-no-rerun",
    );

    await store.instances.update(instanceId, {
      currentStepName: "security-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "execution-mismatch",
        authorizationSource: "runtime",
        triggeringStepName: "security-gate",
        context: gateReRunContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // No gate re-run for execution-mismatch
    expect(result.value.gateReRunStepName).toBeUndefined();
  });

  it("review-rejection fail-closed: gateReRunStepName is still set even when no handler found", async () => {
    // Workflow with no handlers for review-rejection
    const noHandlerWorkflows: Record<
      string,
      WorkflowExecutionContext["workflows"][string]
    > = {
      "no-handler-workflow": {
        name: "no-handler-workflow",
        description: "Workflow with no review-rejection handlers",
        version: 1,
        steps: [
          {
            name: "plan",
            display_name: "Plan",
            type: "autonomous",
            agent: "pattern",
            prompt: "Plan for {{instance.goal}}",
            completion: { method: "agent_signal" },
            // No review-rejection handler
          },
          {
            name: "review-gate",
            display_name: "Review gate",
            type: "gate",
            agent: "weft",
            prompt: "Review for {{instance.goal}}",
            completion: { method: "review_verdict" },
            on_reject: "pause",
          },
        ],
      },
    };

    const noHandlerContext: WorkflowExecutionContext = {
      workflowName: "no-handler-workflow",
      goal: "Test goal",
      slug: "test-goal",
      workflows: noHandlerWorkflows,
    };

    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("gate-rerun-no-handler");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-no-handler",
        context: noHandlerContext,
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const activeLeaseId = startResult.value.leaseId;

    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "review-rejection",
        authorizationSource: "review-gate",
        triggeringStepName: "review-gate",
        context: noHandlerContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Fail-closed: no handler found
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
    // Gate re-run is still set even when failing closed — adapter needs context
    expect(result.value.gateReRunStepName).toBe("review-gate");
  });

  it("review-rejection: gateReRunStepName uses instance.currentStepName when triggeringStepName is omitted", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startGateReRunInstance(
      store,
      "review-rerun-current-step",
    );

    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    // No triggeringStepName — engine uses instance.currentStepName
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "review-rejection",
        authorizationSource: "review-gate",
        // triggeringStepName omitted
        context: gateReRunContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    // gateReRunStepName should be the current step (review-gate)
    expect(result.value.gateReRunStepName).toBe("review-gate");
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — before-plan exclusion (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("reconcileExecution — before-plan exclusion (Spec 22 Unit 3)", () => {
  /**
   * Workflow with before-plan extension point.
   *
   * Step order: spec-review (before-plan) → plan (planning) → implement → review-gate
   *
   * The spec-review step is a before-plan step and must NOT participate in
   * reconciliation handler resolution, even if it declares reconciliation_handlers.
   *
   * Note: In practice, the schema layer prevents before-plan steps from having
   * reconciliation_handlers. This test verifies the runtime defense-in-depth
   * guarantee by simulating a step that has handlers but is in the before-plan
   * position (e.g. after config merge or composition bypasses schema validation).
   */
  const beforePlanWorkflows: Record<
    string,
    WorkflowExecutionContext["workflows"][string]
  > = {
    "before-plan-workflow": {
      name: "before-plan-workflow",
      description: "Workflow with before-plan extension point",
      version: 1,
      extension_points: { before_plan: true },
      steps: [
        {
          name: "spec-review",
          display_name: "Spec review (before-plan)",
          type: "gate",
          agent: "weft",
          prompt: "Review spec for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
          // This step is in the before-plan position. Even if it had
          // reconciliation_handlers, the runtime must skip it.
          // We add a handler here to test the runtime exclusion.
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "plan",
          display_name: "Plan (planning step)",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          role: "planning",
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "implement",
          display_name: "Implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement for {{instance.goal}}",
          completion: { method: "agent_signal" },
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "review-gate",
          display_name: "Review gate",
          type: "gate",
          agent: "weft",
          prompt: "Review for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
      ],
    },
  };

  const beforePlanContext: WorkflowExecutionContext = {
    workflowName: "before-plan-workflow",
    goal: "Build feature with spec",
    slug: "build-feature-with-spec",
    workflows: beforePlanWorkflows,
  };

  async function startBeforePlanInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`before-plan-wf-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: beforePlanContext,
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  it("before-plan step is skipped during handler resolution even if it declares reconciliation_handlers", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startBeforePlanInstance(
      store,
      "skip-before-plan",
    );

    // Set current step to review-gate (downstream of all steps)
    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    // Trigger user-revision-request from review-gate.
    // The nearest upstream handler search walks: implement → plan → spec-review
    // spec-review is a before-plan step and must be SKIPPED at runtime.
    // The nearest valid handler is 'implement' (not spec-review).
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "review-gate",
        context: beforePlanContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    // Must route to 'implement', not 'spec-review' (before-plan step is excluded)
    expect(result.value.handlerStepName).toBe("implement");
  });

  it("before-plan step is skipped: routes to planning step when implement has no handler", async () => {
    // Workflow where only spec-review (before-plan) and plan have handlers,
    // but implement does not. The engine must skip spec-review and route to plan.
    const noImplementHandlerWorkflows: Record<
      string,
      WorkflowExecutionContext["workflows"][string]
    > = {
      "no-implement-handler-workflow": {
        name: "no-implement-handler-workflow",
        description: "Workflow where implement has no handler",
        version: 1,
        extension_points: { before_plan: true },
        steps: [
          {
            name: "spec-review",
            display_name: "Spec review (before-plan)",
            type: "gate",
            agent: "weft",
            prompt: "Review spec for {{instance.goal}}",
            completion: { method: "review_verdict" },
            on_reject: "pause",
            // before-plan step with handler — must be excluded at runtime
            reconciliation_handlers: [{ reason: "user-revision-request" }],
          },
          {
            name: "plan",
            display_name: "Plan (planning step)",
            type: "autonomous",
            agent: "pattern",
            prompt: "Create a plan for {{instance.goal}}",
            completion: { method: "agent_signal" },
            role: "planning",
            reconciliation_handlers: [{ reason: "user-revision-request" }],
          },
          {
            name: "implement",
            display_name: "Implement",
            type: "autonomous",
            agent: "shuttle",
            prompt: "Implement for {{instance.goal}}",
            completion: { method: "agent_signal" },
            // No reconciliation_handlers on implement
          },
          {
            name: "review-gate",
            display_name: "Review gate",
            type: "gate",
            agent: "weft",
            prompt: "Review for {{instance.goal}}",
            completion: { method: "review_verdict" },
            on_reject: "pause",
          },
        ],
      },
    };

    const noImplementHandlerContext: WorkflowExecutionContext = {
      workflowName: "no-implement-handler-workflow",
      goal: "Build feature",
      slug: "build-feature",
      workflows: noImplementHandlerWorkflows,
    };

    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("before-plan-skip-to-plan");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-skip-to-plan",
        context: noImplementHandlerContext,
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const activeLeaseId = startResult.value.leaseId;

    await store.instances.update(instanceId, {
      currentStepName: "review-gate",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "review-gate",
        context: noImplementHandlerContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.handlerFound).toBe(true);
    // Must route to 'plan' (planning step), skipping spec-review (before-plan)
    expect(result.value.handlerStepName).toBe("plan");
  });

  it("before-plan exclusion: fails closed when only before-plan steps have handlers", async () => {
    // Workflow where only the before-plan step has a handler — no valid handler
    // exists after exclusion, so the engine must fail closed.
    const onlyBeforePlanHandlerWorkflows: Record<
      string,
      WorkflowExecutionContext["workflows"][string]
    > = {
      "only-before-plan-handler-workflow": {
        name: "only-before-plan-handler-workflow",
        description: "Workflow where only before-plan step has handler",
        version: 1,
        extension_points: { before_plan: true },
        steps: [
          {
            name: "spec-review",
            display_name: "Spec review (before-plan)",
            type: "gate",
            agent: "weft",
            prompt: "Review spec for {{instance.goal}}",
            completion: { method: "review_verdict" },
            on_reject: "pause",
            // Only handler — but it's a before-plan step, so it must be excluded
            reconciliation_handlers: [{ reason: "user-revision-request" }],
          },
          {
            name: "plan",
            display_name: "Plan (planning step)",
            type: "autonomous",
            agent: "pattern",
            prompt: "Create a plan for {{instance.goal}}",
            completion: { method: "agent_signal" },
            role: "planning",
            // No handler on plan
          },
          {
            name: "implement",
            display_name: "Implement",
            type: "autonomous",
            agent: "shuttle",
            prompt: "Implement for {{instance.goal}}",
            completion: { method: "agent_signal" },
            // No handler on implement
          },
        ],
      },
    };

    const onlyBeforePlanContext: WorkflowExecutionContext = {
      workflowName: "only-before-plan-handler-workflow",
      goal: "Test goal",
      slug: "test-goal",
      workflows: onlyBeforePlanHandlerWorkflows,
    };

    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("before-plan-only-handler");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-only-before-plan",
        context: onlyBeforePlanContext,
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const activeLeaseId = startResult.value.leaseId;

    await store.instances.update(instanceId, {
      currentStepName: "implement",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "implement",
        context: onlyBeforePlanContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // Fail-closed: spec-review is excluded (before-plan), no other handler exists
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
  });

  it("workflow without extension_points.before_plan: no steps are excluded", async () => {
    // Workflow without before-plan extension point — all steps are eligible
    const noExtensionWorkflows: Record<
      string,
      WorkflowExecutionContext["workflows"][string]
    > = {
      "no-extension-workflow": {
        name: "no-extension-workflow",
        description: "Workflow without before-plan extension",
        version: 1,
        // No extension_points
        steps: [
          {
            name: "early-step",
            display_name: "Early step",
            type: "autonomous",
            agent: "shuttle",
            prompt: "Early step for {{instance.goal}}",
            completion: { method: "agent_signal" },
            // This step has a handler and is NOT a before-plan step
            reconciliation_handlers: [{ reason: "user-revision-request" }],
          },
          {
            name: "implement",
            display_name: "Implement",
            type: "autonomous",
            agent: "shuttle",
            prompt: "Implement for {{instance.goal}}",
            completion: { method: "agent_signal" },
          },
        ],
      },
    };

    const noExtensionContext: WorkflowExecutionContext = {
      workflowName: "no-extension-workflow",
      goal: "Test goal",
      slug: "test-goal",
      workflows: noExtensionWorkflows,
    };

    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("no-extension-wf");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-no-extension",
        context: noExtensionContext,
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const activeLeaseId = startResult.value.leaseId;

    await store.instances.update(instanceId, {
      currentStepName: "implement",
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "implement",
        context: noExtensionContext,
      },
      store,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    // early-step is NOT excluded (no before-plan extension point)
    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("early-step");
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — immutable completed plan tasks (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("reconcileExecution — immutable completed plan tasks (Spec 22 Unit 3)", () => {
  /**
   * Workflow for immutable plan tests.
   *
   * Step order: plan → implement → review-gate
   * - plan: plan_complete completion method (plan-oriented step)
   * - implement: agent_signal completion method
   * - review-gate: review_verdict gate step
   *
   * plan has reconciliation_handlers for user-revision-request.
   * implement has reconciliation_handlers for user-revision-request.
   */
  const immutablePlanWorkflows: Record<
    string,
    WorkflowExecutionContext["workflows"][string]
  > = {
    "immutable-plan-workflow": {
      name: "immutable-plan-workflow",
      description: "Test workflow for immutable plan tests",
      version: 1,
      steps: [
        {
          name: "plan",
          display_name: "Create plan",
          type: "autonomous",
          agent: "pattern",
          prompt: "Create a plan for {{instance.goal}}",
          completion: {
            method: "plan_complete",
            plan_name: "{{instance.slug}}",
          },
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "implement",
          display_name: "Implement",
          type: "autonomous",
          agent: "shuttle",
          prompt: "Implement the plan for {{instance.goal}}",
          completion: { method: "agent_signal" },
          reconciliation_handlers: [{ reason: "user-revision-request" }],
        },
        {
          name: "review-gate",
          display_name: "Review gate",
          type: "gate",
          agent: "weft",
          prompt: "Review the implementation for {{instance.goal}}",
          completion: { method: "review_verdict" },
          on_reject: "pause",
        },
      ],
    },
  };

  const immutablePlanContext: WorkflowExecutionContext = {
    workflowName: "immutable-plan-workflow",
    goal: "Build feature",
    slug: "build-feature",
    workflows: immutablePlanWorkflows,
  };

  async function startImmutablePlanInstance(
    store: ReturnType<typeof createInMemoryRuntimeStore>,
    suffix: string,
  ) {
    const instanceId = createWorkflowInstanceId(`immutable-plan-wf-${suffix}`);
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: `owner-${suffix}`,
        context: immutablePlanContext,
      },
      store,
    );
    if (!startResult.isOk())
      throw new Error(`startExecution failed: ${JSON.stringify(startResult)}`);
    return { instanceId, activeLeaseId: startResult.value.leaseId };
  }

  // -------------------------------------------------------------------------
  // Core immutability protection
  // -------------------------------------------------------------------------

  it("rejects reconciliation with policy_decision when triggering step's plan is complete", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "complete-plan-reject",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan",
    });

    // Plan is complete — all checkboxes checked
    const planProvider = new MockPlanStateProvider(
      { "build-feature": true }, // planExists
      { "build-feature": true }, // isPlanComplete → true
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("completed_plan_immutability");
      expect(result.error.message).toContain("build-feature");
      expect(result.error.message).toContain("immutable");
      expect(result.error.message).toContain("follow-up tasks");
    }
  });

  it("allows reconciliation when triggering step's plan is NOT complete", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "incomplete-plan-allow",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan",
    });

    // Plan is NOT complete — has remaining checkboxes
    const planProvider = new MockPlanStateProvider(
      { "build-feature": true }, // planExists
      { "build-feature": false }, // isPlanComplete → false
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    // Reconciliation should proceed — plan is not complete
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // No upstream handler for user-revision-request before 'plan' → fail-closed pause
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
  });

  it("skips immutability check when planStateProvider is absent", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "no-provider-skip",
    );

    await store.instances.update(instanceId, {
      currentStepName: "plan",
    });

    // No planStateProvider — check is skipped regardless of plan state
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        // planStateProvider omitted
      },
      store,
    );

    // Reconciliation proceeds without plan check
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // No upstream handler before 'plan' → fail-closed pause
    expect(result.value.handlerFound).toBe(false);
    expect(result.value.effects[0]?.kind).toBe("pause-execution");
  });

  it("skips immutability check when triggering step uses agent_signal (not plan-oriented)", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "agent-signal-skip",
    );

    await store.instances.update(instanceId, {
      currentStepName: "implement",
    });

    // Provider always returns complete — but implement uses agent_signal, not plan_complete
    const planProvider = new MockPlanStateProvider(
      { "build-feature": true },
      { "build-feature": true }, // would block if checked
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "implement",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    // Reconciliation proceeds — implement is not plan-oriented
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Nearest upstream handler for user-revision-request from implement → plan
    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
  });

  it("skips immutability check when triggeringStepName is omitted and current step is not plan-oriented", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "no-triggering-step",
    );

    // Set current step to implement (agent_signal — not plan-oriented)
    await store.instances.update(instanceId, {
      currentStepName: "implement",
    });

    const planProvider = new MockPlanStateProvider(
      { "build-feature": true },
      { "build-feature": true }, // would block if checked
    );

    // No triggeringStepName — engine uses instance.currentStepName (implement)
    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        // triggeringStepName omitted
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    // Reconciliation proceeds — implement is not plan-oriented
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.handlerFound).toBe(true);
    expect(result.value.handlerStepName).toBe("plan");
  });

  it("rejects reconciliation when plan_created step's plan is complete", async () => {
    // Workflow with plan_created completion method
    const planCreatedWorkflows: Record<
      string,
      WorkflowExecutionContext["workflows"][string]
    > = {
      "plan-created-workflow": {
        name: "plan-created-workflow",
        description: "Workflow with plan_created completion",
        version: 1,
        steps: [
          {
            name: "plan",
            display_name: "Create plan",
            type: "autonomous",
            agent: "pattern",
            prompt: "Create a plan for {{instance.goal}}",
            completion: {
              method: "plan_created",
              plan_name: "{{instance.slug}}",
            },
            reconciliation_handlers: [{ reason: "user-revision-request" }],
          },
          {
            name: "implement",
            display_name: "Implement",
            type: "autonomous",
            agent: "shuttle",
            prompt: "Implement for {{instance.goal}}",
            completion: { method: "agent_signal" },
          },
        ],
      },
    };

    const planCreatedContext: WorkflowExecutionContext = {
      workflowName: "plan-created-workflow",
      goal: "Build feature",
      slug: "build-feature",
      workflows: planCreatedWorkflows,
    };

    const store = createInMemoryRuntimeStore();
    const instanceId = createWorkflowInstanceId("plan-created-immutable");
    const startResult = await startExecution(
      {
        workflowInstanceId: instanceId,
        ownerId: "owner-plan-created",
        context: planCreatedContext,
      },
      store,
    );
    if (!startResult.isOk()) throw new Error("startExecution failed");
    const activeLeaseId = startResult.value.leaseId;

    await store.instances.update(instanceId, { currentStepName: "plan" });

    // Plan is complete
    const planProvider = new MockPlanStateProvider(
      { "build-feature": true },
      { "build-feature": true }, // isPlanComplete → true
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: planCreatedContext,
        planStateProvider: planProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("policy_decision");
    if (result.error.type === "policy_decision") {
      expect(result.error.rule).toBe("completed_plan_immutability");
    }
  });

  it("propagates PlanStateProvider error as persistence error", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "provider-error",
    );

    await store.instances.update(instanceId, { currentStepName: "plan" });

    // Provider returns an error
    const planProvider = new MockPlanStateProvider({}, {}, undefined, {
      type: "ProviderUnavailable",
      cause: new Error("I/O failure"),
    });

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.type).toBe("persistence");
  });

  it("instance is NOT modified when immutability check rejects reconciliation", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "no-state-mutation",
    );

    await store.instances.update(instanceId, { currentStepName: "plan" });

    const planProvider = new MockPlanStateProvider(
      { "build-feature": true },
      { "build-feature": true }, // complete → reject
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);

    // Instance status must remain unchanged (running, not paused or modified)
    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    // Status should still be running (not paused by reconciliation)
    expect(instanceResult.value.status).toBe("running");
    // currentStepName should still be "plan"
    expect(instanceResult.value.currentStepName).toBe("plan");
  });

  it("error message includes plan path and immutability guidance", async () => {
    const store = createInMemoryRuntimeStore();
    const { instanceId, activeLeaseId } = await startImmutablePlanInstance(
      store,
      "error-message-check",
    );

    await store.instances.update(instanceId, { currentStepName: "plan" });

    const planProvider = new MockPlanStateProvider(
      { "build-feature": true },
      { "build-feature": true },
    );

    const result = await reconcileExecution(
      {
        workflowInstanceId: instanceId,
        leaseId: activeLeaseId,
        reason: "user-revision-request",
        authorizationSource: "user",
        triggeringStepName: "plan",
        context: immutablePlanContext,
        planStateProvider: planProvider,
      },
      store,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    if (result.error.type === "policy_decision") {
      // Must reference the plan path
      expect(result.error.message).toContain(".weave/plans/build-feature.md");
      // Must explain the immutability rule
      expect(result.error.message).toContain("immutable");
      // Must guide toward follow-up tasks
      expect(result.error.message).toContain("follow-up tasks");
    }
  });
});

// ---------------------------------------------------------------------------
// reconcileExecution — runtime-contract.test.ts coverage (Spec 22 Unit 3)
// ---------------------------------------------------------------------------

describe("reconcileExecution — closed reason set enforcement", () => {
  it("all four closed reasons are accepted with their authorized sources", () => {
    const pairs: Array<
      [
        Parameters<typeof validateReconciliationSource>[0],
        Parameters<typeof validateReconciliationSource>[1],
      ]
    > = [
      ["execution-mismatch", "runtime"],
      ["user-revision-request", "user"],
      ["review-rejection", "review-gate"],
      ["security-rejection", "security-gate"],
    ];
    for (const [reason, source] of pairs) {
      const result = validateReconciliationSource(reason, source);
      expect(result.isOk()).toBe(true);
    }
  });

  it("all four reasons reject every non-authorized source", () => {
    const allSources: ReconciliationAuthorizationSource[] = [
      "user",
      "runtime",
      "review-gate",
      "security-gate",
    ];
    const authorizedMap: Record<string, string> = {
      "execution-mismatch": "runtime",
      "user-revision-request": "user",
      "review-rejection": "review-gate",
      "security-rejection": "security-gate",
    };

    for (const reason of RECONCILIATION_REASONS) {
      const authorized = authorizedMap[reason];
      for (const source of allSources) {
        if (source === authorized) continue;
        const result = validateReconciliationSource(
          reason,
          source as ReconciliationAuthorizationSource,
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe("policy_decision");
        }
      }
    }
  });
});
