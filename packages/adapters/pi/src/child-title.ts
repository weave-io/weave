/**
 * Durable child title derivation (Spec 33 §4.2 / §13, Threat Model T6).
 *
 * A child's persisted title is operational metadata: it is written to parent
 * and thread refs, cached in SQLite, reconstructed after a restart, and shown
 * in pickers, `/weave:history`, `/weave:doctor` and the adapter CLI. It must
 * therefore never be derived from prompt or transcript content — not the task
 * text, not tool input, not child output, not a transcript entry.
 *
 * The only inputs allowed here are identities the config/schema layer already
 * bounds: the declared agent name, an explicit workflow step name, and an
 * opaque child/thread identifier used purely as a uniqueness suffix.
 */

// A regex literal would carry control characters, which the repo lint forbids;
// the patterns are built from named `String.raw` sources instead.
const ANSI_ESCAPE_SOURCE = String.raw`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)`;
const CONTROL_CHARACTER_SOURCE = String.raw`[\u0000-\u001f\u007f]`;
const ANSI_ESCAPE_PATTERN = new RegExp(ANSI_ESCAPE_SOURCE, "g");
const CONTROL_CHARACTER_PATTERN = new RegExp(CONTROL_CHARACTER_SOURCE, "g");
/** Everything outside this class is dropped from an opaque suffix. */
const OPAQUE_SUFFIX_PATTERN = /[^0-9A-Za-z]/g;

/** Hard bounds for a durable child title. */
export const PI_CHILD_TITLE_BOUNDS = Object.freeze({
  /** Upper bound of the whole rendered title, suffix included. */
  maxTitleLength: 200,
  /** Upper bound of the identity label before any suffix is appended. */
  maxLabelLength: 128,
  /** Characters of the opaque child/thread id kept as a uniqueness suffix. */
  maxSuffixLength: 8,
});

/** Label used when no trusted identity is available at all. */
export const PI_CHILD_TITLE_FALLBACK_LABEL = "child";

/** Separator between the identity label and the opaque suffix. */
const SUFFIX_SEPARATOR = "-";

/**
 * Trusted, non-prompt inputs a durable title may be built from.
 *
 * Every field is optional so that a partially known thread still resolves to a
 * deterministic title instead of failing. There is deliberately no free-text
 * `title` field: adding one would reintroduce a caller-controlled channel for
 * prompt text into durable metadata.
 */
export interface PiDurableChildTitleInput {
  /** Declared agent identity from config. */
  readonly agentName?: string;
  /** Explicit workflow step identity, when the run has one. */
  readonly workflowStep?: string;
  /** Opaque child or thread id; only a bounded suffix of it is used. */
  readonly threadId?: string;
}

function sanitizeIdentity(value: string | undefined): string {
  if (!value) return "";
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}

/**
 * The bounded opaque suffix of a child/thread id, or `""` when the id carries
 * no usable characters. Only alphanumerics survive, so a suffix can never
 * reintroduce separators, control characters or path-like text.
 */
export function durableChildTitleSuffix(threadId: string | undefined): string {
  if (!threadId) return "";
  const compact = threadId.replace(OPAQUE_SUFFIX_PATTERN, "");
  if (compact.length === 0) return "";
  return compact.slice(-PI_CHILD_TITLE_BOUNDS.maxSuffixLength);
}

/**
 * Resolves the durable title for one child thread.
 *
 * Deterministic fallback order for the identity label:
 *   1. declared agent name
 *   2. explicit workflow step name
 *   3. the constant {@link PI_CHILD_TITLE_FALLBACK_LABEL}
 *
 * The label is bounded to {@link PI_CHILD_TITLE_BOUNDS.maxLabelLength}. When an
 * opaque child/thread id is supplied, a bounded alphanumeric suffix of it is
 * appended for uniqueness. The whole result is bounded to
 * {@link PI_CHILD_TITLE_BOUNDS.maxTitleLength}.
 *
 * Pure and total: it never throws and never reads prompt or transcript state.
 */
export function resolveDurableChildTitle(
  input: PiDurableChildTitleInput,
): string {
  const agent = sanitizeIdentity(input.agentName);
  const step = sanitizeIdentity(input.workflowStep);
  let identity = PI_CHILD_TITLE_FALLBACK_LABEL;
  if (agent.length > 0) {
    identity = agent;
  } else if (step.length > 0) {
    identity = step;
  }
  const label = boundLabel(identity, PI_CHILD_TITLE_BOUNDS.maxLabelLength);
  const suffix = durableChildTitleSuffix(input.threadId);
  const title =
    suffix.length === 0 ? label : `${label}${SUFFIX_SEPARATOR}${suffix}`;
  return boundLabel(title, PI_CHILD_TITLE_BOUNDS.maxTitleLength);
}
