// Import the pure parser module, not the config barrel (which initializes server I/O).
import { MAX_PLAN_NAME_LENGTH } from "@weaveio/weave-config/plan-task-parser";

export const SAFE_PLAN_NAME = new RegExp(
  `^[A-Za-z0-9_-]{1,${MAX_PLAN_NAME_LENGTH}}$`,
);

export type PlanNameParse =
  | { readonly type: "missing" }
  | { readonly type: "valid"; readonly name: string }
  | { readonly type: "invalid" };

export function parsePlanName(text: string): PlanNameParse {
  const stripped = text
    .trim()
    .replace(/^\/?weave:start(?:\s+|$)/i, "")
    .trim();
  if (stripped.length === 0) return { type: "missing" };
  const match = stripped.match(
    /^(?:\.\/)?(?:\.weave\/plans\/)?([A-Za-z0-9_-]+)(?:\.md)?$/,
  );
  const name = match?.[1];
  if (name === undefined || !SAFE_PLAN_NAME.test(name))
    return { type: "invalid" };
  return { type: "valid", name };
}

export const INVALID_PLAN_NAME_MESSAGE = `The plan name is invalid. Use a basename of 1 to ${MAX_PLAN_NAME_LENGTH} letters, numbers, underscores, or hyphens.`;

export const PLAN_CATALOG_UNREADABLE_MESSAGE = "Weave could not list plans.";
