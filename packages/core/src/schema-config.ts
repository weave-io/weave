import { z } from "zod";
import { safeObjectSchema, safeRecordSchema } from "./safe-schema-input.js";
import {
  AgentConfigObjectSchema,
  CategoryConfigObjectSchema,
  DisabledConfigSchema,
} from "./schema-agent.js";
import { recordEntries } from "./schema-common.js";
import { SettingsConfigObjectSchema } from "./schema-settings.js";
import {
  ExtendBeforePlanObjectSchema,
  WorkflowConfigObjectSchema,
} from "./schema-workflow.js";

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
const WeaveConfigObjectSchema = safeObjectSchema(
  z
    .object({
      agents: safeRecordSchema(AgentConfigObjectSchema).default({}),
      categories: safeRecordSchema(CategoryConfigObjectSchema).default({}),
      disabled: DisabledConfigSchema.default({
        agents: [],
        hooks: [],
        skills: [],
      }),
      settings: SettingsConfigObjectSchema,
      workflows: safeRecordSchema(WorkflowConfigObjectSchema).default({}),
      /**
       * Merged `extend before-plan [...]` directives.
       *
       * v1 contract: a single global bucket — no per-workflow targeting.
       * The config layer applies this step list to every workflow that publishes
       * `extension_points { before-plan }`.
       *
       * Defaults to `{ steps: [] }` when no `extend before-plan` directive is present.
       */
      extend_before_plan: ExtendBeforePlanObjectSchema.default({ steps: [] }),
    })
    .superRefine((config, ctx) => {
      const project = config.settings.delegation;
      const projectMaxChildren = project?.max_children;
      const projectMaxConcurrency = project?.max_concurrency;

      for (const [agentName, agent] of recordEntries(config.agents)) {
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
    }),
);

export const WeaveConfigSchema = WeaveConfigObjectSchema;
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;
