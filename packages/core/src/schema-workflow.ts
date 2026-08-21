import { z } from "zod";
import {
  refinePromptAppendExclusive,
  refinePromptFileSafe,
} from "./prompt-schema-helpers.js";
import { safeObjectSchema, safeSchemaInput } from "./safe-schema-input.js";
import { MAX_CONFIG_ARRAY_LENGTH } from "./schema-common.js";

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
const CompletionMethodObjectSchema = z.discriminatedUnion("method", [
  safeObjectSchema(z.object({ method: z.literal("agent_signal") })),
  safeObjectSchema(z.object({ method: z.literal("user_confirm") })),
  safeObjectSchema(
    z.object({ method: z.literal("plan_created"), plan_name: z.string() }),
  ),
  safeObjectSchema(
    z.object({ method: z.literal("plan_complete"), plan_name: z.string() }),
  ),
  safeObjectSchema(z.object({ method: z.literal("review_verdict") })),
]);

export const CompletionMethodSchema = safeSchemaInput(
  CompletionMethodObjectSchema,
);

// ---------------------------------------------------------------------------
// Artifact references (inputs / outputs)
// ---------------------------------------------------------------------------

/** A named artifact produced or consumed by a workflow step. */
const ArtifactDeclObjectSchema = safeObjectSchema(
  z.object({
    name: z.string(),
    description: z.string(),
  }),
);

export const ArtifactDeclSchema = ArtifactDeclObjectSchema;

// ---------------------------------------------------------------------------
// on_reject policy
// ---------------------------------------------------------------------------

/** Behaviour when a gate step rejects. Only valid on `type: "gate"` steps. */
export const OnRejectSchema = z.enum(["pause", "fail", "retry"]);

// ---------------------------------------------------------------------------
// Reconciliation reason (closed built-in set — execution lifecycle contract)
// ---------------------------------------------------------------------------

/**
 * The closed built-in set of reconciliation reasons defined by the execution lifecycle contract.
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
// Reconciliation handler (step-local declaration — execution lifecycle contract)
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
const ReconciliationHandlerObjectSchema = safeObjectSchema(
  z.object({
    /** The reconciliation reason this handler step is responsible for. */
    reason: ReconciliationReasonSchema,
  }),
);

export const ReconciliationHandlerSchema = ReconciliationHandlerObjectSchema;

/**
 * The ordered list of reconciliation handler declarations on a single step.
 *
 * Validated as a non-empty array when present; each `reason` must be unique
 * within the list (`DuplicateReconciliationReason`).
 */
const ReconciliationHandlerListArraySchema = z
  .array(ReconciliationHandlerObjectSchema)
  .min(1, "reconciliation_handlers must declare at least one handler")
  .max(MAX_CONFIG_ARRAY_LENGTH)
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

export const ReconciliationHandlerListSchema = safeSchemaInput(
  ReconciliationHandlerListArraySchema,
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
 * - `name`              — the step's block identifier in the DSL (e.g. `step plan { }` → `"plan"`)
 * - `display_name`      — the human-readable label from the inner `name "..."` property
 * - `role`              — optional semantic role; `"planning"` marks the canonical planning step
 * - `on_reject`         — only valid when `type` is `"gate"` (enforced by `.refine()`)
 * - `prompt_append`     — inline text appended after the step prompt; rendered as a Mustache template
 * - `prompt_append_file`— path to a `.md` file appended after the step prompt; resolved relative to
 *                         the config scope's `prompts/` directory; rendered as a Mustache template
 * - `insert_before`     — position this step immediately before the named anchor step in the
 *                         base workflow; only meaningful on extension workflows
 * - `insert_after`      — position this step immediately after the named anchor step in the
 *                         base workflow; only meaningful on extension workflows
 *
 * `insert_before` and `insert_after` are mutually exclusive (`BothInsertBeforeAndAfter`).
 * `prompt_append` and `prompt_append_file` are mutually exclusive per scope.
 */
export const WorkflowStepObjectSchema = safeObjectSchema(
  z
    .object({
      name: z.string(),
      display_name: z.string().optional(),
      /** Semantic role of this step. `"planning"` marks the canonical planning step. */
      role: WorkflowStepRoleSchema.optional(),
      type: WorkflowStepTypeSchema,
      agent: z.string(),
      prompt: z.string(),
      /** Inline text appended after the step prompt; rendered as a Mustache template. */
      prompt_append: z.string().optional(),
      /**
       * Path to a `.md` file appended after the step prompt; resolved relative to the
       * config scope's `prompts/` directory; rendered as a Mustache template.
       * Mutually exclusive with `prompt_append`.
       */
      prompt_append_file: z.string().optional(),
      completion: CompletionMethodObjectSchema,
      inputs: z
        .array(ArtifactDeclObjectSchema)
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
      outputs: z
        .array(ArtifactDeclObjectSchema)
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
      on_reject: OnRejectSchema.optional(),
      /**
       * Step-local reconciliation handler declarations (execution lifecycle contract).
       *
       * Declares that this step is the upstream handler for the listed
       * reconciliation reasons. The engine routes reconciliation to the nearest
       * explicitly declared handler step in workflow order, and pauses or blocks
       * when no handler exists.
       *
       * `before-plan` steps do not participate in reconciliation semantics in v1;
       * that constraint is enforced at the engine/runtime layer.
       */
      reconciliation_handlers: ReconciliationHandlerListArraySchema.optional(),
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
    )
    .refine(...refinePromptAppendExclusive())
    .refine(...refinePromptFileSafe("prompt_append_file")),
);

export const WorkflowStepSchema = WorkflowStepObjectSchema;

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
export const ExtensionPointsObjectSchema = safeObjectSchema(
  z
    .object({
      /** Publish the `before-plan` extension surface for this workflow. */
      before_plan: z.boolean().optional(),
    })
    .strict(),
);

export const ExtensionPointsSchema = ExtensionPointsObjectSchema;

// ---------------------------------------------------------------------------
// Extend before-plan (composition syntax)
// ---------------------------------------------------------------------------

/**
 * Top-level composition directive that lists step names to insert into the
 * `before-plan` slot of any workflow that publishes `extension_points { before-plan }`.
 *
 * DSL syntax:
 * ```weave
 * extend before-plan ["spec-review", "requirements"]
 * ```
 *
 * This is a **separate** syntax from `extension_points { before-plan }`.
 * Publication declares the slot exists; composition provides the steps.
 *
 * Multiple `extend before-plan` directives in the same config are union-merged
 * into a single ordered step list. The validator resolves composition after
 * generic config-merge (`extends` / `insert_before` / `insert_after`) is complete.
 *
 * v1 contract: there is exactly one global `before-plan` bucket — no per-workflow
 * targeting. The config layer applies the step list to every workflow that
 * publishes `extension_points { before-plan }`.
 */
export const ExtendBeforePlanObjectSchema = safeObjectSchema(
  z.object({
    /** Ordered list of step names to insert into the `before-plan` slot. */
    steps: z
      .array(z.string().min(1, "step name must be non-empty"))
      .min(1, "extend before-plan must list at least one step")
      .max(MAX_CONFIG_ARRAY_LENGTH),
  }),
);

export const ExtendBeforePlanSchema = ExtendBeforePlanObjectSchema;

// ---------------------------------------------------------------------------
// Workflow config
// ---------------------------------------------------------------------------

/**
 * A named workflow definition containing an ordered list of steps.
 *
 * - `version`           — positive integer; used for future migration
 * - `steps`             — at least one step is required unless `extends` is set
 * - `extends`           — optional name of a base workflow this workflow extends;
 *                         when set, `steps` may be empty (the extension may add steps
 *                         relative to the base via `insert_before` / `insert_after`)
 * - `extension_points`  — thin publication block declaring engine-visible extension
 *                         surfaces (v1: `before-plan` only)
 * - `prompt_append`     — inline text appended to every step prompt in this workflow;
 *                         rendered as a Mustache template; mutually exclusive with
 *                         `prompt_append_file`
 * - `prompt_append_file`— path to a `.md` file appended to every step prompt in this
 *                         workflow; resolved relative to the config scope's `prompts/`
 *                         directory; rendered as a Mustache template; mutually exclusive
 *                         with `prompt_append`
 *
 * Validation invariants:
 * - A workflow may have **at most one** step with `role: "planning"` — this
 *   uniqueness constraint (`DuplicatePlanningStep`) is always enforced,
 *   regardless of whether `extension_points.before_plan` is set.
 * - When `extension_points.before_plan` is true, exactly one planning step is
 *   also **required** (`MissingPlanningStep`).
 * - `prompt_append` and `prompt_append_file` are mutually exclusive per scope.
 */
export const WorkflowConfigObjectSchema = safeObjectSchema(
  z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      version: z.number().int().positive(),
      steps: z.array(WorkflowStepObjectSchema).max(MAX_CONFIG_ARRAY_LENGTH),
      /** Name of the base workflow this workflow extends. */
      extends: z
        .string()
        .min(1, "extends must be a non-empty workflow name")
        .optional(),
      /** Thin publication block declaring engine-visible extension surfaces. */
      extension_points: ExtensionPointsObjectSchema.optional(),
      /** Inline text appended to every step prompt in this workflow; rendered as a Mustache template. */
      prompt_append: z.string().optional(),
      /**
       * Path to a `.md` file appended to every step prompt in this workflow; resolved relative to
       * the config scope's `prompts/` directory; rendered as a Mustache template.
       * Mutually exclusive with `prompt_append`.
       */
      prompt_append_file: z.string().optional(),
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
          "a workflow that publishes before-plan must have a step with role: planning (MissingPlanningStep)",
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
    )
    .refine(...refinePromptAppendExclusive())
    .refine(...refinePromptFileSafe("prompt_append_file")),
);

export const WorkflowConfigSchema = WorkflowConfigObjectSchema;

export type WorkflowStepType = z.infer<typeof WorkflowStepTypeSchema>;
export type WorkflowStepRole = z.infer<typeof WorkflowStepRoleSchema>;
export type CompletionMethod = z.infer<typeof CompletionMethodSchema>;
export type ArtifactDecl = z.infer<typeof ArtifactDeclSchema>;
export type OnReject = z.infer<typeof OnRejectSchema>;
export type ReconciliationReason = z.infer<typeof ReconciliationReasonSchema>;
export type ReconciliationHandler = z.infer<typeof ReconciliationHandlerSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type ExtensionPoints = z.infer<typeof ExtensionPointsSchema>;
export type ExtendBeforePlan = z.infer<typeof ExtendBeforePlanSchema>;
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
