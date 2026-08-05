/**
 * Zod schemas for validated Weave configuration.
 *
 * All exported TypeScript types are derived from Zod schemas via `z.infer<>`.
 * No hand-written type definitions for config shapes.
 */

import { z } from "zod";
import {
  parseModelIntentEntry,
  THINKING_LEVEL_VALUES,
} from "./model-thinking-syntax.js";
import {
  refinePromptAppendExclusive,
  refinePromptExclusive,
  refinePromptFileSafe,
} from "./prompt-schema-helpers.js";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const ToolPermissionSchema = z.enum(["allow", "deny", "ask"]);

/**
 * A required string that must carry actual content.
 *
 * Rejects both `""` and whitespace-only values with `message`, while preserving
 * the author's original value verbatim — no trimming, so surrounding
 * formatting the author chose survives into the typed config.
 */
function NonBlankStringSchema(message: string) {
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { message });
}

/** Closed, harness-neutral vocabulary for per-model thinking intent. */
export const ThinkingLevelSchema = z.enum(THINKING_LEVEL_VALUES);
export { THINKING_LEVEL_VALUES };

function addModelIntentIssues(
  entries: string[] | undefined,
  fieldPath: string[],
  ctx: z.RefinementCtx,
): void {
  if (entries === undefined) return;
  entries.forEach((entry, index) => {
    const parsed = parseModelIntentEntry(entry);
    if (parsed.isOk()) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...fieldPath, index],
      message: parsed.error.message,
    });
  });
}

export const DelegationTriggerSchema = z.object({
  domain: z.string(),
  trigger: z.string(),
  routing_hint: z.string().optional(),
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

export const DEFAULT_DELEGATION_LIMITS = {
  max_children: 9,
  max_concurrency: 3,
  max_depth: 3,
  max_processes: 9,
} as const;

const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const DelegationSettingsSchema = z
  .object({
    max_children: PositiveSafeIntegerSchema.max(9).optional(),
    max_concurrency: PositiveSafeIntegerSchema.max(9).optional(),
    max_depth: PositiveSafeIntegerSchema.optional(),
    max_processes: PositiveSafeIntegerSchema.optional(),
  })
  .strict()
  .refine(
    (limits) =>
      limits.max_children === undefined ||
      limits.max_concurrency === undefined ||
      limits.max_concurrency <= limits.max_children,
    {
      message: "max_concurrency must be less than or equal to max_children",
      path: ["max_concurrency"],
    },
  );

export const AgentDelegationConfigSchema = z
  .object({
    max_children: PositiveSafeIntegerSchema.max(9).optional(),
    max_concurrency: PositiveSafeIntegerSchema.max(9).optional(),
  })
  .strict()
  .refine(
    (limits) =>
      limits.max_children === undefined ||
      limits.max_concurrency === undefined ||
      limits.max_concurrency <= limits.max_children,
    {
      message: "max_concurrency must be less than or equal to max_children",
      path: ["max_concurrency"],
    },
  );

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
    review_models: z.array(z.string()).min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    mode: z.enum(["primary", "subagent", "all"]).optional(),
    tool_policy: ToolPolicySchema.optional(),
    delegation: AgentDelegationConfigSchema.optional(),
    routing: RoutingConfigSchema.optional(),
    skills: z.array(z.string()).optional(),
    triggers: z.array(DelegationTriggerSchema).optional(),
  })
  .refine(...refinePromptExclusive())
  .refine(...refinePromptFileSafe("prompt_file"))
  .refine(...refinePromptAppendExclusive())
  .refine(...refinePromptFileSafe("prompt_append_file"))
  .superRefine((agent, ctx) => {
    addModelIntentIssues(agent.models, ["models"], ctx);
    addModelIntentIssues(agent.review_models, ["review_models"], ctx);
  });

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/**
 * A routing category. Each category generates a `shuttle-<name>` subagent, so
 * the `description` is required: it is the routing text delegators read when
 * choosing between generated shuttles. Without it a generated shuttle would
 * advertise the generic Shuttle description, which contradicts its domain.
 */
export const CategoryConfigSchema = z
  .object({
    name: z.string().optional(),
    description: NonBlankStringSchema(
      "category description must be a non-empty string",
    ),
    patterns: z
      .array(z.string())
      .min(1, "patterns must have at least one entry"),
    models: z.array(z.string()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    tool_policy: ToolPolicySchema.optional(),
    prompt_append: z.string().optional(),
    prompt_append_file: z.string().optional(),
  })
  .refine(...refinePromptAppendExclusive())
  .refine(...refinePromptFileSafe("prompt_append_file"))
  .superRefine((category, ctx) => {
    addModelIntentIssues(category.models, ["models"], ctx);
  });

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
export const WorkflowStepSchema = z
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
    completion: CompletionMethodSchema,
    inputs: z.array(ArtifactDeclSchema).optional(),
    outputs: z.array(ArtifactDeclSchema).optional(),
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
  )
  .refine(...refinePromptAppendExclusive())
  .refine(...refinePromptFileSafe("prompt_append_file"));

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
  .refine(...refinePromptFileSafe("prompt_append_file"));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Harness-neutral JSON data carried by opaque adapter settings. */
export type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.string(),
    z.number().finite(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const ADAPTER_SETTINGS_MAX_DEPTH = 4;
const ADAPTER_SETTINGS_MAX_BYTES = 64 * 1024;

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function checkAdapterValue(
  value: JsonValue,
  path: (string | number)[],
  depth: number,
  ctx: z.RefinementCtx,
): void {
  if (depth > ADAPTER_SETTINGS_MAX_DEPTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `adapter setting nesting exceeds maximum depth of ${ADAPTER_SETTINGS_MAX_DEPTH}`,
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      checkAdapterValue(entry, [...path, index], depth + 1, ctx);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => {
      checkAdapterValue(entry, [...path, key], depth + 1, ctx);
    });
  }
}

export const AdapterSettingsSchema = z
  .record(z.string(), JsonValueSchema)
  .superRefine((adapters, ctx) => {
    for (const [harness, value] of Object.entries(adapters)) {
      checkAdapterValue(value, [harness], 0, ctx);
      const bytes = new TextEncoder().encode(canonicalJson(value)).byteLength;
      if (bytes > ADAPTER_SETTINGS_MAX_BYTES) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [harness],
          message: `adapter settings exceed the 64 KiB canonical JSON limit (${bytes} bytes)`,
        });
      }
    }
  });

/** Valid log level values (uppercase bare identifiers in DSL). */
export const LogLevelSchema = z.enum([
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);

/** Defaults for Runtime Store journaling and retention. */
export const DEFAULT_RUNTIME_JOURNAL_SETTINGS = {
  strict: false,
  retention_days: 30,
  max_entries: 10_000,
} as const;

export const DEFAULT_RUNTIME_USAGE_SETTINGS = {
  detail_retention_days: 30,
  max_observations: 100_000,
} as const;

export const DEFAULT_RUNTIME_LOG_SETTINGS = {
  max_segment_bytes: 5_242_880,
  max_segments: 3,
} as const;

export const DEFAULT_RUNTIME_SETTINGS = {
  journal: { ...DEFAULT_RUNTIME_JOURNAL_SETTINGS },
  usage: { ...DEFAULT_RUNTIME_USAGE_SETTINGS },
  log: { ...DEFAULT_RUNTIME_LOG_SETTINGS },
} as const;

/** Runtime journal retention + strictness. Bounds: days 1..3650, entries 1..10_000_000. */
export const RuntimeJournalSettingsSchema = z
  .object({
    strict: z.boolean().default(DEFAULT_RUNTIME_JOURNAL_SETTINGS.strict),
    retention_days: PositiveSafeIntegerSchema.max(3650).default(
      DEFAULT_RUNTIME_JOURNAL_SETTINGS.retention_days,
    ),
    max_entries: PositiveSafeIntegerSchema.max(10_000_000).default(
      DEFAULT_RUNTIME_JOURNAL_SETTINGS.max_entries,
    ),
  })
  .default({ ...DEFAULT_RUNTIME_JOURNAL_SETTINGS });

/** Usage-detail retention. Bounds: days 1..3650, observations 1..10_000_000. */
export const RuntimeUsageSettingsSchema = z
  .object({
    detail_retention_days: PositiveSafeIntegerSchema.max(3650).default(
      DEFAULT_RUNTIME_USAGE_SETTINGS.detail_retention_days,
    ),
    max_observations: PositiveSafeIntegerSchema.max(10_000_000).default(
      DEFAULT_RUNTIME_USAGE_SETTINGS.max_observations,
    ),
  })
  .default({ ...DEFAULT_RUNTIME_USAGE_SETTINGS });

/**
 * Rotating log segment bounds.
 * `max_segment_bytes` 65_536..1_073_741_824; `max_segments` 1..100.
 */
export const RuntimeLogSettingsSchema = z
  .object({
    max_segment_bytes: z
      .number()
      .int()
      .min(65_536)
      .max(1_073_741_824)
      .default(DEFAULT_RUNTIME_LOG_SETTINGS.max_segment_bytes),
    max_segments: PositiveSafeIntegerSchema.max(100).default(
      DEFAULT_RUNTIME_LOG_SETTINGS.max_segments,
    ),
  })
  .default({ ...DEFAULT_RUNTIME_LOG_SETTINGS });

/** Runtime-specific settings nested inside `settings { runtime { ... } }`. */
export const RuntimeSettingsSchema = z
  .object({
    journal: RuntimeJournalSettingsSchema,
    usage: RuntimeUsageSettingsSchema,
    log: RuntimeLogSettingsSchema,
  })
  .default({ ...DEFAULT_RUNTIME_SETTINGS });

/**
 * The `settings { ... }` block — canonical home for log level and runtime
 * configuration. Top-level `log_level` is rejected; use `settings { log_level INFO }`.
 */
export const SettingsConfigSchema = z
  .object({
    log_level: LogLevelSchema.default("INFO"),
    delegation: DelegationSettingsSchema.optional(),
    runtime: RuntimeSettingsSchema,
    // Resolve the semantic default after layered config merge. Keeping this
    // optional preserves whether a higher-priority scope omitted the field.
    enforce_permissions: z.boolean().optional(),
    adapters: AdapterSettingsSchema.optional(),
  })
  .default({
    log_level: "INFO",
    runtime: { ...DEFAULT_RUNTIME_SETTINGS },
  });

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
 * top-level directives. The step list is applied globally — there is no
 * per-workflow targeting in v1. The config layer inserts these steps into
 * every workflow that publishes `extension_points { before-plan }`.
 */
export const WeaveConfigSchema = z
  .object({
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
     * Merged `extend before-plan [...]` directives.
     *
     * v1 contract: a single global bucket — no per-workflow targeting.
     * The config layer applies this step list to every workflow that publishes
     * `extension_points { before-plan }`.
     *
     * Defaults to `{ steps: [] }` when no `extend before-plan` directive is present.
     */
    extend_before_plan: ExtendBeforePlanSchema.default({ steps: [] }),
  })
  .superRefine((config, ctx) => {
    const project = config.settings.delegation;
    const projectMaxChildren = project?.max_children;
    const projectMaxConcurrency = project?.max_concurrency;

    for (const [agentName, agent] of Object.entries(config.agents)) {
      const agentLimits = agent.delegation;
      if (agentLimits === undefined) continue;

      if (
        projectMaxChildren !== undefined &&
        agentLimits.max_children !== undefined &&
        agentLimits.max_children > projectMaxChildren
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentName, "delegation", "max_children"],
          message: "agent max_children may not exceed the project cap",
        });
      }

      // AgentDelegationConfigSchema reports this local contradiction. Do not
      // also report it as a project-scope concurrency violation.
      const hasLocalConcurrencyContradiction =
        agentLimits.max_children !== undefined &&
        agentLimits.max_concurrency !== undefined &&
        agentLimits.max_concurrency > agentLimits.max_children;
      if (hasLocalConcurrencyContradiction) continue;

      if (
        projectMaxConcurrency !== undefined &&
        agentLimits.max_concurrency !== undefined &&
        agentLimits.max_concurrency > projectMaxConcurrency
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentName, "delegation", "max_concurrency"],
          message: "agent max_concurrency may not exceed the project cap",
        });
      } else if (
        agentLimits.max_children === undefined &&
        projectMaxChildren !== undefined &&
        agentLimits.max_concurrency !== undefined &&
        agentLimits.max_concurrency > projectMaxChildren
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentName, "delegation", "max_concurrency"],
          message:
            "agent max_concurrency must be less than or equal to effective max_children",
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;
export type ThinkingLevelDecl = z.infer<typeof ThinkingLevelSchema>;
export type DelegationTrigger = z.infer<typeof DelegationTriggerSchema>;
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type DelegationSettings = z.infer<typeof DelegationSettingsSchema>;
export type AgentDelegationConfig = z.infer<typeof AgentDelegationConfigSchema>;
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
 * One of the four closed built-in reconciliation reasons.
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
/** Runtime journal retention/strict settings. */
export type RuntimeJournalSettings = z.infer<
  typeof RuntimeJournalSettingsSchema
>;
/** Runtime usage-detail retention settings. */
export type RuntimeUsageSettings = z.infer<typeof RuntimeUsageSettingsSchema>;
/** Runtime rotating-log segment settings. */
export type RuntimeLogSettings = z.infer<typeof RuntimeLogSettingsSchema>;
/** Runtime-specific settings (journal, usage, log retention). */
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
/** The `settings { ... }` block config shape. */
export type JsonAdapterSettings = z.infer<typeof AdapterSettingsSchema>;
export type SettingsConfig = z.infer<typeof SettingsConfigSchema>;
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;
