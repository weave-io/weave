/**
 * Zod schemas for validated Weave configuration.
 *
 * All exported TypeScript types are derived from Zod schemas via `z.infer<>`.
 * No hand-written type definitions for config shapes.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ToolPermissionSchema = z.enum(["allow", "deny", "ask"]);

export const DelegationTriggerSchema = z.object({
  domain: z.string(),
  trigger: z.string(),
});

export const ToolPolicySchema = z
  .object({
    read: ToolPermissionSchema.optional(),
    write: ToolPermissionSchema.optional(),
    execute: ToolPermissionSchema.optional(),
    delegate: ToolPermissionSchema.optional(),
    network: ToolPermissionSchema.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const AgentConfigSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    display_name: z.string().optional(),
    prompt: z.string().optional(),
    prompt_file: z.string().optional(),
    prompt_append: z.string().optional(),
    models: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    mode: z.enum(["primary", "subagent", "all"]).optional(),
    tool_policy: ToolPolicySchema.optional(),
    skills: z.array(z.string()).optional(),
    triggers: z.array(DelegationTriggerSchema).optional(),
  })
  .refine(
    (data) => !(data.prompt !== undefined && data.prompt_file !== undefined),
    { message: "prompt and prompt_file are mutually exclusive" },
  )
  .refine(
    (data) => {
      if (data.prompt_file === undefined) return true;
      if (data.prompt_file.startsWith("/")) return false;
      if (data.prompt_file.includes("..")) return false;
      return true;
    },
    {
      message:
        "prompt_file must be a relative path without '..' or absolute paths",
    },
  );

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export const CategoryConfigSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  patterns: z.array(z.string()).min(1, "patterns must have at least one entry"),
  models: z.array(z.string()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  tool_policy: ToolPolicySchema.optional(),
  prompt_append: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

export const DisabledConfigSchema = z.object({
  agents: z.array(z.string()).default([]),
  hooks: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Workflow step type
// ---------------------------------------------------------------------------

/** The execution mode of a workflow step. */
export const WorkflowStepTypeSchema = z.enum([
  "autonomous",
  "interactive",
  "gate",
]);

// ---------------------------------------------------------------------------
// Completion method (discriminated union on `method`)
// ---------------------------------------------------------------------------

/**
 * Describes how a workflow step signals that it is done.
 *
 * Each variant is a discriminated union member keyed on `method`:
 * - `agent_signal`   — the agent emits a done signal
 * - `user_confirm`   — the user explicitly approves
 * - `plan_created`   — a named plan file was written
 * - `plan_complete`  — a named plan was fully executed
 * - `review_verdict` — a gate agent returns approve/reject
 */
export const CompletionMethodSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("agent_signal") }),
  z.object({ method: z.literal("user_confirm") }),
  z.object({ method: z.literal("plan_created"), plan_name: z.string() }),
  z.object({ method: z.literal("plan_complete"), plan_name: z.string() }),
  z.object({ method: z.literal("review_verdict") }),
]);

// ---------------------------------------------------------------------------
// Artifact references (inputs / outputs)
// ---------------------------------------------------------------------------

/** A named artifact produced or consumed by a workflow step. */
export const ArtifactRefSchema = z.object({
  name: z.string(),
  description: z.string(),
});

// ---------------------------------------------------------------------------
// on_reject policy
// ---------------------------------------------------------------------------

/** Behaviour when a gate step rejects. Only valid on `type: "gate"` steps. */
export const OnRejectSchema = z.enum(["pause", "fail", "retry"]);

// ---------------------------------------------------------------------------
// Workflow step
// ---------------------------------------------------------------------------

/**
 * A single step inside a workflow.
 *
 * Field mapping notes:
 * - `name`         — the step's block identifier in the DSL (e.g. `step plan { }` → `"plan"`)
 * - `display_name` — the human-readable label from the inner `name "..."` property
 * - `on_reject`    — only valid when `type` is `"gate"` (enforced by `.refine()`)
 */
export const WorkflowStepSchema = z
  .object({
    name: z.string(),
    display_name: z.string().optional(),
    type: WorkflowStepTypeSchema,
    agent: z.string(),
    prompt: z.string(),
    completion: CompletionMethodSchema,
    inputs: z.array(ArtifactRefSchema).optional(),
    outputs: z.array(ArtifactRefSchema).optional(),
    on_reject: OnRejectSchema.optional(),
  })
  .refine((data) => data.on_reject === undefined || data.type === "gate", {
    message: "on_reject is only valid for gate steps",
  });

// ---------------------------------------------------------------------------
// Workflow config
// ---------------------------------------------------------------------------

/**
 * A named workflow definition containing an ordered list of steps.
 *
 * - `version` — positive integer; used for future migration
 * - `steps`   — at least one step is required
 */
export const WorkflowConfigSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.number().int().positive(),
  steps: z.array(WorkflowStepSchema).min(1),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Valid log level values (uppercase bare identifiers in DSL). */
export const LogLevelSchema = z.enum([
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);

/** Runtime-specific settings nested inside `settings { runtime { ... } }`. */
export const RuntimeSettingsSchema = z
  .object({
    journal: z
      .object({
        strict: z.boolean().default(false),
      })
      .default({ strict: false }),
  })
  .default({ journal: { strict: false } });

/**
 * The `settings { ... }` block — canonical home for log level and runtime
 * configuration. Top-level `log_level` is rejected; use `settings { log_level INFO }`.
 */
export const SettingsConfigSchema = z
  .object({
    log_level: LogLevelSchema.default("INFO"),
    runtime: RuntimeSettingsSchema,
  })
  .default({ log_level: "INFO", runtime: { journal: { strict: false } } });

// ---------------------------------------------------------------------------
// Top-level WeaveConfig
// ---------------------------------------------------------------------------

/**
 * Top-level Weave configuration schema.
 *
 * Note: top-level `log_level` is rejected at the AST validation layer
 * (`validate.ts`) before reaching this schema. The `settings` block is the
 * canonical home for `log_level` and `runtime.journal.strict`.
 */
export const WeaveConfigSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  categories: z.record(z.string(), CategoryConfigSchema).default({}),
  disabled: DisabledConfigSchema.default({
    agents: [],
    hooks: [],
    skills: [],
  }),
  settings: SettingsConfigSchema,
  workflows: z.record(z.string(), WorkflowConfigSchema).default({}),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;
export type DelegationTrigger = z.infer<typeof DelegationTriggerSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;
export type DisabledConfig = z.infer<typeof DisabledConfigSchema>;
/** Step execution mode. */
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
/** Discriminated union describing how a step signals completion. */
export type CompletionMethod = z.infer<typeof CompletionMethodSchema>;
/** A named artifact produced or consumed by a step. */
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
/** Behaviour when a gate step rejects. */
export type OnReject = z.infer<typeof OnRejectSchema>;
/** A fully-validated workflow step. */
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
/** A fully-validated workflow definition. */
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
/** Valid log level string. */
export type LogLevel = z.infer<typeof LogLevelSchema>;
/** Runtime-specific settings (journal.strict, etc.). */
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
/** The `settings { ... }` block config shape. */
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;
