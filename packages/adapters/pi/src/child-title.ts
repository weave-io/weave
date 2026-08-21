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

import { z } from "zod";
import type { JsonValue } from "./strict-json.js";

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

// ---------------------------------------------------------------------------
// Provenance of stored titles (Warp blocker 1, Task 21 remediation D)
// ---------------------------------------------------------------------------

/**
 * Closed set of durable title-provenance markers.
 *
 * A marker is written only by code that built the title from trusted identity
 * metadata through {@link resolveDurableChildTitle}. It is a versioned literal,
 * not a shape: no arrangement of task text can produce one, so provenance can
 * no longer be guessed from how a stored title happens to look.
 *
 * The set is closed on purpose. Adding a value is a schema change: readers of
 * older rows must keep failing closed on markers they do not understand.
 */
export const PI_CHILD_TITLE_PROVENANCE_VALUES = Object.freeze([
  "trusted-identity-v1",
] as const);

/** One accepted durable title-provenance marker. */
const PiChildTitleProvenanceSchema = z.enum(PI_CHILD_TITLE_PROVENANCE_VALUES);

export type PiChildTitleProvenance =
  (typeof PI_CHILD_TITLE_PROVENANCE_VALUES)[number];

/** Values accepted at the untrusted provenance boundary. */
type PiChildTitleProvenanceCandidate = JsonValue | undefined;

/**
 * Marker stamped on every durable child title written from this version.
 *
 * Bump the version — do not redefine this string — when the meaning of a
 * trusted title changes, so rows written by an older adapter stay
 * distinguishable instead of silently inheriting new semantics.
 */
export const PI_CHILD_TITLE_PROVENANCE: PiChildTitleProvenance =
  "trusted-identity-v1";

/**
 * Whether an arbitrary value is one of the accepted markers.
 *
 * Total and closed: anything that is not an exact member of
 * {@link PI_CHILD_TITLE_PROVENANCE_VALUES} — including `undefined`, a legacy
 * row's absent field, a near-miss version string, or a non-string — is not
 * trusted. Pure; never throws.
 */
export function isTrustedChildTitleProvenance(
  value: PiChildTitleProvenanceCandidate,
): value is PiChildTitleProvenance {
  return PiChildTitleProvenanceSchema.safeParse(value).success;
}

/**
 * A stored title plus the opaque thread identity and provenance marker of the
 * row it was read from.
 *
 * `threadId` anchors the safe fallback to the row's own identity. `provenance`
 * is the only proof that the stored title itself may be shown: it is optional
 * so that legacy rows written before the marker existed still parse, but an
 * absent marker means unproven, never trusted.
 */
export interface PiStoredChildTitle {
  /** Title as read back from a durable ref or cache row. */
  readonly title: string;
  /** Opaque child/thread id of the row the title was stored on. */
  readonly threadId?: string;
  /** Versioned provenance marker persisted alongside the title, if any. */
  readonly provenance?: string;
}

/**
 * Whether a stored title is proven to have been written from trusted identity
 * metadata.
 *
 * Proof is the persisted marker and nothing else. Structural resemblance to a
 * derived title is explicitly *not* proof: a legacy row whose stored task text
 * happens to read `agent-12345678` is still prompt content, and treating its
 * shape as evidence would let any delegated task forge its own provenance.
 *
 * A proven title must additionally stay inside the durable bounds, so a row
 * that carries a valid marker but an out-of-bounds or empty title still fails
 * closed to the fallback rather than reaching a sink.
 *
 * Pure and total: it never throws and never reads transcript state.
 */
export function isProvenDurableChildTitle(stored: PiStoredChildTitle): boolean {
  if (!isTrustedChildTitleProvenance(stored.provenance)) return false;
  const { title } = stored;
  if (title.length === 0) return false;
  return title.length <= PI_CHILD_TITLE_BOUNDS.maxTitleLength;
}

/**
 * The title that may safely be persisted or displayed for one stored row.
 *
 * Proven titles are returned byte-identical, so reconstruction is idempotent
 * and no title drifts across ref → cache → picker → CLI. Unproven titles —
 * every legacy row, and every row whose marker is absent or unrecognized — are
 * discarded and replaced by the deterministic identity-only fallback for the
 * same thread id, which contains nothing but
 * {@link PI_CHILD_TITLE_FALLBACK_LABEL} and an opaque suffix.
 *
 * Applying this twice is a no-op: the second call sees the same marker and the
 * same fallback input, so the result never changes.
 */
export function enforceDurableChildTitle(stored: PiStoredChildTitle): string {
  if (isProvenDurableChildTitle(stored)) return stored.title;
  return resolveDurableChildTitle({ threadId: stored.threadId });
}

/**
 * The provenance marker that may safely be persisted for one stored row.
 *
 * A row whose title survives {@link enforceDurableChildTitle} keeps its marker.
 * A row whose title was replaced by the fallback is re-marked as trusted,
 * because the fallback itself is derived only from identity metadata. Callers
 * therefore never persist a trusted-looking title beside an absent marker, nor
 * an untrusted marker beside a safe title.
 */
export function enforceDurableChildTitleProvenance(
  stored: PiStoredChildTitle,
): PiChildTitleProvenance {
  if (isProvenDurableChildTitle(stored)) {
    const parsed = PiChildTitleProvenanceSchema.safeParse(stored.provenance);
    return parsed.success ? parsed.data : PI_CHILD_TITLE_PROVENANCE;
  }
  return PI_CHILD_TITLE_PROVENANCE;
}
