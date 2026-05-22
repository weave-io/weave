import { describe, expect, it } from "bun:test";
import { ToolPermissionSchema, ToolPolicySchema } from "@weave/core";
import {
  AgentConfigSchema,
  CategoryConfigSchema,
  CompletionMethodSchema,
  LogLevelSchema,
  OnRejectSchema,
  RuntimeSettingsSchema,
  SettingsConfigSchema,
  WeaveConfigSchema,
  WorkflowConfigSchema,
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
