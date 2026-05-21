/**
 * Tests for execution-lifecycle.ts
 *
 * Verifies:
 * - Lifecycle input types accept valid values (runtime shape checks)
 * - Lifecycle error discriminants are correct
 * - LifecycleEffect union includes RunAgentEffect as a variant (via DispatchAgentEffect)
 * - Public import paths compile (imports from @weave/engine)
 * - SafeMetadata structural constraint
 * - Error factory helpers produce correct discriminants
 */

import { describe, expect, it } from "bun:test";
import type { RunAgentEffect } from "@weave/engine";
import {
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
  evaluateEffectiveToolPolicy,
  type HandleUserInterruptInput,
  type HandleUserInterruptOutput,
  handleUserInterrupt,
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
  queryError,
  type ResumeExecutionInput,
  type ResumeExecutionOutput,
  resumeExecution,
  type SafeMetadata,
  type StartExecutionInput,
  type StartExecutionOutput,
  type StepCompletionSignal,
  sanitizeMetadata,
  startExecution,
} from "@weave/engine";

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
  it("lifecycle error factories are importable from @weave/engine", () => {
    // These are already imported at the top of this file from @weave/engine.
    // If the imports compile and resolve, this test passes.
    expect(typeof lifecycleValidationError).toBe("function");
    expect(typeof lifecycleNotFoundError).toBe("function");
    expect(typeof lifecycleLeaseConflictError).toBe("function");
    expect(typeof lifecyclePersistenceError).toBe("function");
    expect(typeof lifecyclePolicyDecisionError).toBe("function");
  });

  it("ID factory helpers are importable from @weave/engine", () => {
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

  it("blocked outcome: updates instance to blocked status", async () => {
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
    expect(result.value.effects).toHaveLength(0);

    const instanceResult = await store.instances.getById(instanceId);
    expect(instanceResult.isOk()).toBe(true);
    if (!instanceResult.isOk()) return;
    expect(instanceResult.value.status).toBe("blocked");
  });

  it("failed outcome: updates instance to failed status with errorMessage", async () => {
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
    expect(result.value.effects).toHaveLength(0);

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
