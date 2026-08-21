import { z } from "zod";
import {
  refinePromptAppendExclusive,
  refinePromptExclusive,
  refinePromptFileSafe,
} from "./prompt-schema-helpers.js";
import { safeObjectSchema } from "./safe-schema-input.js";
import {
  addModelIntentIssues,
  MAX_CONFIG_ARRAY_LENGTH,
  MAX_DELEGATION_LIMITS,
  NonBlankStringSchema,
  PositiveSafeIntegerSchema,
  ToolPermissionSchema,
} from "./schema-common.js";

export const ToolPolicyObjectSchema = safeObjectSchema(
  z
    .object({
      read: ToolPermissionSchema.optional(),
      write: ToolPermissionSchema.optional(),
      execute: ToolPermissionSchema.optional(),
      delegate: ToolPermissionSchema.optional(),
      network: ToolPermissionSchema.optional(),
    })
    .strict(),
);

export const ToolPolicySchema = ToolPolicyObjectSchema;

export const DelegationSettingsObjectSchema = safeObjectSchema(
  z
    .object({
      max_children: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_children,
      ).optional(),
      max_concurrency: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_concurrency,
      ).optional(),
      max_depth: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_depth,
      ).optional(),
      max_processes: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_processes,
      ).optional(),
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
    ),
);

export const DelegationSettingsSchema = DelegationSettingsObjectSchema;

export const AgentDelegationConfigObjectSchema = safeObjectSchema(
  z
    .object({
      max_children: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_children,
      ).optional(),
      max_concurrency: PositiveSafeIntegerSchema.max(
        MAX_DELEGATION_LIMITS.max_concurrency,
      ).optional(),
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
    ),
);

export const AgentDelegationConfigSchema = AgentDelegationConfigObjectSchema;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Per-agent routing knobs. Open for future fields (priority, fallback,
 * weighted routes). Strict — unknown keys are rejected so typos surface
 * clearly.
 */
export const RoutingConfigObjectSchema = safeObjectSchema(
  z
    .object({
      delegation_exclude: z
        .array(z.string())
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
    })
    .strict(),
);

export const RoutingConfigSchema = RoutingConfigObjectSchema;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const AgentConfigObjectSchema = safeObjectSchema(
  z
    .object({
      name: z.string().optional(),
      description: z.string().optional(),
      display_name: z.string().optional(),
      prompt: z.string().optional(),
      prompt_file: z.string().optional(),
      prompt_append: z.string().optional(),
      prompt_append_file: z.string().optional(),
      models: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).optional(),
      review_models: z
        .array(z.string())
        .min(1)
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
      temperature: z.number().min(0).max(2).optional(),
      mode: z.enum(["primary", "subagent", "all"]).optional(),
      tool_policy: ToolPolicyObjectSchema.optional(),
      delegation: AgentDelegationConfigObjectSchema.optional(),
      routing: RoutingConfigObjectSchema.optional(),
      skills: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).optional(),
      triggers: z
        .array(NonBlankStringSchema("trigger must be a non-empty string"))
        .min(1, "triggers must have at least one entry")
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
      fast: z.literal(true).optional(),
    })
    .strict()
    .refine(...refinePromptExclusive())
    .refine(...refinePromptFileSafe("prompt_file"))
    .refine(...refinePromptAppendExclusive())
    .refine(...refinePromptFileSafe("prompt_append_file"))
    .superRefine((agent, ctx) => {
      addModelIntentIssues(agent.models, ["models"], ctx);
      addModelIntentIssues(agent.review_models, ["review_models"], ctx);
    }),
);

export const AgentConfigSchema = AgentConfigObjectSchema;

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/**
 * A routing category. Each category generates a `shuttle-<name>` subagent, so
 * the `description` is required: it is the routing text delegators read when
 * choosing between generated shuttles. Without it a generated shuttle would
 * advertise the generic Shuttle description, which contradicts its domain.
 */
export const CategoryConfigObjectSchema = safeObjectSchema(
  z
    .object({
      name: z.string().optional(),
      description: NonBlankStringSchema(
        "category description must be a non-empty string",
      ),
      models: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).optional(),
      triggers: z
        .array(NonBlankStringSchema("trigger must be a non-empty string"))
        .min(1, "triggers must have at least one entry")
        .max(MAX_CONFIG_ARRAY_LENGTH)
        .optional(),
      fast: z.literal(true).optional(),
      temperature: z.number().min(0).max(2).optional(),
      tool_policy: ToolPolicySchema.optional(),
      prompt_append: z.string().optional(),
      prompt_append_file: z.string().optional(),
    })
    .strict()
    .refine(...refinePromptAppendExclusive())
    .refine(...refinePromptFileSafe("prompt_append_file"))
    .superRefine((category, ctx) => {
      addModelIntentIssues(category.models, ["models"], ctx);
    }),
);

export const CategoryConfigSchema = CategoryConfigObjectSchema;

// ---------------------------------------------------------------------------
// Disabled
// ---------------------------------------------------------------------------

export const DisabledConfigSchema = safeObjectSchema(
  z.object({
    agents: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).default([]),
    hooks: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).default([]),
    skills: z.array(z.string()).max(MAX_CONFIG_ARRAY_LENGTH).default([]),
  }),
);

export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type DelegationSettings = z.infer<typeof DelegationSettingsSchema>;
export type AgentDelegationConfig = z.infer<typeof AgentDelegationConfigSchema>;
/** Per-agent routing configuration (delegation_exclude, etc.). */
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type CategoryConfig = z.infer<typeof CategoryConfigSchema>;
