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
import { err, ok, Result } from "neverthrow";
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
 * The closed grammar of the ONE clause that may move the rail.
 *
 * A message is a request to execute a plan when the clause immediately before
 * the plan path is, in full:
 *
 *     [lead-in]* <execution verb> [connector]*
 *
 * and nothing else. Every part is a closed vocabulary, and the match is
 * ANCHORED at both ends of the clause, so a verb that merely occurs somewhere
 * in the sentence proves nothing. This is the difference between
 * `run .weave/plans/alpha.md` and `before you run anything, diff
 * .weave/plans/alpha.md`: the second one's clause is `before you run anything,
 * diff`, which the grammar does not accept.
 *
 * The predecessor was a bare `\b(execute|run|start|…)\b` search anywhere in the
 * message. It accepted a review, a question, a plan mentioned in passing, and
 * a refusal, because all four can contain the word `run`.
 */
const EXECUTION_LEAD_IN =
  "(?:please|now|then|and|ok|okay|next|let'?s|lets|go\\s+ahead\\s+and|i\\s+want\\s+you\\s+to|i'?d\\s+like\\s+you\\s+to|you\\s+should)";
const EXECUTION_VERB =
  "(?:execute|run|start|implement|continue|resume|finish|complete|work\\s+through|carry\\s+out|pick\\s+up)";
const EXECUTION_CONNECTOR =
  "(?:the|this|that|our|my|its|it|plan|file|at|in|on|with|from|through|path|located|stored|working|work|executing|running)";
const EXECUTION_CLAUSE_RE = new RegExp(
  `^(?:${EXECUTION_LEAD_IN}\\s+)*${EXECUTION_VERB}(?:\\s+${EXECUTION_CONNECTOR})*\\s*$`,
  "iu",
);

/**
 * Words that make a message something other than a request, wherever they
 * appear.
 *
 * A negation can sit far from the verb (`run the tests, not
 * .weave/plans/alpha.md`), so unlike the clause grammar this is a whole-input
 * veto. It is a veto and never an acceptance: it can only ever refuse.
 */
const NEGATION_RE =
  /\b(?:no|not|never|dont|don't|doesn't|didn't|won't|wouldn't|shouldn't|cannot|can't|stop|cancel|abort|skip|avoid|without|instead|unless)\b/iu;

/** Clause boundaries. A `.` counts only when it ends a word, never inside a path. */
const CLAUSE_BOUNDARY_RE = /[\n;:,!?]|\.(?=\s)/gu;

/**
 * One contained plan path: an optional `./`, then exactly `.weave/plans/`,
 * then one safe basename, then `.md`.
 *
 * The pattern is anchored on its left by a start-of-input or a separator, so
 * `../other-worktree/.weave/plans/alpha.md` and
 * `/Users/someone/other/.weave/plans/alpha.md` do not match: a path that
 * reaches outside this project root is not parsed into the basename it happens
 * to end with. Its right lookahead refuses a further path segment, so
 * `.weave/plans/alpha.md.bak` and `.weave/plans/alpha.mdx` are not read as
 * `alpha`.
 */
const PLAN_PATH_RE =
  /(?:^|[\s"'`([])(?:\.\/)?\.weave\/plans\/([A-Za-z0-9_-]+)\.md(?=$|[\s"'`)\],;:!?]|\.(?=\s|$))/gu;

/**
 * Anything that LOOKS like a plans path, in any spelling.
 *
 * Deliberately wider than {@link PLAN_PATH_RE}: it matches the separator with
 * or without the leading dot and in either slash direction, and case
 * -insensitively. Every mention it finds must be accounted for by an accepted
 * path, so a traversal, an absolute path, a nested subdirectory, a Windows
 * spelling or an unsafe basename REJECTS THE WHOLE MESSAGE — including when a
 * perfectly good path sits beside it. A message that names one thing this
 * parser will not touch is a message whose intent it cannot state.
 */
const PLAN_PATH_MENTION_RE = /\.?weave[\\/]+plans[\\/]+/giu;

/**
 * Parses one direct user message into the single plan it explicitly asks to
 * execute.
 *
 * Fail-closed at every step: over the length bound, no plan path, ANY
 * plan-path-like mention this parser will not accept, more than one distinct
 * plan, a negation, an interrogative, or a clause that is not an execution
 * request all return a typed rejection and change nothing.
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

  const mentions = countMatches(text, PLAN_PATH_MENTION_RE);
  const matches = collectPlanPathMatches(text);
  // Every plan-ish mention must be one this parser accepted. One it did not is
  // not "prose that named nothing": it is a path whose meaning it refuses to
  // guess, and it disqualifies the message rather than the path.
  if (matches.length !== mentions) {
    return err(mentions === 0 ? "no-plan-path" : "unsafe-plan-path");
  }
  const first = matches[0];
  if (first === undefined) return err("no-plan-path");
  if (matches.some((match) => match.name !== first.name)) {
    return err("multiple-plans");
  }
  if (!isSafeForegroundPlanName(first.name)) return err("unsafe-plan-path");

  if (!isExecutionRequest(text, first.index)) {
    return err("no-execution-intent");
  }
  return ok(first.name);
}

/**
 * True when the message asks, positively and unambiguously, for the plan at
 * `pathIndex` to be executed.
 */
function isExecutionRequest(text: string, pathIndex: number): boolean {
  // A question is not an instruction, however many execution verbs it holds.
  if (text.includes("?")) return false;
  if (NEGATION_RE.test(text)) return false;
  return EXECUTION_CLAUSE_RE.test(clauseBefore(text, pathIndex));
}

/** The clause the plan path belongs to: the text after the last boundary. */
function clauseBefore(text: string, pathIndex: number): string {
  const head = text.slice(0, pathIndex);
  const boundaries = new RegExp(
    CLAUSE_BOUNDARY_RE.source,
    CLAUSE_BOUNDARY_RE.flags,
  );
  let start = 0;
  let match = boundaries.exec(head);
  while (match !== null) {
    start = match.index + match[0].length;
    match = boundaries.exec(head);
  }
  return (
    head
      .slice(start)
      .replace(/\s+/gu, " ")
      // The opening quote or bracket a path may be wrapped in belongs to the
      // path, not to the clause: `run \`` is still `run`.
      .replace(/[\s"'`([]+$/u, "")
      .trim()
  );
}

/** Every accepted plan path, with the offset its clause ends at. */
function collectPlanPathMatches(
  text: string,
): readonly { readonly name: string; readonly index: number }[] {
  // A fresh regex per call: a shared /g literal carries `lastIndex` between
  // calls and would skip the first match of every second message.
  const pattern = new RegExp(PLAN_PATH_RE.source, PLAN_PATH_RE.flags);
  const found: { name: string; index: number }[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1];
    // The match consumes one leading separator; the clause ends where the path
    // itself begins.
    if (name !== undefined) {
      found.push({
        name,
        index: match.index + (match[0].length - matchedPathLength(match[0])),
      });
    }
    match = pattern.exec(text);
  }
  return found;
}

/** Length of the path itself inside a match that may carry a separator. */
function matchedPathLength(matched: string): number {
  const start = matched.indexOf(".weave/plans/");
  const dotSlash = matched.indexOf("./.weave/plans/");
  const from = dotSlash === -1 ? start : dotSlash;
  return from === -1 ? matched.length : matched.length - from;
}

function countMatches(text: string, pattern: RegExp): number {
  const scoped = new RegExp(pattern.source, pattern.flags);
  let count = 0;
  while (scoped.exec(text) !== null) count += 1;
  return count;
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

/**
 * The FULL envelope one recorded selection must present.
 *
 * `type` is checked, not just `customType`, and that is the whole point: Pi's
 * `CustomEntry` is `{ type: "custom", customType, data }`, while a user
 * message, an assistant message, a tool result and a `custom_message` are
 * different entry types that can carry any fields a model chose to write. An
 * envelope that only had to say `customType` could therefore be FORGED by
 * ordinary conversation content, and a restart would replay it as the user's
 * own selection.
 */
const ForegroundPlanSessionEntrySchema = z
  .object({
    type: z.literal("custom"),
    customType: z.literal(FOREGROUND_PLAN_ENTRY_TYPE),
    data: ForegroundPlanEntrySchema,
  })
  .strict();

/**
 * Ceiling on the fields one recorded payload may carry.
 *
 * The contract names two. A payload with more is not a payload with extra
 * information, it is not this module's payload, and the copy stops rather than
 * walking whatever the session happens to hold.
 */
const MAX_FOREGROUND_PLAN_ENTRY_FIELDS = 8;

/** `Object.getOwnPropertyDescriptor` as a value: a proxy trap can throw. */
const ownDescriptor = Result.fromThrowable(
  (target: object, key: string): PropertyDescriptor | undefined =>
    Object.getOwnPropertyDescriptor(target, key),
  () => undefined,
);

/**
 * The value of an own, enumerable DATA property, or `undefined`.
 *
 * An accessor is never invoked: reading it would run session content's own
 * code during startup. An inherited or non-enumerable property is not the
 * entry's own statement either, so a prototype-polluted payload states
 * nothing.
 */
function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null) return undefined;
  const descriptor = ownDescriptor(target, key);
  if (descriptor.isErr()) return undefined;
  const found = descriptor.value;
  if (found === undefined || !("value" in found)) return undefined;
  return found.enumerable === true ? found.value : undefined;
}

/**
 * Rebuilds one entry as a plain object of exactly the fields this module
 * validates, read descriptor-safely.
 *
 * Validation then runs over inert data rather than over a host object: no
 * getter runs, no proxy trap fires inside the schema, and no field the schema
 * does not name survives the copy.
 */
function materializeEntry(entry: unknown): unknown {
  if (!isPlainObject(entry)) return undefined;
  return {
    type: ownValue(entry, "type"),
    customType: ownValue(entry, "customType"),
    data: materializePayload(ownValue(entry, "data")),
  };
  // The entry's own `id`, `parentId` and `timestamp` are Pi's, not this
  // contract's, so they are simply not copied. Everything this module
  // validates is copied faithfully, extra fields included, so the strict
  // payload schema still refuses a payload that says more than it should.
}

/** Faithful bounded copy of the recorded payload, extra fields included. */
function materializePayload(data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const keys = Result.fromThrowable(
    () => Object.keys(data),
    () => undefined,
  )().match(
    (value) => value,
    () => undefined,
  );
  if (keys === undefined || keys.length > MAX_FOREGROUND_PLAN_ENTRY_FIELDS) {
    return undefined;
  }
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    // `__proto__` and friends are never copied by assignment: they would
    // mutate the copy's own authority rather than describe the payload.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    copy[key] = ownValue(data, key);
  }
  return copy;
}

/** A non-array object, decided without letting a revoked proxy throw. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  return Result.fromThrowable(
    () => !Array.isArray(value),
    () => false,
  )().match(
    (plain) => plain,
    () => false,
  );
}

/**
 * Reconstructs the recorded foreground plan from Pi's own session entries.
 *
 * Newest wins, and only this adapter's own `custom` entry type is read: a user
 * message, an assistant message, a tool result, a `custom_message`, and every
 * other extension's custom entry are all invisible here, so a restart cannot
 * be steered by prose — not even by prose that names the fields. The scan is
 * bounded to the newest {@link MAX_FOREGROUND_PLAN_ENTRY_SCAN} entries, so a
 * long session costs a fixed amount of startup work.
 *
 * A successful read is still not authority to display: the caller must prove
 * the name is in THIS project root's plan catalog before adopting it.
 */
export function readForegroundPlanEntry(
  entries: readonly unknown[],
): string | undefined {
  const list = Result.fromThrowable(
    () => (Array.isArray(entries) ? entries : []),
    () => [] as readonly unknown[],
  )().match(
    (value) => value,
    () => [] as readonly unknown[],
  );
  const start = Math.max(0, list.length - MAX_FOREGROUND_PLAN_ENTRY_SCAN);
  for (let index = list.length - 1; index >= start; index -= 1) {
    const parsed = ForegroundPlanSessionEntrySchema.safeParse(
      materializeEntry(ownValue(list, String(index))),
    );
    if (parsed.success) return parsed.data.data.planName;
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
