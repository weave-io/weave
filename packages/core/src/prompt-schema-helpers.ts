import { posix, win32 } from "node:path";

/**
 * Shared Zod refinement helpers for prompt-related schema invariants.
 *
 * These helpers centralize the two repeated constraints that appear across
 * agent, category, workflow step, and workflow config schemas:
 *
 * 1. **Prompt append mutual exclusivity** — `prompt_append` and
 *    `prompt_append_file` are mutually exclusive within the same scope.
 * 2. **Prompt file path safety** — `prompt_file` and `prompt_append_file`
 *    must be relative paths without `..` segments or absolute prefixes.
 *
 * Usage:
 * ```ts
 * import { refinePromptAppendExclusive, refinePromptFileSafe } from "./prompt-schema-helpers.js";
 *
 * const MySchema = z.object({ ... })
 *   .refine(...refinePromptAppendExclusive())
 *   .refine(...refinePromptFileSafe("prompt_file"))
 *   .refine(...refinePromptFileSafe("prompt_append_file"));
 * ```
 */

// ---------------------------------------------------------------------------
// Mutual exclusivity
// ---------------------------------------------------------------------------

type HasPromptAppend = {
  prompt_append?: string;
  prompt_append_file?: string;
};

/**
 * Returns a `[predicate, options]` tuple for use with Zod `.refine()`.
 *
 * Rejects when both `prompt_append` and `prompt_append_file` are set.
 */
export function refinePromptAppendExclusive(): [
  (data: HasPromptAppend) => boolean,
  { message: string },
] {
  return [
    (data) =>
      !(
        data.prompt_append !== undefined &&
        data.prompt_append_file !== undefined
      ),
    { message: "prompt_append and prompt_append_file are mutually exclusive" },
  ];
}

// ---------------------------------------------------------------------------
// Prompt / prompt_file mutual exclusivity (agent-only)
// ---------------------------------------------------------------------------

type HasPromptAndFile = {
  prompt?: string;
  prompt_file?: string;
};

/**
 * Returns a `[predicate, options]` tuple for use with Zod `.refine()`.
 *
 * Rejects when both `prompt` and `prompt_file` are set.
 */
export function refinePromptExclusive(): [
  (data: HasPromptAndFile) => boolean,
  { message: string },
] {
  return [
    (data) => !(data.prompt !== undefined && data.prompt_file !== undefined),
    { message: "prompt and prompt_file are mutually exclusive" },
  ];
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

type HasPromptFile = Record<string, unknown>;

/**
 * Returns a `[predicate, options]` tuple for use with Zod `.refine()`.
 *
 * Rejects when the named field is set to an absolute path or a path
 * containing `..` segments. Safe relative paths (e.g. `"shuttle.md"`,
 * `"subdir/extra.md"`) are accepted.
 *
 * @param field - The field name to check (e.g. `"prompt_file"`, `"prompt_append_file"`).
 */
export function refinePromptFileSafe(
  field: string,
): [(data: HasPromptFile) => boolean, { message: string }] {
  return [
    (data) => {
      const value = data[field];
      if (value === undefined) return true;
      if (typeof value !== "string") return true;
      if (posix.isAbsolute(value) || win32.isAbsolute(value)) return false;
      if (value.split(/[\\/]+/).some((segment) => segment === ".."))
        return false;
      return true;
    },
    {
      message: `${field} must be a relative path without '..' or absolute paths`,
    },
  ];
}
