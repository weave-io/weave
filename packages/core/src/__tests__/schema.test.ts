import { describe, expect, it } from "bun:test";
import {
  CompletionMethodSchema,
  OnRejectSchema,
  ToolPolicySchema,
  WorkflowConfigSchema,
  WorkflowStepSchema,
  WorkflowStepTypeSchema,
} from "../schema.js";

// ---------------------------------------------------------------------------
// ToolPolicySchema
// ---------------------------------------------------------------------------

describe("ToolPolicySchema", () => {
  it("accepts valid tool policy keys", () => {
    const r = ToolPolicySchema.safeParse({
      read: "allow",
      write: "deny",
      execute: "ask",
      network: "deny",
      delegate: "allow",
    });

    expect(r.success).toBe(true);
  });

  it("accepts execute and network permissions", () => {
    const r = ToolPolicySchema.safeParse({
      execute: "allow",
      network: "deny",
    });

    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ execute: "allow", network: "deny" });
    }
  });

  it("rejects unknown keys such as edit", () => {
    const r = ToolPolicySchema.safeParse({ edit: "allow" });

    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepTypeSchema
// ---------------------------------------------------------------------------

describe("WorkflowStepTypeSchema", () => {
  it("accepts valid step types", () => {
    expect(WorkflowStepTypeSchema.safeParse("autonomous").success).toBe(true);
    expect(WorkflowStepTypeSchema.safeParse("interactive").success).toBe(true);
    expect(WorkflowStepTypeSchema.safeParse("gate").success).toBe(true);
  });

  it("rejects invalid step type", () => {
    const result = WorkflowStepTypeSchema.safeParse("background");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CompletionMethodSchema
// ---------------------------------------------------------------------------

describe("CompletionMethodSchema", () => {
  it("accepts agent_signal (no extra fields)", () => {
    const r = CompletionMethodSchema.safeParse({ method: "agent_signal" });
    expect(r.success).toBe(true);
  });

  it("accepts user_confirm (no extra fields)", () => {
    const r = CompletionMethodSchema.safeParse({ method: "user_confirm" });
    expect(r.success).toBe(true);
  });

  it("accepts plan_created with plan_name", () => {
    const r = CompletionMethodSchema.safeParse({
      method: "plan_created",
      plan_name: "my-plan",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({ method: "plan_created", plan_name: "my-plan" });
    }
  });

  it("rejects plan_created without plan_name", () => {
    const r = CompletionMethodSchema.safeParse({ method: "plan_created" });
    expect(r.success).toBe(false);
  });

  it("accepts plan_complete with plan_name", () => {
    const r = CompletionMethodSchema.safeParse({
      method: "plan_complete",
      plan_name: "my-plan",
    });
    expect(r.success).toBe(true);
  });

  it("rejects plan_complete without plan_name", () => {
    const r = CompletionMethodSchema.safeParse({ method: "plan_complete" });
    expect(r.success).toBe(false);
  });

  it("accepts review_verdict (no extra fields)", () => {
    const r = CompletionMethodSchema.safeParse({ method: "review_verdict" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown completion method", () => {
    const r = CompletionMethodSchema.safeParse({ method: "unknown_method" });
    expect(r.success).toBe(false);
  });

  it("rejects missing method field", () => {
    const r = CompletionMethodSchema.safeParse({ plan_name: "x" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OnRejectSchema
// ---------------------------------------------------------------------------

describe("OnRejectSchema", () => {
  it("accepts pause, fail, retry", () => {
    expect(OnRejectSchema.safeParse("pause").success).toBe(true);
    expect(OnRejectSchema.safeParse("fail").success).toBe(true);
    expect(OnRejectSchema.safeParse("retry").success).toBe(true);
  });

  it("rejects invalid value", () => {
    expect(OnRejectSchema.safeParse("ignore").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepSchema
// ---------------------------------------------------------------------------

describe("WorkflowStepSchema", () => {
  const validStep = {
    name: "plan",
    type: "autonomous",
    agent: "pattern",
    prompt: "Do the thing.",
    completion: { method: "agent_signal" },
  } as const;

  it("accepts a valid step with required fields only", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
  });

  it("accepts a gate step with on_reject", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      type: "gate",
      on_reject: "pause",
    });
    expect(r.success).toBe(true);
  });

  it("rejects on_reject on a non-gate step", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      type: "autonomous",
      on_reject: "pause",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? "";
      expect(msg).toContain("on_reject");
    }
  });

  it("rejects missing required field: agent", () => {
    const { agent: _agent, ...noAgent } = validStep;
    const r = WorkflowStepSchema.safeParse(noAgent);
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p === "agent")).toBe(true);
    }
  });

  it("rejects missing required field: prompt", () => {
    const { prompt: _prompt, ...noPrompt } = validStep;
    const r = WorkflowStepSchema.safeParse(noPrompt);
    expect(r.success).toBe(false);
  });

  it("rejects missing required field: completion", () => {
    const { completion: _completion, ...noCompletion } = validStep;
    const r = WorkflowStepSchema.safeParse(noCompletion);
    expect(r.success).toBe(false);
  });

  it("rejects invalid type value", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      type: "background",
    });
    expect(r.success).toBe(false);
  });

  it("accepts step with inputs and outputs arrays", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      inputs: [{ name: "plan_path", description: "Path to the plan" }],
      outputs: [{ name: "result_path", description: "Path to the result" }],
    });
    expect(r.success).toBe(true);
  });

  it("accepts optional display_name", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      display_name: "Create implementation plan",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.display_name).toBe("Create implementation plan");
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowConfigSchema
// ---------------------------------------------------------------------------

describe("WorkflowConfigSchema", () => {
  const validStep = {
    name: "fix",
    type: "autonomous" as const,
    agent: "shuttle",
    prompt: "Fix the bug.",
    completion: { method: "agent_signal" as const },
  };

  it("accepts a valid workflow config", () => {
    const r = WorkflowConfigSchema.safeParse({
      description: "A simple workflow",
      version: 1,
      steps: [validStep],
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty steps array", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("steps"))).toBe(true);
    }
  });

  it("rejects missing version", () => {
    const r = WorkflowConfigSchema.safeParse({ steps: [validStep] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p === "version")).toBe(true);
    }
  });

  it("rejects non-integer version", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1.5,
      steps: [validStep],
    });
    expect(r.success).toBe(false);
  });

  it("rejects zero version (must be positive)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 0,
      steps: [validStep],
    });
    expect(r.success).toBe(false);
  });
});
