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
    edit: ToolPermissionSchema.optional(),
    delegate: ToolPermissionSchema.optional(),
    search: ToolPermissionSchema.optional(),
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
// Top-level WeaveConfig
// ---------------------------------------------------------------------------

export const WeaveConfigSchema = z.object({
  agents: z.record(z.string(), AgentConfigSchema).default({}),
  categories: z.record(z.string(), CategoryConfigSchema).default({}),
  disabled: DisabledConfigSchema.default({ agents: [], hooks: [], skills: [] }),
  log_level: z
    .enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"])
    .optional(),
  workflows: z.record(z.string(), z.unknown()).optional(),
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
export type WeaveConfig = z.infer<typeof WeaveConfigSchema>;
