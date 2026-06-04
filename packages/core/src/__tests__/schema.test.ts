import { describe, expect, it } from "bun:test";
import { ToolPermissionSchema, ToolPolicySchema } from "@weave/core";
import {
  AgentConfigSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  ExtendBeforePlanSchema,
  ExtensionPointsSchema,
  LogLevelSchema,
  OnRejectSchema,
  ReconciliationHandlerListSchema,
  ReconciliationHandlerSchema,
  ReconciliationReasonSchema,
  RoutingConfigSchema,
  RuntimeSettingsSchema,
  SettingsConfigSchema,
  WeaveConfigSchema,
  WorkflowConfigSchema,
  WorkflowStepRoleSchema,
  WorkflowStepSchema,
  WorkflowStepTypeSchema,
} from "../schema.js";

// ---------------------------------------------------------------------------
// @weave/core barrel — public API assertions
// ---------------------------------------------------------------------------

describe("@weave/core barrel exports", () => {
  it("exports ToolPermissionSchema as a Zod enum with allow/deny/ask", () => {
    expect(ToolPermissionSchema).toBeDefined();
    expect(ToolPermissionSchema.safeParse("allow").success).toBe(true);
    expect(ToolPermissionSchema.safeParse("deny").success).toBe(true);
    expect(ToolPermissionSchema.safeParse("ask").success).toBe(true);
    expect(ToolPermissionSchema.safeParse("unknown").success).toBe(false);
  });

  it("exports ToolPolicySchema as a Zod object with all five capabilities", () => {
    expect(ToolPolicySchema).toBeDefined();
    const r = ToolPolicySchema.safeParse({
      read: "allow",
      write: "deny",
      execute: "ask",
      delegate: "allow",
      network: "deny",
    });
    expect(r.success).toBe(true);
  });

  it("ToolPolicy type is importable (type-level assertion via ToolPolicySchema inference)", () => {
    // If ToolPolicy is not exported, this file would fail to compile.
    // We verify the runtime shape matches the expected structure.
    const r = ToolPolicySchema.safeParse({ read: "allow" });
    expect(r.success).toBe(true);
    if (r.success) {
      const policy: import("@weave/core").ToolPolicy = r.data;
      expect(policy.read).toBe("allow");
    }
  });

  it("ToolPermission type is importable (type-level assertion via ToolPermissionSchema inference)", () => {
    // If ToolPermission is not exported, this file would fail to compile.
    const parsed = ToolPermissionSchema.safeParse("allow");
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const perm: import("@weave/core").ToolPermission = parsed.data;
      expect(perm).toBe("allow");
    }
  });
});

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

  it("rejects unknown keys such as search", () => {
    const r = ToolPolicySchema.safeParse({ search: "ask" });

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

  it("accepts insert_before without insert_after", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      insert_before: "review",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insert_before).toBe("review");
      expect(r.data.insert_after).toBeUndefined();
    }
  });

  it("accepts insert_after without insert_before", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      insert_after: "plan",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insert_after).toBe("plan");
      expect(r.data.insert_before).toBeUndefined();
    }
  });

  it("rejects both insert_before and insert_after set simultaneously (BothInsertBeforeAndAfter)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      insert_before: "review",
      insert_after: "plan",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? "";
      expect(msg).toContain("BothInsertBeforeAndAfter");
    }
  });

  it("accepts step with neither insert_before nor insert_after (normal step)", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.insert_before).toBeUndefined();
      expect(r.data.insert_after).toBeUndefined();
    }
  });

  it("rejects insert_before: '' (empty string)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      insert_before: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("insert_before"))).toBe(true);
    }
  });

  it("rejects insert_after: '' (empty string)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      insert_after: "",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("insert_after"))).toBe(true);
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

  it("accepts extends field with a non-empty string", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extends: "base-workflow",
      steps: [validStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extends).toBe("base-workflow");
    }
  });

  it("accepts extends with empty steps array (extension workflow)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extends: "base-workflow",
      steps: [],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extends).toBe("base-workflow");
      expect(r.data.steps).toHaveLength(0);
    }
  });

  it("rejects empty steps without extends (no extension to relax the constraint)", () => {
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

  it("extends is optional — workflow without extends still works normally", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [validStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extends).toBeUndefined();
    }
  });

  it("rejects extends: '' (empty string)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extends: "",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("extends"))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // WorkflowConfigSchema — prompt_append and prompt_append_file (Spec 22 Unit 4)
  // -------------------------------------------------------------------------

  it("accepts workflow with prompt_append (workflow-scope append)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      prompt_append: "Always write tests for your changes.",
      steps: [validStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append).toBe("Always write tests for your changes.");
      expect(r.data.prompt_append_file).toBeUndefined();
    }
  });

  it("accepts workflow with prompt_append_file (workflow-scope append file)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      prompt_append_file: "workflow-guidance.md",
      steps: [validStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append_file).toBe("workflow-guidance.md");
      expect(r.data.prompt_append).toBeUndefined();
    }
  });

  it("accepts workflow without prompt_append or prompt_append_file (no workflow-scope append)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [validStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append).toBeUndefined();
      expect(r.data.prompt_append_file).toBeUndefined();
    }
  });

  it("rejects workflow with both prompt_append and prompt_append_file (mutually exclusive)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      prompt_append: "Inline guidance.",
      prompt_append_file: "workflow-guidance.md",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("mutually exclusive"))).toBe(true);
    }
  });

  it("rejects workflow with prompt_append_file '../bad.md' (path traversal)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      prompt_append_file: "../bad.md",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("relative path"))).toBe(true);
    }
  });

  it("rejects workflow with prompt_append_file '/etc/passwd' (absolute path)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      prompt_append_file: "/etc/passwd",
      steps: [validStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("relative path"))).toBe(true);
    }
  });

  it("accepts workflow with both workflow-level and step-level prompt_append (independent scopes)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [{ ...validStep, prompt_append: "Step-local guidance." }],
      prompt_append: "Workflow-wide guidance.",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append).toBe("Workflow-wide guidance.");
      expect(r.data.steps[0]?.prompt_append).toBe("Step-local guidance.");
    }
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepSchema — prompt_append and prompt_append_file (Spec 22 Unit 4)
// ---------------------------------------------------------------------------

describe("WorkflowStepSchema — prompt_append and prompt_append_file", () => {
  const validStep = {
    name: "implement",
    type: "autonomous" as const,
    agent: "shuttle",
    prompt: "Do the work.",
    completion: { method: "agent_signal" as const },
  };

  it("accepts step with prompt_append (step-scope append)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      prompt_append: "Focus on test coverage.",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append).toBe("Focus on test coverage.");
      expect(r.data.prompt_append_file).toBeUndefined();
    }
  });

  it("accepts step with prompt_append_file (step-scope append file)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      prompt_append_file: "step-guidance.md",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append_file).toBe("step-guidance.md");
      expect(r.data.prompt_append).toBeUndefined();
    }
  });

  it("accepts step without prompt_append or prompt_append_file (no step-scope append)", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.prompt_append).toBeUndefined();
      expect(r.data.prompt_append_file).toBeUndefined();
    }
  });

  it("rejects step with both prompt_append and prompt_append_file (mutually exclusive)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      prompt_append: "Inline guidance.",
      prompt_append_file: "step-guidance.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("mutually exclusive"))).toBe(true);
    }
  });

  it("rejects step with prompt_append_file '../bad.md' (path traversal)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      prompt_append_file: "../bad.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("relative path"))).toBe(true);
    }
  });

  it("rejects step with prompt_append_file '/etc/passwd' (absolute path)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      prompt_append_file: "/etc/passwd",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("relative path"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LogLevelSchema
// ---------------------------------------------------------------------------

describe("LogLevelSchema", () => {
  it("accepts all valid log levels", () => {
    for (const level of ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]) {
      expect(LogLevelSchema.safeParse(level).success).toBe(true);
    }
  });

  it("rejects lowercase log levels", () => {
    expect(LogLevelSchema.safeParse("info").success).toBe(false);
    expect(LogLevelSchema.safeParse("debug").success).toBe(false);
  });

  it("rejects invalid log level strings", () => {
    expect(LogLevelSchema.safeParse("verbose").success).toBe(false);
    expect(LogLevelSchema.safeParse("ALL").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RuntimeSettingsSchema
// ---------------------------------------------------------------------------

describe("RuntimeSettingsSchema", () => {
  it("accepts explicit journal.strict true", () => {
    const r = RuntimeSettingsSchema.safeParse({
      journal: { strict: true },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.journal.strict).toBe(true);
    }
  });

  it("defaults journal.strict to false when omitted", () => {
    const r = RuntimeSettingsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.journal.strict).toBe(false);
    }
  });

  it("defaults entire runtime settings when undefined", () => {
    const r = RuntimeSettingsSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.journal.strict).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// SettingsConfigSchema
// ---------------------------------------------------------------------------

describe("SettingsConfigSchema", () => {
  it("accepts valid settings with log_level INFO", () => {
    const r = SettingsConfigSchema.safeParse({ log_level: "INFO" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.log_level).toBe("INFO");
      expect(r.data.runtime.journal.strict).toBe(false);
    }
  });

  it("accepts all valid log levels", () => {
    for (const level of ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"]) {
      const r = SettingsConfigSchema.safeParse({ log_level: level });
      expect(r.success).toBe(true);
    }
  });

  it("defaults log_level to INFO when omitted", () => {
    const r = SettingsConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.log_level).toBe("INFO");
    }
  });

  it("defaults runtime.journal.strict to false when not specified", () => {
    const r = SettingsConfigSchema.safeParse({ log_level: "DEBUG" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.runtime.journal.strict).toBe(false);
    }
  });

  it("accepts runtime.journal.strict true", () => {
    const r = SettingsConfigSchema.safeParse({
      log_level: "INFO",
      runtime: { journal: { strict: true } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.runtime.journal.strict).toBe(true);
    }
  });

  it("rejects invalid log_level value", () => {
    const r = SettingsConfigSchema.safeParse({ log_level: "verbose" });
    expect(r.success).toBe(false);
  });

  it("rejects lowercase log_level", () => {
    const r = SettingsConfigSchema.safeParse({ log_level: "info" });
    expect(r.success).toBe(false);
  });

  it("defaults entire settings when undefined", () => {
    const r = SettingsConfigSchema.safeParse(undefined);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.log_level).toBe("INFO");
      expect(r.data.runtime.journal.strict).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// WeaveConfigSchema — settings integration
// ---------------------------------------------------------------------------

describe("WeaveConfigSchema — settings integration", () => {
  it("accepts settings block with log_level", () => {
    const r = WeaveConfigSchema.safeParse({
      settings: { log_level: "INFO" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts settings block with runtime.journal.strict true", () => {
    const r = WeaveConfigSchema.safeParse({
      settings: { log_level: "DEBUG", runtime: { journal: { strict: true } } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.settings.runtime.journal.strict).toBe(true);
    }
  });

  it("accepts empty config with default settings", () => {
    const r = WeaveConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.settings.log_level).toBe("INFO");
      expect(r.data.settings.runtime.journal.strict).toBe(false);
    }
  });

  it("top-level log_level is stripped (not in schema) — rejection enforced at validate layer", () => {
    // WeaveConfigSchema uses z.object() which strips unknown keys.
    // Top-level log_level rejection is enforced in validate.ts (AST layer),
    // not at the Zod schema level. This test documents that behavior.
    const r = WeaveConfigSchema.safeParse({ log_level: "INFO" });
    // The schema strips log_level (unknown key) and succeeds with defaults.
    // The validate() function rejects it before reaching Zod.
    expect(r.success).toBe(true);
    if (r.success) {
      // log_level is not present in the parsed output (stripped)
      expect("log_level" in r.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AgentConfigSchema — prompt_append_file
// ---------------------------------------------------------------------------

describe("AgentConfigSchema — prompt_append_file", () => {
  it("accepts prompt_append_file with a valid relative path (no prompt_append)", () => {
    const r = AgentConfigSchema.safeParse({
      prompt_append_file: "extra-instructions.md",
    });
    expect(r.success).toBe(true);
  });

  it("accepts prompt_append alone (regression guard)", () => {
    const r = AgentConfigSchema.safeParse({
      prompt_append: "Always respond in JSON.",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when both prompt_append and prompt_append_file are set", () => {
    const r = AgentConfigSchema.safeParse({
      prompt_append: "Always respond in JSON.",
      prompt_append_file: "extra-instructions.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("mutually exclusive"))).toBe(true);
    }
  });

  it("rejects prompt_append_file with a path traversal (../bad.md)", () => {
    const r = AgentConfigSchema.safeParse({
      prompt_append_file: "../bad.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("relative path"))).toBe(true);
    }
  });

  it("rejects prompt_append_file with an absolute path (/etc/passwd)", () => {
    const r = AgentConfigSchema.safeParse({
      prompt_append_file: "/etc/passwd",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("relative path"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CategoryConfigSchema — prompt_append_file
// ---------------------------------------------------------------------------

describe("CategoryConfigSchema — prompt_append_file", () => {
  const baseCategory = {
    patterns: ["src/**/*.ts"],
  };

  it("accepts prompt_append_file with a valid relative path", () => {
    const r = CategoryConfigSchema.safeParse({
      ...baseCategory,
      prompt_append_file: "category-extra.md",
    });
    expect(r.success).toBe(true);
  });

  it("rejects when both prompt_append and prompt_append_file are set", () => {
    const r = CategoryConfigSchema.safeParse({
      ...baseCategory,
      prompt_append: "Focus on API contracts.",
      prompt_append_file: "category-extra.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("mutually exclusive"))).toBe(true);
    }
  });

  it("rejects prompt_append_file with a path traversal (../bad.md)", () => {
    const r = CategoryConfigSchema.safeParse({
      ...baseCategory,
      prompt_append_file: "../bad.md",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("relative path"))).toBe(true);
    }
  });

  it("rejects prompt_append_file with an absolute path (/etc/passwd)", () => {
    const r = CategoryConfigSchema.safeParse({
      ...baseCategory,
      prompt_append_file: "/etc/passwd",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes("relative path"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// RoutingConfigSchema
// ---------------------------------------------------------------------------

describe("RoutingConfigSchema", () => {
  it("accepts empty routing block", () => {
    const r = RoutingConfigSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts delegation_exclude as an array of strings", () => {
    const r = RoutingConfigSchema.safeParse({
      delegation_exclude: ["warp", "spindle"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.delegation_exclude).toEqual(["warp", "spindle"]);
    }
  });

  it("accepts delegation_exclude as an empty array", () => {
    const r = RoutingConfigSchema.safeParse({ delegation_exclude: [] });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.delegation_exclude).toEqual([]);
    }
  });

  it("accepts omitted delegation_exclude (optional)", () => {
    const r = RoutingConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.delegation_exclude).toBeUndefined();
    }
  });

  it("rejects unknown keys (strict block)", () => {
    const r = RoutingConfigSchema.safeParse({
      delegation_exclude: ["warp"],
      priority: 1,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod strict() reports unknown keys in the message, not the path
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("priority"))).toBe(true);
    }
  });

  it("rejects delegation_exclude with non-string elements", () => {
    const r = RoutingConfigSchema.safeParse({ delegation_exclude: [42] });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepRoleSchema
// ---------------------------------------------------------------------------

describe("WorkflowStepRoleSchema", () => {
  it("accepts planning", () => {
    expect(WorkflowStepRoleSchema.safeParse("planning").success).toBe(true);
  });

  it("rejects unknown role", () => {
    expect(WorkflowStepRoleSchema.safeParse("execution").success).toBe(false);
    expect(WorkflowStepRoleSchema.safeParse("review").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepSchema — role field
// ---------------------------------------------------------------------------

describe("WorkflowStepSchema — role field", () => {
  const validStep = {
    name: "plan",
    type: "autonomous" as const,
    agent: "pattern",
    prompt: "Create a plan.",
    completion: { method: "plan_created" as const, plan_name: "my-plan" },
  };

  it("accepts step with role: planning", () => {
    const r = WorkflowStepSchema.safeParse({ ...validStep, role: "planning" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.role).toBe("planning");
    }
  });

  it("accepts step without role (optional)", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.role).toBeUndefined();
    }
  });

  it("rejects unknown role value", () => {
    const r = WorkflowStepSchema.safeParse({ ...validStep, role: "execution" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExtensionPointsSchema
// ---------------------------------------------------------------------------

describe("ExtensionPointsSchema", () => {
  it("accepts before_plan: true", () => {
    const r = ExtensionPointsSchema.safeParse({ before_plan: true });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.before_plan).toBe(true);
    }
  });

  it("accepts empty object (no extension points published)", () => {
    const r = ExtensionPointsSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.before_plan).toBeUndefined();
    }
  });

  it("accepts before_plan: false (explicitly disabled)", () => {
    const r = ExtensionPointsSchema.safeParse({ before_plan: false });
    expect(r.success).toBe(true);
  });

  it("rejects unknown extension point keys (UnknownExtensionPoint)", () => {
    const r = ExtensionPointsSchema.safeParse({
      before_plan: true,
      after_plan: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod .strict() reports unknown keys via "unrecognized_keys" code.
      const codes = r.error.issues.map((i) => i.code);
      expect(codes.some((c) => c === "unrecognized_keys")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ExtendBeforePlanSchema
// ---------------------------------------------------------------------------

describe("ExtendBeforePlanSchema", () => {
  it("accepts a non-empty steps array", () => {
    const r = ExtendBeforePlanSchema.safeParse({
      steps: ["spec-review", "requirements"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.steps).toEqual(["spec-review", "requirements"]);
    }
  });

  it("accepts a single-step array", () => {
    const r = ExtendBeforePlanSchema.safeParse({ steps: ["spec-review"] });
    expect(r.success).toBe(true);
  });

  it("rejects empty steps array", () => {
    const r = ExtendBeforePlanSchema.safeParse({ steps: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("at least one step"))).toBe(true);
    }
  });

  it("rejects steps with empty string names", () => {
    const r = ExtendBeforePlanSchema.safeParse({ steps: [""] });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("non-empty"))).toBe(true);
    }
  });

  it("rejects missing steps field", () => {
    const r = ExtendBeforePlanSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowConfigSchema — extension_points and planning step
// ---------------------------------------------------------------------------

describe("WorkflowConfigSchema — extension_points", () => {
  const planningStep = {
    name: "plan",
    type: "autonomous" as const,
    agent: "pattern",
    prompt: "Create a plan.",
    completion: { method: "plan_created" as const, plan_name: "my-plan" },
    role: "planning" as const,
  };

  const regularStep = {
    name: "implement",
    type: "autonomous" as const,
    agent: "shuttle",
    prompt: "Implement the plan.",
    completion: { method: "agent_signal" as const },
  };

  it("accepts workflow with extension_points.before_plan and one planning step", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extension_points: { before_plan: true },
      steps: [planningStep, regularStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extension_points?.before_plan).toBe(true);
      expect(r.data.steps[0]?.role).toBe("planning");
    }
  });

  it("rejects workflow with extension_points.before_plan but no planning step (MissingPlanningStep)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extension_points: { before_plan: true },
      steps: [regularStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("MissingPlanningStep"))).toBe(true);
    }
  });

  it("rejects workflow with two planning steps (DuplicatePlanningStep)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [planningStep, { ...planningStep, name: "plan2" }, regularStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("DuplicatePlanningStep"))).toBe(true);
    }
  });

  it("accepts workflow without extension_points and no planning step", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [regularStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extension_points).toBeUndefined();
    }
  });

  it("accepts workflow without extension_points but with a planning step (role is optional)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      steps: [planningStep, regularStep],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.steps[0]?.role).toBe("planning");
    }
  });

  it("rejects extension_points with unknown key (UnknownExtensionPoint)", () => {
    const r = WorkflowConfigSchema.safeParse({
      version: 1,
      extension_points: { before_plan: true, after_plan: true },
      steps: [planningStep],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod .strict() reports unknown keys via "unrecognized_keys" code.
      const codes = r.error.issues.map((i) => i.code);
      expect(codes.some((c) => c === "unrecognized_keys")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// WeaveConfigSchema — extend_before_plan
// ---------------------------------------------------------------------------

describe("WeaveConfigSchema — extend_before_plan", () => {
  it("accepts extend_before_plan with a steps array", () => {
    const r = WeaveConfigSchema.safeParse({
      extend_before_plan: { steps: ["spec-review"] },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extend_before_plan.steps).toEqual(["spec-review"]);
    }
  });

  it("accepts extend_before_plan with multiple steps", () => {
    const r = WeaveConfigSchema.safeParse({
      extend_before_plan: { steps: ["spec-review", "requirements"] },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extend_before_plan.steps).toEqual([
        "spec-review",
        "requirements",
      ]);
    }
  });

  it("defaults extend_before_plan to empty steps when absent", () => {
    const r = WeaveConfigSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.extend_before_plan).toEqual({ steps: [] });
    }
  });

  it("rejects extend_before_plan with empty steps array", () => {
    const r = WeaveConfigSchema.safeParse({
      extend_before_plan: { steps: [] },
    });
    expect(r.success).toBe(false);
  });

  it("rejects extend_before_plan with empty string step names", () => {
    const r = WeaveConfigSchema.safeParse({
      extend_before_plan: { steps: [""] },
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReconciliationReasonSchema
// ---------------------------------------------------------------------------

describe("ReconciliationReasonSchema", () => {
  it("accepts all four closed built-in reasons", () => {
    expect(
      ReconciliationReasonSchema.safeParse("execution-mismatch").success,
    ).toBe(true);
    expect(
      ReconciliationReasonSchema.safeParse("user-revision-request").success,
    ).toBe(true);
    expect(
      ReconciliationReasonSchema.safeParse("review-rejection").success,
    ).toBe(true);
    expect(
      ReconciliationReasonSchema.safeParse("security-rejection").success,
    ).toBe(true);
  });

  it("rejects unknown reason strings", () => {
    expect(ReconciliationReasonSchema.safeParse("unknown-reason").success).toBe(
      false,
    );
    expect(ReconciliationReasonSchema.safeParse("").success).toBe(false);
    expect(ReconciliationReasonSchema.safeParse("retry").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReconciliationHandlerSchema
// ---------------------------------------------------------------------------

describe("ReconciliationHandlerSchema", () => {
  it("accepts a valid handler with execution-mismatch", () => {
    const r = ReconciliationHandlerSchema.safeParse({
      reason: "execution-mismatch",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reason).toBe("execution-mismatch");
    }
  });

  it("accepts a valid handler with user-revision-request", () => {
    const r = ReconciliationHandlerSchema.safeParse({
      reason: "user-revision-request",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid handler with review-rejection", () => {
    const r = ReconciliationHandlerSchema.safeParse({
      reason: "review-rejection",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid handler with security-rejection", () => {
    const r = ReconciliationHandlerSchema.safeParse({
      reason: "security-rejection",
    });
    expect(r.success).toBe(true);
  });

  it("rejects handler with unknown reason", () => {
    const r = ReconciliationHandlerSchema.safeParse({ reason: "bad-reason" });
    expect(r.success).toBe(false);
  });

  it("rejects handler missing reason field", () => {
    const r = ReconciliationHandlerSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReconciliationHandlerListSchema
// ---------------------------------------------------------------------------

describe("ReconciliationHandlerListSchema", () => {
  it("accepts a single-handler list", () => {
    const r = ReconciliationHandlerListSchema.safeParse([
      { reason: "execution-mismatch" },
    ]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toHaveLength(1);
      expect(r.data[0]?.reason).toBe("execution-mismatch");
    }
  });

  it("accepts all four reasons in one list", () => {
    const r = ReconciliationHandlerListSchema.safeParse([
      { reason: "execution-mismatch" },
      { reason: "user-revision-request" },
      { reason: "review-rejection" },
      { reason: "security-rejection" },
    ]);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toHaveLength(4);
    }
  });

  it("rejects empty list (must have at least one handler)", () => {
    const r = ReconciliationHandlerListSchema.safeParse([]);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("at least one handler"))).toBe(true);
    }
  });

  it("rejects duplicate reasons in the same list (DuplicateReconciliationReason)", () => {
    const r = ReconciliationHandlerListSchema.safeParse([
      { reason: "execution-mismatch" },
      { reason: "execution-mismatch" },
    ]);
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("DuplicateReconciliationReason")),
      ).toBe(true);
    }
  });

  it("rejects list with an unknown reason", () => {
    const r = ReconciliationHandlerListSchema.safeParse([
      { reason: "bad-reason" },
    ]);
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepSchema — reconciliation_handlers field
// ---------------------------------------------------------------------------

describe("WorkflowStepSchema — reconciliation_handlers", () => {
  const validStep = {
    name: "plan",
    type: "autonomous" as const,
    agent: "pattern",
    prompt: "Create a plan.",
    completion: { method: "agent_signal" as const },
  };

  it("accepts step with reconciliation_handlers declaring one reason", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [{ reason: "execution-mismatch" }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reconciliation_handlers).toHaveLength(1);
      expect(r.data.reconciliation_handlers?.[0]?.reason).toBe(
        "execution-mismatch",
      );
    }
  });

  it("accepts step with reconciliation_handlers declaring all four reasons", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [
        { reason: "execution-mismatch" },
        { reason: "user-revision-request" },
        { reason: "review-rejection" },
        { reason: "security-rejection" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reconciliation_handlers).toHaveLength(4);
    }
  });

  it("accepts step without reconciliation_handlers (optional)", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reconciliation_handlers).toBeUndefined();
    }
  });

  it("rejects step with empty reconciliation_handlers array", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("at least one handler"))).toBe(true);
    }
  });

  it("rejects step with duplicate reconciliation reasons (DuplicateReconciliationReason)", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [
        { reason: "review-rejection" },
        { reason: "review-rejection" },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msgs = r.error.issues.map((i) => i.message);
      expect(
        msgs.some((m) => m.includes("DuplicateReconciliationReason")),
      ).toBe(true);
    }
  });

  it("rejects step with unknown reconciliation reason", () => {
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [{ reason: "bad-reason" }],
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowStepSchema — v1 before-plan non-reconciling contract (engine-layer)
// ---------------------------------------------------------------------------

describe("WorkflowStepSchema — v1 before-plan non-reconciling contract", () => {
  // Spec 22 Unit 2 states: "before-plan steps do not participate in
  // reconciliation semantics" in v1.
  //
  // As of Task 4.1, `reconciliation_handlers` IS a valid schema field on
  // WorkflowStepSchema. The v1 non-reconciling constraint for before-plan
  // steps is enforced at the engine/runtime layer (not the schema layer),
  // because the schema cannot know which steps will end up in the before-plan
  // slot at config-merge time.
  //
  // This test suite documents that invariant so future changes remain explicit.

  const validStep = {
    name: "spec-review",
    type: "autonomous" as const,
    agent: "pattern",
    prompt: "Review the spec.",
    completion: { method: "agent_signal" as const },
  };

  it("a step destined for the before-plan slot is a valid WorkflowStep (schema layer accepts it)", () => {
    const r = WorkflowStepSchema.safeParse(validStep);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("spec-review");
      // reconciliation_handlers is optional — absent by default
      expect(r.data.reconciliation_handlers).toBeUndefined();
    }
  });

  it("schema accepts reconciliation_handlers on any step (engine enforces before-plan exclusion)", () => {
    // The schema does not know which steps are in the before-plan slot.
    // Engine/runtime enforcement prevents before-plan steps from acting as
    // reconciliation handlers. At the schema layer, the field is valid.
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      reconciliation_handlers: [{ reason: "execution-mismatch" }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reconciliation_handlers).toHaveLength(1);
    }
  });

  it("on_reconcile is not a schema field (unknown keys are stripped)", () => {
    // `on_reconcile` was never a schema field; unknown keys are stripped by Zod.
    const r = WorkflowStepSchema.safeParse({
      ...validStep,
      on_reconcile: "pause",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect("on_reconcile" in r.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// AgentConfigSchema — routing field
// ---------------------------------------------------------------------------

describe("AgentConfigSchema — routing field", () => {
  it("accepts agent with routing.delegation_exclude", () => {
    const r = AgentConfigSchema.safeParse({
      prompt: "You are an agent.",
      routing: { delegation_exclude: ["warp", "spindle"] },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.routing?.delegation_exclude).toEqual(["warp", "spindle"]);
    }
  });

  it("accepts agent without routing (optional)", () => {
    const r = AgentConfigSchema.safeParse({ prompt: "You are an agent." });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.routing).toBeUndefined();
    }
  });

  it("rejects unknown keys inside routing block (strict)", () => {
    const r = AgentConfigSchema.safeParse({
      prompt: "You are an agent.",
      routing: { delegation_exclude: ["warp"], fallback: "loom" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Zod strict() reports unknown keys in the message, not the path
      const msgs = r.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes("fallback"))).toBe(true);
    }
  });
});
