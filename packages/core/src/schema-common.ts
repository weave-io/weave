/** Shared primitives and bounds for the public Weave schemas. */

import { z } from "zod";
import {
  parseModelIntentEntry,
  THINKING_LEVEL_VALUES,
} from "./model-thinking-syntax.js";

/** Public maximum for every bounded configuration list, including model lists. */
export const MAX_CONFIG_ARRAY_LENGTH = 512;

export function recordEntries<T>(
  record: Record<string, T>,
): Iterable<readonly [string, T]> {
  if (record instanceof Map) return record.entries();
  return Object.entries(record);
}

export const ToolPermissionSchema = z.enum(["allow", "deny", "ask"]);

/** A required string that preserves author formatting while rejecting blanks. */
export function NonBlankStringSchema(message: string) {
  return z
    .string({ error: message })
    .refine((value) => value.trim().length > 0, { message });
}

/** Closed, harness-neutral vocabulary for per-model thinking intent. */
export const ThinkingLevelSchema = z.enum(THINKING_LEVEL_VALUES);
export { THINKING_LEVEL_VALUES };

export function addModelIntentIssues(
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

export const DEFAULT_DELEGATION_LIMITS = {
  max_children: 32,
  max_concurrency: 8,
  max_depth: 8,
  max_processes: 32,
} as const;

export const MAX_DELEGATION_LIMITS = {
  max_children: 256,
  max_concurrency: 64,
  max_depth: 32,
  max_processes: 128,
} as const;

export const PositiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export type ToolPermission = z.infer<typeof ToolPermissionSchema>;
export type ThinkingLevelDecl = z.infer<typeof ThinkingLevelSchema>;
