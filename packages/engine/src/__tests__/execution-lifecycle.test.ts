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
  type CompleteStepInput,
  type CompleteStepOutput,
  createExecutionLeaseId,
  createSessionSnapshotId,
  createWorkflowInstanceId,
  type DispatchAgentEffect,
  type DispatchStepInput,
  type DispatchStepOutput,
  type HandleUserInterruptInput,
  type HandleUserInterruptOutput,
  type LifecycleEffect,
  type LifecycleError,
  lifecycleLeaseConflictError,
  lifecycleNotFoundError,
  lifecyclePersistenceError,
  lifecyclePolicyDecisionError,
  lifecycleValidationError,
  type ObserveSessionInput,
  type ObserveSessionOutput,
  type ResumeExecutionInput,
  type ResumeExecutionOutput,
  type SafeMetadata,
  type StartExecutionInput,
  type StartExecutionOutput,
  type StepCompletionSignal,
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
    const cause = new Error("DB write failed");
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

  it("StartExecutionOutput carries leaseId and effects array", () => {
    const output: StartExecutionOutput = {
      leaseId,
      effects: [],
    };
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
