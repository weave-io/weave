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
/**
 * Shape a trusted identity label may take: declared agent names and workflow
 * step names are DSL identifiers, so they carry no whitespace, no quotes and
 * no sentence punctuation. Legacy task-derived titles were bounded first
 * lines of free prompt text and practically never match this class.
 */
const IDENTITY_LABEL_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]*$/;

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

// ---------------------------------------------------------------------------
// Provenance of stored titles (Warp blocker 1)
// ---------------------------------------------------------------------------

/**
 * A stored title plus the opaque thread identity it claims to belong to.
 *
 * `threadId` is the only trusted anchor available at the ref and cache
 * boundaries, so it is required: a title that cannot be bound to an identity
 * cannot be proven and is therefore replaced.
 */
export interface PiStoredChildTitle {
  /** Title as read back from a durable ref or cache row. */
  readonly title: string;
  /** Opaque child/thread id of the row the title was stored on. */
  readonly threadId?: string;
}

/**
 * Whether a stored title provably came from {@link resolveDurableChildTitle}.
 *
 * Refs and cache rows written before the durable-title fix stored a bounded
 * first line of the delegated task, so a stored title is prompt content until
 * proven otherwise. Proof is structural and self-verifying:
 *
 *   1. the title must end with `-<suffix>`, where `<suffix>` is the bounded
 *      alphanumeric tail of this row's own opaque thread id — a binding no
 *      free-text task line can satisfy except by astronomical coincidence;
 *   2. the remaining label must look like a declared agent or workflow-step
 *      identity (no whitespace, no sentence punctuation);
 *   3. re-deriving the title from that label and thread id must reproduce the
 *      stored string exactly, so truncation or drift also fails.
 *
 * Rows without a usable thread id have no anchor at all and are never proven.
 * Pure and total: it never throws and never reads transcript state.
 */
export function isProvenDurableChildTitle(stored: PiStoredChildTitle): boolean {
  const { title } = stored;
  if (typeof title !== "string" || title.length === 0) return false;
  if (title.length > PI_CHILD_TITLE_BOUNDS.maxTitleLength) return false;
  const suffix = durableChildTitleSuffix(stored.threadId);
  if (suffix.length === 0) return false;
  const marker = `${SUFFIX_SEPARATOR}${suffix}`;
  if (!title.endsWith(marker)) return false;
  const label = title.slice(0, title.length - marker.length);
  if (label.length === 0) return false;
  if (label.length > PI_CHILD_TITLE_BOUNDS.maxLabelLength) return false;
  if (!IDENTITY_LABEL_PATTERN.test(label)) return false;
  return (
    resolveDurableChildTitle({
      agentName: label,
      threadId: stored.threadId,
    }) === title
  );
}

/**
 * The title that may safely be persisted or displayed for one stored row.
 *
 * Proven titles are returned byte-identical, so reconstruction is idempotent
 * and no title drifts across ref → cache → picker → CLI. Unproven titles —
 * every legacy task-derived title — are discarded and replaced by the
 * deterministic identity-only fallback for the same thread id, which contains
 * nothing but {@link PI_CHILD_TITLE_FALLBACK_LABEL} and an opaque suffix.
 *
 * Applying this twice is a no-op: the fallback is itself a proven title
 * whenever a thread id is available.
 */
export function enforceDurableChildTitle(stored: PiStoredChildTitle): string {
  if (isProvenDurableChildTitle(stored)) return stored.title;
  return resolveDurableChildTitle({ threadId: stored.threadId });
}
