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
// Routing
// ---------------------------------------------------------------------------

/**
 * Per-agent routing knobs. Open for future fields (priority, fallback,
 * weighted routes). Strict — unknown keys are rejected so typos surface
 * clearly.
 */
export const RoutingConfigSchema = z
  .object({
    delegation_exclude: z.array(z.string()).optional(),
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
    prompt_append_file: z.string().optional(),
    models: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    mode: z.enum(["primary", "subagent", "all"]).optional(),
    tool_policy: ToolPolicySchema.optional(),
    routing: RoutingConfigSchema.optional(),
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
  )
  .refine(
    (data) =>
      !(
        data.prompt_append !== undefined &&
        data.prompt_append_file !== undefined
      ),
    { message: "prompt_append and prompt_append_file are mutually exclusive" },
  )
  .refine(
    (data) => {
      if (data.prompt_append_file === undefined) return true;
      if (data.prompt_append_file.startsWith("/")) return false;
      if (data.prompt_append_file.includes("..")) return false;
      return true;
    },
    {
      message:
        "prompt_append_file must be a relative path without '..' or absolute paths",
    },
  );

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

export const CategoryConfigSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    patterns: z
      .array(z.string())
      .min(1, "patterns must have at least one entry"),
    models: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    tool_policy: ToolPolicySchema.optional(),
    prompt_append: z.string().optional(),
    prompt_append_file: z.string().optional(),
  })
  .refine(
    (data) =>
      !(
        data.prompt_append !== undefined &&
        data.prompt_append_file !== undefined
      ),
    { message: "prompt_append and prompt_append_file are mutually exclusive" },
  )
  .refine(
    (data) => {
      if (data.prompt_append_file === undefined) return true;
      if (data.prompt_append_file.startsWith("/")) return false;
      if (data.prompt_append_file.includes("..")) return false;
      return true;
    },
    {
      message:
        "prompt_append_file must be a relative path without '..' or absolute paths",
    },
  );

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

const DisabledConfigSchema = z.object({
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
export const ArtifactDeclSchema = z.object({
  name: z.string(),
  description: z.string(),
});

// ---------------------------------------------------------------------------
// on_reject policy
// ---------------------------------------------------------------------------

/** Behaviour when a gate step rejects. Only valid on `type: "gate"` steps. */
export const OnRejectSchema = z.enum(["pause", "fail", "retry"]);

// ---------------------------------------------------------------------------
// Reconciliation reason (closed built-in set — Spec 22 Unit 3)
// ---------------------------------------------------------------------------

/**
 * The closed built-in set of reconciliation reasons defined by Spec 22 Unit 3.
 *
 * - `execution-mismatch`    — runtime validation or execution checks detected a
 *                             mismatch between expected and actual execution state.
 * - `user-revision-request` — an explicit user action requested a revision.
 * - `review-rejection`      — the review gate returned a reject verdict.
 * - `security-rejection`    — the security gate returned a reject verdict.
 *
 * Only these four reasons are accepted in v1. Open-ended reason strings are
 * rejected at validation time so tooling and adapter readiness remain
 * deterministic.
 */
export const ReconciliationReasonSchema = z.enum([
  "execution-mismatch",
  "user-revision-request",
  "review-rejection",
  "security-rejection",
]);

// ---------------------------------------------------------------------------
// Reconciliation handler (step-local declaration — Spec 22 Unit 3)
// ---------------------------------------------------------------------------

/**
 * A step-local reconciliation handler declaration.
 *
 * Declares that this step is the upstream handler for one or more reconciliation
 * reasons. When a downstream step triggers reconciliation with a matching reason,
 * the engine routes the reconciliation to the nearest explicitly declared handler
 * step in workflow order.
 *
 * DSL syntax (inside a `step` block):
 * ```weave
 * reconciliation_handlers [
 *   { reason "execution-mismatch" }
 *   { reason "user-revision-request" }
 * ]
 * ```
 *
 * Constraints:
 * - `reason` must be one of the four closed built-in values.
 * - The same reason may not appear more than once per step
 *   (`DuplicateReconciliationReason`).
 * - `before-plan` steps do not participate in reconciliation semantics in v1;
 *   this constraint is enforced at the engine/runtime layer, not here.
 */
export const ReconciliationHandlerSchema = z.object({
  /** The reconciliation reason this handler step is responsible for. */
  reason: ReconciliationReasonSchema,
});

/**
 * The ordered list of reconciliation handler declarations on a single step.
 *
 * Validated as a non-empty array when present; each `reason` must be unique
 * within the list (`DuplicateReconciliationReason`).
 */
export const ReconciliationHandlerListSchema = z
  .array(ReconciliationHandlerSchema)
  .min(1, "reconciliation_handlers must declare at least one handler")
  .refine(
    (handlers) => {
      const reasons = handlers.map((h) => h.reason);
      return reasons.length === new Set(reasons).size;
    },
    {
      message:
        "each reconciliation reason may appear at most once per step (DuplicateReconciliationReason)",
    },
  );

// ---------------------------------------------------------------------------
// Step role
// ---------------------------------------------------------------------------

/**
 * The semantic role of a workflow step.
 *
 * - `planning` — the canonical planning step; exactly one per workflow is
 *   required when the workflow publishes a `before-plan` extension point.
 *   Only one step per workflow may carry this role.
 */
export const WorkflowStepRoleSchema = z.enum(["planning"]);

// ---------------------------------------------------------------------------
// Workflow step
// ---------------------------------------------------------------------------

/**
 * A single step inside a workflow.
 *
 * Field mapping notes:
 * - `name`          — the step's block identifier in the DSL (e.g. `step plan { }` → `"plan"`)
 * - `display_name`  — the human-readable label from the inner `name "..."` property
 * - `role`          — optional semantic role; `"planning"` marks the canonical planning step
 * - `on_reject`     — only valid when `type` is `"gate"` (enforced by `.refine()`)
 * - `insert_before` — position this step immediately before the named anchor step in the
 *                     base workflow; only meaningful on extension workflows
 * - `insert_after`  — position this step immediately after the named anchor step in the
 *                     base workflow; only meaningful on extension workflows
 *
 * `insert_before` and `insert_after` are mutually exclusive (`BothInsertBeforeAndAfter`).
 */
export const WorkflowStepSchema = z
  .object({
    name: z.string(),
    display_name: z.string().optional(),
    /** Semantic role of this step. `"planning"` marks the canonical planning step. */
    role: WorkflowStepRoleSchema.optional(),
    type: WorkflowStepTypeSchema,
    agent: z.string(),
    prompt: z.string(),
    completion: CompletionMethodSchema,
    inputs: z.array(ArtifactDeclSchema).optional(),
    outputs: z.array(ArtifactDeclSchema).optional(),
    on_reject: OnRejectSchema.optional(),
    /**
     * Step-local reconciliation handler declarations (Spec 22 Unit 3).
     *
     * Declares that this step is the upstream handler for the listed
     * reconciliation reasons. The engine routes reconciliation to the nearest
     * explicitly declared handler step in workflow order, and pauses or blocks
     * when no handler exists.
     *
     * `before-plan` steps do not participate in reconciliation semantics in v1;
     * that constraint is enforced at the engine/runtime layer.
     */
    reconciliation_handlers: ReconciliationHandlerListSchema.optional(),
    /** Position this step immediately before the named anchor step in the base workflow. */
    insert_before: z
      .string()
      .min(1, "insert_before must be a non-empty step name")
      .optional(),
    /** Position this step immediately after the named anchor step in the base workflow. */
    insert_after: z
      .string()
      .min(1, "insert_after must be a non-empty step name")
      .optional(),
  })
  .refine((data) => data.on_reject === undefined || data.type === "gate", {
    message: "on_reject is only valid for gate steps",
  })
  .refine(
    (data) =>
      !(data.insert_before !== undefined && data.insert_after !== undefined),
    {
      message:
        "insert_before and insert_after are mutually exclusive (BothInsertBeforeAndAfter)",
    },
  );

// ---------------------------------------------------------------------------
// Extension points (workflow-level publication)
// ---------------------------------------------------------------------------

/**
 * Thin workflow-level publication block that declares which engine-visible
 * extension surfaces this workflow exposes.
 *
 * v1 closed contract: only `before_plan` is supported.
 *
 * DSL syntax:
 * ```weave
 * extension_points {
 *   before-plan
 * }
 * ```
 *
 * The `before-plan` identifier inside the block is parsed as a bare boolean
 * flag (presence = true). The DSL key uses a hyphen (`before-plan`) which the
 * validator normalises to the schema key `before_plan`.
 */
export const ExtensionPointsSchema = z
  .object({
    /** Publish the `before-plan` extension surface for this workflow. */
    before_plan: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Extend before-plan (composition syntax)
// ---------------------------------------------------------------------------

/**
 * Top-level composition directive that lists step names to insert into the
 * `before-plan` slot of a named workflow.
 *
 * DSL syntax:
 * ```weave
 * extend before-plan ["spec-review", "requirements"]
 * ```
 *
 * This is a **separate** syntax from `extension_points { before-plan }`.
 * Publication declares the slot exists; composition provides the steps.
 *
 * The validator resolves composition after generic config-merge
 * (`extends` / `insert_before` / `insert_after`) is complete.
 */
export const ExtendBeforePlanSchema = z.object({
  /** Ordered list of step names to insert into the `before-plan` slot. */
  steps: z
    .array(z.string().min(1, "step name must be non-empty"))
    .min(1, "extend before-plan must list at least one step"),
});

// ---------------------------------------------------------------------------
// Workflow config
// ---------------------------------------------------------------------------

/**
 * A named workflow definition containing an ordered list of steps.
 *
 * - `version`          — positive integer; used for future migration
 * - `steps`            — at least one step is required unless `extends` is set
 * - `extends`          — optional name of a base workflow this workflow extends;
 *                        when set, `steps` may be empty (the extension may add steps
 *                        relative to the base via `insert_before` / `insert_after`)
 * - `extension_points` — thin publication block declaring engine-visible extension
 *                        surfaces (v1: `before-plan` only)
 *
 * Validation invariants:
 * - When `extension_points.before_plan` is true, exactly one step must carry
 *   `role: "planning"` (`MissingPlanningStep` / `DuplicatePlanningStep`).
 * - A workflow without `extension_points.before_plan` may still have a planning
 *   step, but the uniqueness constraint is only enforced when the slot is published.
 */
export const WorkflowConfigSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.number().int().positive(),
    steps: z.array(WorkflowStepSchema),
    /** Name of the base workflow this workflow extends. */
    extends: z
      .string()
      .min(1, "extends must be a non-empty workflow name")
      .optional(),
    /** Thin publication block declaring engine-visible extension surfaces. */
    extension_points: ExtensionPointsSchema.optional(),
  })
  .refine((data) => data.extends !== undefined || data.steps.length >= 1, {
    message:
      "steps must have at least one entry (or set extends to allow an empty steps list)",
    path: ["steps"],
  })
  .refine(
    (data) => {
      if (!data.extension_points?.before_plan) return true;
      const planningSteps = data.steps.filter((s) => s.role === "planning");
      return planningSteps.length >= 1;
    },
    {
      message:
        "a workflow that publishes before-plan must have exactly one step with role: planning (MissingPlanningStep)",
      path: ["steps"],
    },
  )
  .refine(
    (data) => {
      const planningSteps = data.steps.filter((s) => s.role === "planning");
      return planningSteps.length <= 1;
    },
    {
      message:
        "only one step per workflow may have role: planning (DuplicatePlanningStep)",
      path: ["steps"],
    },
  );

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
 *
 * `extend_before_plan` holds the merged result of all `extend before-plan [...]`
 * top-level directives. Each entry maps a workflow name to the ordered list of
 * step names to insert into that workflow's `before-plan` slot.
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
  /**
   * Merged `extend before-plan [...]` directives keyed by workflow name.
   * Populated by the validator from top-level `extend before-plan` AST nodes.
   */
  extend_before_plan: z.record(z.string(), ExtendBeforePlanSchema).default({}),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;
export type DelegationTrigger = z.infer<typeof DelegationTriggerSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
/** Per-agent routing configuration (delegation_exclude, etc.). */
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;
/** Step execution mode. */
export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
/** Semantic role of a workflow step (`"planning"` = canonical planning step). */
export type WorkflowStepRole = z.infer<typeof WorkflowStepRoleSchema>;
/** Discriminated union describing how a step signals completion. */
export type CompletionMethod = z.infer<typeof CompletionMethodSchema>;
/** A named artifact produced or consumed by a step. */
export type ArtifactDecl = z.infer<typeof ArtifactDeclSchema>;
/** Behaviour when a gate step rejects. */
export type OnReject = z.infer<typeof OnRejectSchema>;
/**
 * One of the four closed built-in reconciliation reasons (Spec 22 Unit 3).
 * `execution-mismatch` | `user-revision-request` | `review-rejection` | `security-rejection`
 */
export type ReconciliationReason = z.infer<typeof ReconciliationReasonSchema>;
/** A single reconciliation handler entry declaring which reason this step handles. */
export type ReconciliationHandler = z.infer<typeof ReconciliationHandlerSchema>;
/** A fully-validated workflow step. */
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
/** Workflow-level publication of engine-visible extension surfaces (v1: before_plan). */
export type ExtensionPoints = z.infer<typeof ExtensionPointsSchema>;
/** Composition directive listing step names for the `before-plan` slot. */
export type ExtendBeforePlan = z.infer<typeof ExtendBeforePlanSchema>;
/** A fully-validated workflow definition. */
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
/** Valid log level string. */
export type LogLevel = z.infer<typeof LogLevelSchema>;
/** Runtime-specific settings (journal.strict, etc.). */
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
/** The `settings { ... }` block config shape. */
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;
