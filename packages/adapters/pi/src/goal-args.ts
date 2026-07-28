const PLAN_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CONTROL_PREFIX = "--";

export type WeaveGoalArgs =
  | { readonly kind: "status" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume"; readonly direction?: string }
  | { readonly kind: "clear" }
  | { readonly kind: "start"; readonly planName: string }
  | { readonly kind: "invalid"; readonly reason: string };

const STATUS_ALIASES = new Set(["check", "status"]);
const CLEAR_ALIASES = new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
]);

function invalid(reason: string): WeaveGoalArgs {
  return { kind: "invalid", reason };
}

/** Parse `/weave:goal` arguments without discovering or reading plans. */
export function parseWeaveGoalArgs(raw: string): WeaveGoalArgs {
  const input = raw.trim();

  if (input === "") return { kind: "status" };

  const control = input.toLowerCase();
  if (STATUS_ALIASES.has(control)) return { kind: "status" };
  if (CLEAR_ALIASES.has(control)) return { kind: "clear" };
  if (control === "pause") return { kind: "pause" };

  const resumeMatch = input.match(/^resume(?:\s+([\s\S]*))?$/i);
  if (resumeMatch !== null) {
    const direction = resumeMatch[1]?.trim();
    return direction === undefined || direction === ""
      ? { kind: "resume" }
      : { kind: "resume", direction };
  }

  const planName = input.startsWith(CONTROL_PREFIX)
    ? input.slice(CONTROL_PREFIX.length).trim()
    : input;

  if (planName === "") return invalid("a plan name is required");
  if (!PLAN_NAME_PATTERN.test(planName)) {
    return invalid("plan name must use only letters, numbers, '_' or '-'");
  }

  return { kind: "start", planName };
}
