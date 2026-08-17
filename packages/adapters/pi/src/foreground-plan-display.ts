/**
 * The FOREGROUND plan display identity: which plan the parent session is
 * working through right now, when no durable workflow instance exists.
 *
 * `/weave:start` and a direct "execute `.weave/plans/<name>.md`" request both
 * run Tapestry in the parent's own turn. Neither creates a workflow instance,
 * so `active-plan-ui-state.ts` — which resolves only a durable instance or an
 * eligible recovery pointer — had nothing to resolve, and the Plan Rail showed
 * its agent row alone while the user watched a plan being executed.
 *
 * ## What this module is, and is not
 *
 * It is READ-ONLY UI STATE. It names a plan for the rail to display and does
 * nothing else: it never starts, resumes, or authorizes an execution, never
 * acquires a lease, never touches the runtime store, and never transitions a
 * task. It is deliberately the LAST display authority — a durable workflow and
 * an eligible recovery pointer both outrank it — so it can only ever fill a
 * gap, never contradict authoritative execution state.
 *
 * ## Where an identity may come from
 *
 * Exactly two places, both user-authorized:
 *
 * 1. `/weave:start`, from the plan the user selected and confirmed;
 * 2. one direct interactive message that explicitly asks for exactly one
 *    contained `.weave/plans/<safe-name>.md` to be executed.
 *
 * Nothing else. Assistant text, system prompts, tool output, arbitrary prose
 * about "the plan", and any filesystem scan outside the project root are all
 * structurally excluded: {@link parseForegroundPlanRequest} reads one bounded
 * string and returns a safe basename or a typed rejection, and the caller must
 * still prove catalog membership and read the snapshot before displaying it.
 *
 * ## Surviving a restart
 *
 * A selection is recorded as ONE bounded adapter-owned custom session entry
 * and reconstructed from that entry alone. Model prose in the transcript is
 * never re-parsed on startup: a restart that re-read the conversation could be
 * steered by anything the session happens to contain.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

/** The adapter-owned custom session entry that survives a restart. */
export const FOREGROUND_PLAN_ENTRY_TYPE = "weave.plan.foreground";

/**
 * The same safe-name allowlist the plan catalog and the engine's plan-name
 * validation use. A name that would not validate as a plan name is never
 * displayed, recorded, or looked up.
 */
const SAFE_PLAN_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Ceiling on a plan basename. Longer names are rejected, never truncated. */
export const MAX_FOREGROUND_PLAN_NAME_LENGTH = 128;

/**
 * Ceiling on the user text one request may be parsed from.
 *
 * A longer message is REJECTED rather than scanned: this parser runs on every
 * interactive submission, and an unbounded scan of pasted content is a cost
 * the UI has no reason to pay.
 */
export const MAX_FOREGROUND_PLAN_REQUEST_LENGTH = 4_096;

/** Ceiling on the newest session entries a restart will scan. */
export const MAX_FOREGROUND_PLAN_ENTRY_SCAN = 512;

/** Why a direct request did not name a foreground plan. */
export type ForegroundPlanRequestRejection =
  | "input-too-long"
  | "no-plan-path"
  | "unsafe-plan-path"
  | "multiple-plans"
  | "no-execution-intent";

/**
 * Words that make a message a request to EXECUTE a plan.
 *
 * Deliberately a closed, small vocabulary. The alternative — inferring intent
 * from prose — is exactly what this module refuses to do: a message that
 * merely mentions a plan file (a question about it, a diff, a review) must
 * never move the rail.
 */
const EXECUTION_INTENT_RE =
  /\b(?:execute|run|start|implement|continue|resume|finish|work\s+through|carry\s+out)\b/iu;

/**
 * One contained plan path: an optional `./`, then exactly `.weave/plans/`,
 * then one safe basename, then `.md`.
 *
 * The pattern is anchored on its left by a start-of-input or a separator, so
 * `../other-worktree/.weave/plans/alpha.md` and
 * `/Users/someone/other/.weave/plans/alpha.md` do not match: a path that
 * reaches outside this project root is not parsed into the basename it happens
 * to end with.
 */
const PLAN_PATH_RE =
  /(?:^|[\s"'`([])(?:\.\/)?\.weave\/plans\/([A-Za-z0-9_-]+)\.md(?=$|[\s"'`)\],.;:!?])/gu;

/**
 * Any mention of the plans directory at all.
 *
 * Used to tell "no plan was named" apart from "a plan-ish path was named that
 * this parser refuses to accept". A traversal, an absolute path, a nested
 * subdirectory, or an unsafe basename must be REJECTED, not silently read as
 * prose that named nothing.
 */
const PLAN_PATH_MENTION_RE = /\.weave\/plans\//u;

/**
 * Parses one direct user message into the single plan it explicitly asks to
 * execute.
 *
 * Fail-closed at every step: over the length bound, no plan path, a path this
 * parser will not accept, more than one distinct plan, or no explicit
 * execution request all return a typed rejection and change nothing.
 *
 * A successful parse is NOT authority to display: the caller must still prove
 * the name is in this project root's plan catalog and that its snapshot reads.
 */
export function parseForegroundPlanRequest(
  text: string,
): Result<string, ForegroundPlanRequestRejection> {
  if (typeof text !== "string") return err("no-plan-path");
  if (text.length > MAX_FOREGROUND_PLAN_REQUEST_LENGTH) {
    return err("input-too-long");
  }
  const names = new Set<string>();
  // A fresh regex per call: a shared /g literal carries `lastIndex` between
  // calls and would skip the first match of every second message.
  const pattern = new RegExp(PLAN_PATH_RE.source, PLAN_PATH_RE.flags);
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1];
    if (name !== undefined) names.add(name);
    match = pattern.exec(text);
  }
  if (names.size === 0) {
    return err(
      PLAN_PATH_MENTION_RE.test(text) ? "unsafe-plan-path" : "no-plan-path",
    );
  }
  if (names.size > 1) return err("multiple-plans");
  const [name] = [...names];
  if (name === undefined || !isSafeForegroundPlanName(name)) {
    return err("unsafe-plan-path");
  }
  if (!EXECUTION_INTENT_RE.test(text)) return err("no-execution-intent");
  return ok(name);
}

/** True when a name is a plan basename this module will display or record. */
export function isSafeForegroundPlanName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FOREGROUND_PLAN_NAME_LENGTH &&
    SAFE_PLAN_NAME_RE.test(value)
  );
}

/** The bounded payload of one recorded selection. */
export const ForegroundPlanEntrySchema = z
  .object({
    v: z.literal(1),
    planName: z
      .string()
      .min(1)
      .max(MAX_FOREGROUND_PLAN_NAME_LENGTH)
      .regex(SAFE_PLAN_NAME_RE),
  })
  .strict();

export type ForegroundPlanEntry = z.infer<typeof ForegroundPlanEntrySchema>;

/** Builds the payload for `appendEntry(FOREGROUND_PLAN_ENTRY_TYPE, …)`. */
export function foregroundPlanEntry(planName: string): ForegroundPlanEntry {
  return { v: 1, planName };
}

const customTypeOf = (entry: unknown): string | undefined => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const value = (entry as Record<string, unknown>).customType;
  return typeof value === "string" ? value : undefined;
};

/**
 * Reconstructs the recorded foreground plan from Pi's own session entries.
 *
 * Newest wins, and only this adapter's own entry type is read: a user message,
 * an assistant message, a tool result, and every other extension's custom
 * entry are all invisible here, so a restart cannot be steered by prose. The
 * scan is bounded to the newest {@link MAX_FOREGROUND_PLAN_ENTRY_SCAN}
 * entries, so a long session costs a fixed amount of startup work.
 */
export function readForegroundPlanEntry(
  entries: readonly unknown[],
): string | undefined {
  if (!Array.isArray(entries)) return undefined;
  const start = Math.max(0, entries.length - MAX_FOREGROUND_PLAN_ENTRY_SCAN);
  for (let index = entries.length - 1; index >= start; index -= 1) {
    const entry = entries[index];
    if (customTypeOf(entry) !== FOREGROUND_PLAN_ENTRY_TYPE) continue;
    const data = (entry as Record<string, unknown>).data;
    const parsed = ForegroundPlanEntrySchema.safeParse(data);
    if (parsed.success) return parsed.data.planName;
  }
  return undefined;
}

/**
 * The session-local holder of the display identity.
 *
 * One optional string. It is never persisted by this object (the caller
 * records the session entry), never read by anything that executes, and
 * cleared outright on a new session.
 */
export interface ForegroundPlanDisplayState {
  /** The plan the rail may display, or `undefined`. */
  readonly planName: () => string | undefined;
  /**
   * Adopts a user-authorized selection. An unsafe name is refused, so a
   * malformed value can never reach the rail or the recorded entry.
   */
  readonly select: (planName: string) => boolean;
  /** Drops the identity. Idempotent. */
  readonly clear: () => void;
}

export function createForegroundPlanDisplayState(): ForegroundPlanDisplayState {
  let planName: string | undefined;
  return {
    planName: () => planName,
    select: (candidate) => {
      if (!isSafeForegroundPlanName(candidate)) return false;
      planName = candidate;
      return true;
    },
    clear: () => {
      planName = undefined;
    },
  };
}
