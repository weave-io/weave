/**
 * The single Weave-owned ordinary-delegation tool (Pi adapter contract). Targets
 * are restricted to the invoking descriptor's own normalized
 * `delegationTargets` - never re-derived, never bypassing's
 * caller-supplied-resolver/guarded-registration path. Execution returns a
 * structured result to the caller and never creates or advances workflow
 * state; direct workflow dispatch is a distinct port for a later task.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { err, ok, Result, ResultAsync } from "neverthrow";
import { Type } from "typebox";
import { formatDelegationAgentName } from "./agent-display-name.js";
import {
  CARD_AGENT_NAME_MAX,
  CARD_ASSIGNMENT_MAX,
  CARD_FACTS_SCHEMA_VERSION,
  CARD_MAX_RUN_NUMBER,
  CARD_MODEL_MAX,
  CARD_PHASE_MAX,
  CARD_ROW_HEAD_MAX,
  CARD_ROW_TEXT_MAX,
  CARD_STATUS_MAX,
  CARD_TELEMETRY_MAX,
  CARD_TERMINAL_TEXT_MAX,
  CARD_VIEWPORT_ROWS,
  type PiCardActivityKind,
  type PiCardRowKind,
  type PiCardTerminalFacts,
  type PiCardTone,
  type PiCardViewportRow,
  PiChildCardProjection,
  type PiChildCardProjectionConfig,
  type PiDelegationCardFacts,
} from "./child-card-model.js";
import type { ChildCompactRunAction } from "./child-compact-render.js";
import type { PiModelTransitionBody } from "./child-control-bodies.js";
import {
  CHILD_CARD_NATIVE_RENDER_FAILED,
  degradedPiChildCardComponent,
  renderPiChildCardComponent,
} from "./child-native-components.js";
import type { PiChildProviderError } from "./child-provider-error.js";
import type { PiChildRuntime, PiChildRuntimeError } from "./child-runtime.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
import { SystemTimerPort, type TimerPort } from "./child-timer.js";
import { MAX_FINAL_OUTPUT_BYTES, truncateFinalOutput } from "./child-tree.js";
import type {
  PiDelegationController,
  PiDelegationRequest,
  PiThreadRunOutcome,
} from "./delegation-controller.js";
import {
  makeChildAbortFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { parsePiModelFailoverRecord } from "./model-failover-record.js";
import type { PiParentSessionState } from "./primary-session.js";
import { requirePersistentParentSession } from "./primary-session.js";
import {
  type PiSessionMutationGate,
  requireSessionMutationCapability,
} from "./required-capability-gate.js";
import type { PiChildSettlement } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import type {
  IdGenerator,
  PiSessionContext,
  PiToolRegistration,
  PiToolRenderComponent,
  PiToolRenderContext,
  PiToolRenderOptions,
  PiToolResult,
  PiToolResultContent,
  PiUiThemePort,
} from "./types.js";
import { makePaint, type Paint, plainPaint } from "./ui-paint.js";
import { clipRow, emit, seg } from "./ui-rows.js";
import {
  UiUpdateCoalescer,
  type UiUpdatePriority,
} from "./ui-update-coalescer.js";

/** Stable logger code when the card cannot be drawn. */
export const CARD_RENDER_FAILED_CODE = CHILD_CARD_NATIVE_RENDER_FAILED;

/** Stable logger code when a stored details payload cannot be trusted. */
export const CARD_DETAILS_INVALID_CODE = "DelegationCardDetailsInvalid";

export const WEAVE_DELEGATION_TOOL_NAME = "weave_delegate";
// The raw `task` tool argument validation (Pi adapter contract) lives in
// `delegation-limits.js` - a dependency-free leaf module shared with
// `child-control-bodies.ts`, `delegation-controller.ts`, and `rpc-child.ts`
// - so every layer enforces the exact same limit without this tool module
// becoming (or being reachable from) a schema-layer dependency.

/**
 * The documented ceiling of one normalized agent name carried by the tool
 * schema. Names are adapter-normalized identifiers, never paths or prose.
 */
const MAX_AGENT_NAME_LENGTH = 256;

/** The root tool's `agent` description. Points at the caller's own prompt. */
const ROOT_AGENT_PARAMETER_DESCRIPTION =
  "Exact normalized subagent name, taken from the eligible delegation targets listed in this agent's own prompt. Required to start a new thread; omitted when retrying or continuing one.";

/** The relayed child tool's `agent` description. The parent stays authoritative. */
const RELAYED_AGENT_PARAMETER_DESCRIPTION =
  "Exact normalized subagent name, taken from the eligible delegation targets listed in this agent's own prompt. The authenticated parent validates eligibility.";

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_delegate`
 * (Pi adapter contract) - built from the actual `typebox` package Pi itself
 * validates tool arguments against. `task` is a non-empty string, never a bare
 * unconstrained JSON-schema object literal.
 *
 * `agent` is one bounded plain string, never a union of the target names known
 * when the tool was registered. Three reasons:
 *
 * - **Authority.** The schema grants none. Eligibility is decided at execution
 *   time against the live invocation context (root) or by the authenticated
 *   parent (relay). A name-shaped union in the schema only ever duplicated that
 *   decision in a place that could go stale.
 * - **Stability.** Pi requires parameters at registration time, so a
 *   name-derived schema pinned the callable set to the registration-time
 *   catalog: a later authorized target-set change would need tool
 *   re-registration to become reachable. A constant schema removes that
 *   obstacle without making anything callable earlier - the runtime context
 *   still has to change first.
 * - **Provider compatibility.** A bounded `Type.String` keeps the schema free of
 *   `anyOf`/`const`-shaped unions that some providers (e.g. Google) reject, the
 *   original reason the enum went through `@earendil-works/pi-ai`'s
 *   `StringEnum` helper, and it stays byte-identical for a whole generation so
 *   tool/prompt caching never observes a mid-session schema change.
 *
 * The eligible target list the model should choose from is rendered in that
 * agent's own composed prompt (`delegation.targets`), which the description
 * points at.
 */
function buildDelegationParameters(agentDescription: string) {
  return Type.Object({
    agent: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_AGENT_NAME_LENGTH,
        description: agentDescription,
      }),
    ),
    task: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The task description. Required to start a new thread and to continue a completed one.",
      }),
    ),
    action: Type.Optional(
      StringEnum(["retry", "continue"], {
        description:
          "Omit to start a new thread. `retry` reruns a failed or cancelled thread; `continue` gives a completed thread more work.",
      }),
    ),
    thread: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: MAX_THREAD_ID_LENGTH,
        description:
          "Opaque thread id returned by an earlier delegation. Required with `action`.",
      }),
    ),
    instruction: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Optional extra guidance for a `retry`. Never used by `start` or `continue`.",
      }),
    ),
  });
}

/** Opaque thread ids are adapter-minted identifiers, never paths. */
const MAX_THREAD_ID_LENGTH = 256;

export interface PiDelegationInvocationContext {
  readonly parentAgentName: string;
  readonly targets: readonly DelegationTarget[];
}

export interface PiDelegationToolDeps {
  /**
   * Advisory registration-time target data. It shapes no schema and grants no
   * authority: `buildDelegationToolRegistrations` (extension-impl) uses it only
   * for the registration-time decision of whether to register the tool at all,
   * and `readInvocationContext` falls back to it for call sites that supply no
   * `getInvocationContext`. Runtime eligibility always comes from
   * `getInvocationContext` when supplied.
   */
  readonly targets: readonly DelegationTarget[];
  /** Reads the active primary identity and its current target set at execution time. */
  readonly getInvocationContext?: () =>
    | PiDelegationInvocationContext
    | undefined;
  /**
   * Lazily reads the live delegation controller. `undefined` until the
   * generation that built this tool has finished its own real activation -
   * `execute()` never runs before that point in practice (it only fires
   * from a later turn), but must still fail closed rather than throw if it
   * somehow did.
   */
  readonly getController: () => PiDelegationController | undefined;
  /**
   * Refreshes the generation's published catalog before this call resolves a
   * target, a descriptor, or a bootstrap, so a config edit made since the last
   * dispatch reaches the next child.
   *
   * Total by contract and by construction: the wired coordinator never fails,
   * and this tool additionally swallows a hook that breaks that contract. A
   * refresh can never refuse a delegation, so a stale-but-valid catalog always
   * serves.
   */
  readonly ensureFresh?: () => Promise<void>;
  readonly parentId: string;
  readonly parentDepth: number;
  /** The invoking primary's own agent name - limits are the parent's own budget, never the target's (Pi adapter contract). */
  readonly parentAgentName: string;
  /** Generates each delegated child's id up front (Pi adapter contract), so it can be embedded as the bootstrap's own `correlationId` before `controller.delegate()` assigns one internally. */
  readonly idGenerator: IdGenerator;
  /**
   * Builds the bootstrap payload, given the pre-generated `childId` and the
   * live session `ctx` - the only place a root-level delegation has access
   * to `ctx.modelRegistry` for a concrete parent-resolved model identity
   * (Pi adapter contract).
   */
  readonly buildBootstrap: (
    target: DelegationTarget,
    task: string,
    childId: string,
    ctx: PiSessionContext,
    parentAgentName: string,
  ) => JsonValue;
  readonly buildEnv: () => Record<string, string>;
  /**
   * Reads the host-probed parent session state. Required so every registration
   * runs the persistent-parent guard before any child process, native child
   * session file, execution lease, or parent ref exists. Non-persistent and
   * unproven (`unknown`) parents fail closed.
   */
  readonly getParentSessionState: () => PiParentSessionState;
  /**
   * Names the model and reasoning level the target agent will run with, so the
   * tool call can show them before the child exists.
   */
  readonly resolveAgentRuntime?: (agentName: string) => {
    readonly model?: string;
    readonly reasoningLevel?: string;
  };
  /**
   * Reports a stable compact-render failure code. Never receives paths,
   * exception text, or child content. Wired from `extension.ts` to the
   * adapter logger.
   */
  readonly onCompactRenderFailure?: (code: string) => void;
  /**
   * The required-capability gate for persistent session mutation. Omitted
   * only by call sites that predate the gate; a missing gate fails closed.
   */
  readonly sessionMutationGate?: PiSessionMutationGate;
  /**
   * The timer the card's update coalescer schedules on. Omitted call sites
   * fall back to the live controller's own injected port, so the adapter keeps
   * exactly one timer discipline and never calls `setTimeout` here.
   */
  readonly timerPort?: TimerPort;
}

/** Payload version of {@link PiDelegationCardDetails}. Bumped on any shape change. */
export const DELEGATION_CARD_DETAILS_VERSION = 2;

/**
 * The documented serialized ceiling of one details payload.
 *
 * Pi persists `details` with the entry, replays it in a later session, and
 * hands it back to `renderResult` unchanged, so the payload is a stored public
 * surface rather than a transient render argument. Every published update is
 * measured against this ceiling first, and an over-budget payload sheds facts
 * in a fixed order rather than growing.
 */
export const MAX_DELEGATION_CARD_DETAILS_BYTES = 8 * 1_024;

/**
 * The strict, versioned card payload carried on tool-result details.
 *
 * It carries only the already-sanitized and bounded fact model — no snapshot,
 * no rendered chrome, no location, and nothing the card does not print.
 */
export interface PiDelegationCardDetails {
  readonly kind: "weave-delegation-card";
  readonly version: typeof DELEGATION_CARD_DETAILS_VERSION;
  readonly facts: PiDelegationCardFacts;
}

/**
 * Why a stored payload was refused. Parsing is total: a payload from another
 * extension, from an older adapter, from a truncated write, or one larger than
 * the ceiling becomes one of these reasons and the caller degrades.
 */
export type PiDelegationCardDetailsError = {
  readonly type: "PiDelegationCardDetailsInvalid";
  readonly reason: "absent" | "foreign" | "malformed" | "oversized";
};

/** Formats normalized names for transcript display without changing tool identity. */
export { formatDelegationAgentName } from "./agent-display-name.js";

function toolResult(
  text: PiToolResultContent["text"],
  details?: PiDelegationCardDetails,
): PiToolResult {
  return { content: [{ type: "text", text }], details };
}

// ---------------------------------------------------------------------------
// The details payload
// ---------------------------------------------------------------------------

const CARD_TONES: ReadonlySet<string> = new Set<PiCardTone>([
  "run",
  "ok",
  "warn",
  "bad",
  "mute",
]);

const CARD_ACTIVITY_KINDS: ReadonlySet<string> = new Set<PiCardActivityKind>([
  "sent",
  "boot",
  "think",
  "tool",
  "queue",
  "say",
  "reply",
  "error",
  "cancel",
  "fallback",
]);

const CARD_ROW_KINDS: ReadonlySet<string> = new Set<PiCardRowKind>([
  "boot",
  "msg",
  "think",
  "tool",
  "result",
  "queue",
  "retry",
  "error",
  "settled",
]);

const CARD_RUN_ACTIONS: ReadonlySet<string> = new Set<ChildCompactRunAction>([
  "start",
  "retry",
  "continue",
]);

const CARD_OUTCOMES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

function isDetailsRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  // Array.isArray can throw for a revoked proxy. A persisted details payload
  // must fail closed, not escape the strict parser.
  return Result.fromThrowable(
    () => !Array.isArray(value),
    () => false,
  )().unwrapOr(false);
}

/** Accepts a string only when it is inside its documented code-point bound. */
function boundedDetailsText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return Array.from(value).length <= max ? value : undefined;
}

function boundedIdentityText(value: unknown, max: number): string | undefined {
  const text = boundedDetailsText(value, max);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
}

function boundedDetailsCount(value: unknown, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}

function parseCardViewportRow(value: unknown): PiCardViewportRow | undefined {
  if (!isDetailsRecord(value)) return undefined;
  if (typeof value.kind !== "string" || !CARD_ROW_KINDS.has(value.kind))
    return undefined;
  const head = boundedDetailsText(value.head, CARD_ROW_HEAD_MAX);
  const text = boundedDetailsText(value.text, CARD_ROW_TEXT_MAX);
  if (head === undefined || text === undefined) return undefined;
  return { kind: value.kind as PiCardRowKind, head, text };
}

/**
 * Reads a persisted object through own enumerable data descriptors only.
 * Applied identity is a trust boundary: inherited values, accessors, symbols,
 * extra fields, and proxy traps must never become card facts.
 */
function strictCardRecord(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (!isDetailsRecord(value)) return undefined;
  const prototype = Result.fromThrowable(
    () => Object.getPrototypeOf(value),
    () => "unreadable" as const,
  )();
  if (
    prototype.isErr() ||
    (prototype.value !== Object.prototype && prototype.value !== null)
  )
    return undefined;
  const keys = Result.fromThrowable(
    () => Reflect.ownKeys(value),
    () => "unreadable" as const,
  )();
  if (keys.isErr()) return undefined;
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys.value) {
    if (typeof key !== "string" || !allowed.includes(key)) return undefined;
    const descriptor = Result.fromThrowable(
      () => Object.getOwnPropertyDescriptor(value, key),
      () => "unreadable" as const,
    )();
    if (descriptor.isErr() || descriptor.value === undefined) return undefined;
    if (!("value" in descriptor.value) || descriptor.value.enumerable !== true)
      return undefined;
    Object.defineProperty(copy, key, {
      value: descriptor.value.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/** Parses the applied identity as one strict, bounded atom. */
function parseCardAppliedIdentity(
  value: unknown,
): PiDelegationCardFacts["appliedIdentity"] | undefined {
  const record = strictCardRecord(value, ["provider", "id", "name"]);
  if (record === undefined) return undefined;
  const provider = boundedIdentityText(record.provider, CARD_MODEL_MAX);
  const id = boundedIdentityText(record.id, CARD_MODEL_MAX);
  if (provider === undefined || id === undefined) return undefined;
  const hasName = Object.hasOwn(record, "name");
  if (!hasName) return { provider, id };
  const name = boundedIdentityText(record.name, CARD_MODEL_MAX);
  return name === undefined ? undefined : { provider, id, name };
}

function parseCardTerminal(value: unknown): PiCardTerminalFacts | undefined {
  if (!isDetailsRecord(value)) return undefined;
  if (typeof value.outcome !== "string" || !CARD_OUTCOMES.has(value.outcome))
    return undefined;
  const verdict = boundedDetailsText(value.verdict, CARD_STATUS_MAX);
  const glyph = boundedDetailsText(value.glyph, CARD_STATUS_MAX);
  const headline = boundedDetailsText(value.headline, CARD_TERMINAL_TEXT_MAX);
  const evidence = boundedDetailsText(value.evidence, CARD_TERMINAL_TEXT_MAX);
  if (
    verdict === undefined ||
    glyph === undefined ||
    headline === undefined ||
    evidence === undefined
  )
    return undefined;
  if (value.recovery === undefined) {
    return {
      outcome: value.outcome as PiCardTerminalFacts["outcome"],
      verdict,
      glyph,
      headline,
      evidence,
    };
  }
  const recovery = boundedDetailsText(value.recovery, CARD_TERMINAL_TEXT_MAX);
  if (recovery === undefined) return undefined;
  return {
    outcome: value.outcome as PiCardTerminalFacts["outcome"],
    verdict,
    glyph,
    headline,
    evidence,
    recovery,
  };
}

/**
 * Rebuilds the fact model field by field, so a payload that reaches the
 * renderer is one this adapter itself could have produced. Anything unknown,
 * mistyped, or over its bound refuses the whole payload rather than being
 * repaired into a plausible-looking card.
 */
function parseCardFacts(value: unknown): PiDelegationCardFacts | undefined {
  if (!isDetailsRecord(value)) return undefined;
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== CARD_FACTS_SCHEMA_VERSION)
    return undefined;
  const tool = boundedDetailsText(value.tool, CARD_AGENT_NAME_MAX);
  const agentName = boundedDetailsText(value.agentName, CARD_AGENT_NAME_MAX);
  const status = boundedDetailsText(value.status, CARD_STATUS_MAX);
  const assignment = boundedDetailsText(value.assignment, CARD_ASSIGNMENT_MAX);
  if (
    tool === undefined ||
    agentName === undefined ||
    status === undefined ||
    assignment === undefined
  )
    return undefined;
  if (typeof value.tone !== "string" || !CARD_TONES.has(value.tone))
    return undefined;
  if (typeof value.settled !== "boolean") return undefined;

  // Schema 1 called configured intent `model`. Keep that legacy fact only as
  // a deprecated field; never promote it into applied identity. Current
  // projections omit it and use the authenticated atom below instead.
  const model =
    value.model === undefined
      ? undefined
      : boundedDetailsText(value.model, CARD_MODEL_MAX);
  if (value.model !== undefined && model === undefined) return undefined;

  let appliedIdentity: PiDelegationCardFacts["appliedIdentity"];
  if (value.appliedIdentity !== undefined) {
    appliedIdentity = parseCardAppliedIdentity(value.appliedIdentity);
    if (appliedIdentity === undefined) return undefined;
  }
  let fallback: PiDelegationCardFacts["fallback"];
  if (value.fallback !== undefined) {
    const parsedFallback = parsePiModelFailoverRecord(value.fallback);
    if (parsedFallback.isErr()) return undefined;
    fallback = parsedFallback.value;
  }

  const run = value.run;
  if (!isDetailsRecord(run)) return undefined;
  const runNumber = boundedDetailsCount(run.number, CARD_MAX_RUN_NUMBER);
  const phase = boundedDetailsText(run.phase, CARD_PHASE_MAX);
  const attempt =
    run.attempt === undefined
      ? undefined
      : boundedDetailsCount(run.attempt, CARD_MAX_RUN_NUMBER);
  if (
    runNumber === undefined ||
    phase === undefined ||
    (run.attempt !== undefined && attempt === undefined) ||
    typeof run.action !== "string" ||
    !CARD_RUN_ACTIONS.has(run.action)
  )
    return undefined;

  const activity = value.activity;
  if (!isDetailsRecord(activity)) return undefined;
  const activityText = boundedDetailsText(activity.text, CARD_ROW_TEXT_MAX);
  if (
    activityText === undefined ||
    typeof activity.kind !== "string" ||
    !CARD_ACTIVITY_KINDS.has(activity.kind) ||
    typeof activity.live !== "boolean"
  )
    return undefined;

  const telemetry = value.telemetry;
  if (!isDetailsRecord(telemetry)) return undefined;
  const figures: Record<string, string> = {};
  for (const key of ["elapsed", "tokens", "cost"] as const) {
    const raw = telemetry[key];
    if (raw === undefined) continue;
    const figure = boundedDetailsText(raw, CARD_TELEMETRY_MAX);
    if (figure === undefined) return undefined;
    figures[key] = figure;
  }

  const viewport = value.viewport;
  if (!isDetailsRecord(viewport)) return undefined;
  if (!Array.isArray(viewport.rows)) return undefined;
  if (viewport.rows.length > CARD_VIEWPORT_ROWS) return undefined;
  const rows: PiCardViewportRow[] = [];
  for (const row of viewport.rows) {
    const parsed = parseCardViewportRow(row);
    if (parsed === undefined) return undefined;
    rows.push(parsed);
  }
  const above = boundedDetailsCount(viewport.above, Number.MAX_SAFE_INTEGER);
  if (above === undefined || typeof viewport.atBottom !== "boolean")
    return undefined;

  let terminal: PiCardTerminalFacts | undefined;
  if (value.terminal !== undefined) {
    terminal = parseCardTerminal(value.terminal);
    if (terminal === undefined) return undefined;
  }

  return {
    schemaVersion: CARD_FACTS_SCHEMA_VERSION,
    tool,
    agentName,
    ...(model !== undefined ? { model } : {}),
    ...(appliedIdentity !== undefined ? { appliedIdentity } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    run: {
      number: runNumber,
      action: run.action as ChildCompactRunAction,
      phase,
      ...(attempt !== undefined ? { attempt } : {}),
    },
    status,
    tone: value.tone as PiCardTone,
    settled: value.settled,
    assignment,
    activity: {
      kind: activity.kind as PiCardActivityKind,
      text: activityText,
      live: activity.live,
    },
    telemetry: figures,
    viewport: { rows, above, atBottom: viewport.atBottom },
    ...(terminal !== undefined ? { terminal } : {}),
  };
}

/** The serialized size of a payload, or `undefined` when it cannot be stored. */
function serializedDetailsBytes(value: unknown): number | undefined {
  return Result.fromThrowable(
    () => JSON.stringify(value),
    () => undefined,
  )()
    .map((text) =>
      typeof text === "string"
        ? new TextEncoder().encode(text).byteLength
        : undefined,
    )
    .unwrapOr(undefined);
}

/**
 * Reads a stored details payload strictly.
 *
 * Total by construction: an absent, foreign, malformed, or over-ceiling
 * payload is a typed error, never a throw and never a half-trusted card.
 */
export function parseDelegationCardDetails(
  details: unknown,
): Result<PiDelegationCardDetails, PiDelegationCardDetailsError> {
  const invalid = (
    reason: PiDelegationCardDetailsError["reason"],
  ): Result<PiDelegationCardDetails, PiDelegationCardDetailsError> =>
    err({ type: "PiDelegationCardDetailsInvalid", reason });

  if (details === undefined || details === null) return invalid("absent");
  if (!isDetailsRecord(details)) return invalid("malformed");
  // A payload another extension (or an older adapter) wrote is foreign, not
  // broken: it degrades without ever being reported as this adapter's fault.
  if (details.kind !== "weave-delegation-card") return invalid("foreign");
  if (
    details.version !== 1 &&
    details.version !== DELEGATION_CARD_DETAILS_VERSION
  )
    return invalid("foreign");
  const bytes = serializedDetailsBytes(details);
  if (bytes === undefined) return invalid("malformed");
  if (bytes > MAX_DELEGATION_CARD_DETAILS_BYTES) return invalid("oversized");
  const facts = parseCardFacts(details.facts);
  if (facts === undefined) return invalid("malformed");
  return ok({
    kind: "weave-delegation-card",
    version: DELEGATION_CARD_DETAILS_VERSION,
    facts,
  });
}

function cardDetailsOf(facts: PiDelegationCardFacts): PiDelegationCardDetails {
  return {
    kind: "weave-delegation-card",
    version: DELEGATION_CARD_DETAILS_VERSION,
    facts,
  };
}

function fitsDetailsCeiling(details: PiDelegationCardDetails): boolean {
  const bytes = serializedDetailsBytes(details);
  return bytes !== undefined && bytes <= MAX_DELEGATION_CARD_DETAILS_BYTES;
}

/**
 * Keeps the viewport honest while shedding rows: rows are dropped from the top
 * of the window only, and every dropped row is added to `above`, so the count
 * of rows the window does not show stays exact after shedding.
 */
function withViewportRows(
  facts: PiDelegationCardFacts,
  rows: readonly PiCardViewportRow[],
): PiDelegationCardFacts {
  const dropped = Math.max(0, facts.viewport.rows.length - rows.length);
  return {
    ...facts,
    viewport: {
      rows,
      above: facts.viewport.above + dropped,
      atBottom: facts.viewport.atBottom,
    },
  };
}

/**
 * Bounds one payload to {@link MAX_DELEGATION_CARD_DETAILS_BYTES} before it is
 * published.
 *
 * The shedding order is fixed and stated here once: the viewport ring goes
 * first, one row at a time from the top; then the whole expanded viewport, so
 * a payload that cannot afford a window publishes none. Nothing else is traded
 * away — the collapsed card's own facts and the authoritative settlement record
 * (`terminal`) both survive every step, because a persisted payload that
 * dropped its settlement would replay a completed run as an unfinished one. A
 * payload that still does not fit with zero rows is not published at all, and
 * the entry degrades to the honest fallback card rather than to a silently
 * truncated or silently unsettled one.
 */
export function boundDelegationCardDetails(
  facts: PiDelegationCardFacts,
): PiDelegationCardDetails | undefined {
  const full = cardDetailsOf(facts);
  if (fitsDetailsCeiling(full)) return full;

  for (let keep = facts.viewport.rows.length - 1; keep > 0; keep -= 1) {
    const trimmed = cardDetailsOf(
      withViewportRows(facts, facts.viewport.rows.slice(-keep)),
    );
    if (fitsDetailsCeiling(trimmed)) return trimmed;
  }

  const withoutViewport = cardDetailsOf(withViewportRows(facts, []));
  return fitsDetailsCeiling(withoutViewport) ? withoutViewport : undefined;
}

// ---------------------------------------------------------------------------
// The live stream: projection → coalescer → onUpdate
// ---------------------------------------------------------------------------

/**
 * The shortest interval between two ordinary repaints of one card.
 *
 * A streaming child produces text deltas far faster than a terminal can
 * usefully redraw, so ordinary frames are coalesced into at most one publish
 * per interval. Nothing is dropped from the card itself — a coalesced frame is
 * a repaint the reader never needed, not a fact the card forgot.
 */
export const CARD_REFRESH_INTERVAL_MS = 100;

/**
 * Which frames may wait for the refresh window and which may not.
 *
 * The card and the child overlay share one definition; see
 * `UiUpdatePriority` in `ui-update-coalescer.ts`.
 */
export type PiCardUpdatePriority = UiUpdatePriority;

/**
 * Publishes at most one ordinary card update per {@link CARD_REFRESH_INTERVAL_MS}.
 *
 * The publishing rhythm itself lives in the shared `UiUpdateCoalescer`
 * leaf, which the child overlay's live stream uses as well; this subclass only
 * pins the card's default refresh window so every card path keeps exactly one
 * documented interval.
 */
export class PiCardUpdateCoalescer extends UiUpdateCoalescer {
  constructor(
    publish: () => void,
    timer: TimerPort,
    intervalMs: number = CARD_REFRESH_INTERVAL_MS,
  ) {
    super(
      publish,
      timer,
      Number.isFinite(intervalMs) ? intervalMs : CARD_REFRESH_INTERVAL_MS,
    );
  }
}

/**
 * The one production timer every card path shares when nothing was injected.
 * Constructing it schedules nothing; only `schedule()` ever reaches the host.
 */
const SHARED_CARD_TIMER_PORT: TimerPort = new SystemTimerPort();

/**
 * The port the card's coalescer schedules repaints on.
 *
 * An injected port always wins, then the live controller's own injected port,
 * so a test drives repaints deterministically. A controller that exposes none
 * (an older build, or a caller-supplied double) still yields a usable port
 * rather than leaving the card unable to publish at all.
 */
function resolveCardTimerPort(
  deps: { readonly timerPort?: TimerPort },
  controller?: PiDelegationController,
): TimerPort {
  if (deps.timerPort !== undefined) return deps.timerPort;
  const fromController = (
    controller as { readonly cardTimerPort?: TimerPort } | undefined
  )?.cardTimerPort;
  return typeof fromController?.schedule === "function"
    ? fromController
    : SHARED_CARD_TIMER_PORT;
}

/** Session events whose meaning a reader acts on the moment they arrive. */
function eventPriority(event: PiChildSessionEvent): PiCardUpdatePriority {
  return event.type === "tool_error" || event.type === "queue_change"
    ? "immediate"
    : "coalesced";
}

export interface PiDelegationCardStreamConfig
  extends PiChildCardProjectionConfig {
  readonly onUpdate?: (update: PiToolResult) => void;
  readonly timerPort: TimerPort;
  readonly refreshIntervalMs?: number;
}

/**
 * One delegation card, driven live.
 *
 * The projection owns the facts, the coalescer owns the publishing rhythm, and
 * this class owns the routing between them. The model-visible line and the
 * stored payload are produced from the SAME facts in the same call, so what the
 * model reads and what the terminal shows can never describe different runs.
 */
export class PiDelegationCardStream {
  private readonly projection: PiChildCardProjection;
  private readonly coalescer: PiCardUpdateCoalescer;
  private readonly onUpdate: ((update: PiToolResult) => void) | undefined;
  /** Applied and recovery-confirmed share one authenticated transition id. */
  private readonly modelTransitionPhases = new Map<
    string,
    PiModelTransitionBody["phase"]
  >();

  constructor(config: PiDelegationCardStreamConfig) {
    this.projection = new PiChildCardProjection(config);
    this.onUpdate = config.onUpdate;
    this.coalescer = new PiCardUpdateCoalescer(
      () => this.emit(),
      config.timerPort,
      config.refreshIntervalMs ?? CARD_REFRESH_INTERVAL_MS,
    );
  }

  /** Publishes the opening frame. Always immediate: the entry must not sit blank. */
  start(): void {
    this.coalescer.request("immediate");
  }

  /**
   * Opens a later run of the same thread. Always immediate.
   *
   * A run number that does not advance past a settled run is a late report:
   * the projection ignores it, so nothing is published either.
   */
  startRun(input: {
    readonly runNumber: number;
    readonly action: ChildCompactRunAction;
    readonly agentName?: string;
    readonly assignment?: string;
  }): void {
    const wasSettled = this.projection.isSettled();
    this.projection.startRun(input);
    this.modelTransitionPhases.clear();
    // A strictly newer run clears settlement and reopens the card; anything
    // else leaves a settled run settled and must not repaint it.
    if (wasSettled && this.projection.isSettled()) return;
    this.coalescer.request("immediate");
  }

  applyEvent(event: PiChildSessionEvent): void {
    if (this.projection.isSettled()) return;
    this.projection.applySessionEvent(event);
    this.coalescer.request(eventPriority(event));
  }

  applyProviderError(error: PiChildProviderError): void {
    if (this.projection.isSettled()) return;
    this.projection.applyProviderError(error);
    this.coalescer.request("immediate");
  }

  /** Applies one authenticated model transition as an immediate card update. */
  applyModelTransition(transition: PiModelTransitionBody): void {
    if (this.projection.isSettled()) return;
    const priorPhase = this.modelTransitionPhases.get(transition.transitionId);
    if (
      priorPhase === "recovery-confirmed" ||
      (transition.phase === "applied" && priorPhase === "applied")
    ) {
      return;
    }
    this.modelTransitionPhases.set(transition.transitionId, transition.phase);
    this.projection.applyModelTransition(transition);
    this.coalescer.request("immediate");
  }

  /**
   * Applies the ONE authoritative settlement and flushes it.
   *
   * Settlement authority covers publish cardinality, not just the record: the
   * first settlement flushes exactly one final update, and a repeated one
   * returns the same bounded details without flushing or publishing again. A
   * duplicate can therefore neither rewrite the record nor make a reader
   * redraw a run that already ended.
   */
  settle(settlement: PiChildSettlement): PiDelegationCardDetails | undefined {
    if (this.projection.isSettled()) return this.details();
    this.projection.settle(settlement);
    this.coalescer.flush();
    return this.details();
  }

  facts(): PiDelegationCardFacts {
    return this.projection.facts();
  }

  details(): PiDelegationCardDetails | undefined {
    return boundDelegationCardDetails(this.facts());
  }

  dispose(): void {
    this.coalescer.dispose();
  }

  private emit(): void {
    const facts = this.projection.facts();
    this.onUpdate?.(
      toolResult(
        modelVisibleActivity(facts),
        boundDelegationCardDetails(facts),
      ),
    );
  }
}

/**
 * The model-visible line of one update: the bounded activity sentence, never
 * card chrome. The card is for the human reading the terminal; the model reads
 * this line and, at the end, the structured result.
 */
function modelVisibleActivity(facts: PiDelegationCardFacts): string {
  return facts.activity.text.length > 0 ? facts.activity.text : "…";
}

/**
 * The tool result is a public parent boundary. Do not serialize the settlement
 * object: it also contains transport and workflow-control fields. Completed
 * children expose only their bounded terminal output and intervention count.
 */
const MAX_PUBLIC_INTERVENTION_COUNT = 1_000_000;

function normalizePublicInterventionCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PUBLIC_INTERVENTION_COUNT
    ? value
    : 0;
}

function outputProjection(value: string): {
  readonly text: string;
  readonly complete: boolean;
  readonly byteLength: number;
} {
  const byteLength = new TextEncoder().encode(value).byteLength;
  return {
    text: truncateFinalOutput(value),
    complete: byteLength <= MAX_FINAL_OUTPUT_BYTES,
    byteLength,
  };
}

function parentVisibleSettlement(
  settlement: PiChildSettlement,
): Record<string, unknown> {
  if (settlement.outcome === "completed") {
    const output = outputProjection(
      typeof settlement.assistantOutput === "string"
        ? settlement.assistantOutput
        : "",
    );
    return {
      outcome: "completed",
      ...(output.text.length > 0 ? { finalOutput: output.text } : {}),
      ...(!output.complete
        ? {
            output: {
              complete: false,
              byteLength: output.byteLength,
            },
          }
        : {}),
      interventionCount: normalizePublicInterventionCount(
        settlement.interventionCount,
      ),
    };
  }
  if (settlement.outcome === "failed") {
    return { outcome: "failed", reason: settlement.reason };
  }
  return { outcome: "cancelled" };
}

/**
 * The start-path result is a frozen public contract: `{ ok, settlement }` and
 * nothing else. A thread id is deliberately not added here, so an existing
 * start call's bytes are identical before and after the thread lifecycle
 * shipped; thread ids reach the parent through the child inspection surfaces
 * that already list them.
 */
function successResult(
  settlement: PiChildSettlement,
  card?: PiDelegationCardDetails,
  threadId?: string,
): PiToolResult {
  return toolResult(
    JSON.stringify({
      ok: true,
      settlement: parentVisibleSettlement(settlement),
      ...(threadId !== undefined &&
      settlement.outcome === "completed" &&
      typeof settlement.assistantOutput === "string" &&
      new TextEncoder().encode(settlement.assistantOutput).byteLength >
        MAX_FINAL_OUTPUT_BYTES
        ? { thread: threadId }
        : {}),
    }),
    card,
  );
}

/**
 * The public result of one thread run. It names the opaque thread, the run
 * number, the outcome, whether another run may follow, and the bounded final
 * response. It never carries a session path, a native session id, a ref, or
 * any part of the child transcript beyond the bounded terminal response.
 */
function threadResult(
  outcome: PiThreadRunOutcome,
  card?: PiDelegationCardDetails,
): PiToolResult {
  const settlement = outcome.settlement;
  const status = settlement.outcome;
  const output = outputProjection(
    status === "completed" && typeof settlement.assistantOutput === "string"
      ? settlement.assistantOutput
      : "",
  );
  return toolResult(
    JSON.stringify({
      ok: true,
      thread: outcome.threadId,
      run: outcome.run,
      status,
      // A completed run is finished work, not something to repeat; only a
      // failed or cancelled one invites another run.
      retryable: status !== "completed",
      ...(output.text.length > 0 ? { response: output.text } : {}),
      ...(!output.complete
        ? {
            output: {
              complete: false,
              byteLength: output.byteLength,
            },
          }
        : {}),
    }),
    card,
  );
}

/** Reports a refused or failed thread run without leaking any location. */
function threadFailureResult(
  threadId: string,
  failure: PiAdapterFailure,
): PiToolResult {
  const reason = failure.correlation?.reason;
  return toolResult(
    JSON.stringify({
      ok: false,
      thread: threadId,
      error: failure.code,
      message: failure.safeMessage,
      ...(typeof reason === "string" ? { reason } : {}),
      retryable: failure.retryable,
      recovery: failure.recovery,
    }),
  );
}

/**
 * Reports a failed root `start` run.
 *
 * A start's child id is also its opaque thread id, so a run that failed *after*
 * the controller registered its thread can still be retried - but only if the
 * caller is told which thread to name. Declaring `recovery: "retry"` without a
 * `thread` handle (e.g. `ChildResponseMissing`) leaves the caller with no way
 * to invoke the recovery it was just offered.
 *
 * This fails closed: the handle is advertised only when the controller itself
 * still reports a registered thread whose recorded outcome is retryable. A
 * failure raised before thread registration (capacity, authority, target) or
 * one the controller recorded as non-retryable reports no thread at all,
 * so no caller is ever handed a handle it cannot actually resume.
 */
function startFailureResult(
  controller: PiDelegationController,
  childId: string,
  failure: PiAdapterFailure,
): PiToolResult {
  const thread = controller.threadStatus(childId);
  if (thread === undefined || !thread.retryable || !failure.retryable) {
    return failureResult(failure.code, failure);
  }
  return threadFailureResult(thread.threadId, failure);
}

/**
 * Reports a failure to the calling model with enough detail to act on it.
 * `code` alone (e.g. a bare `"ChildSpawnFailed"`) tells the model nothing
 * about *why* the child never started, so the closed, bounded `reason`
 * correlation field and the human-readable `safeMessage` travel with it.
 * Both are adapter-owned safe strings - never raw host errors, paths, or
 * environment values.
 */
function failureResult(
  error: string,
  failure?: PiAdapterFailure,
): PiToolResult {
  const reason = failure?.correlation?.reason;
  const detail =
    failure === undefined
      ? undefined
      : {
          message: failure.safeMessage,
          ...(typeof reason === "string" ? { reason } : {}),
          retryable: failure.retryable,
          recovery: failure.recovery,
        };
  const text = JSON.stringify({ ok: false, error, ...(detail ?? {}) });
  return toolResult(text);
}

/**
 * Settles one card and returns its final payload.
 *
 * The settled frame always leaves through `PiDelegationCardStream.settle`,
 * which flushes rather than coalescing, so a settled run can never be published
 * as an unfinished one.
 */
function settleCardStream(
  stream: PiDelegationCardStream | undefined,
  settlement: PiChildSettlement,
  config: PiDelegationCardStreamConfig,
): PiDelegationCardDetails | undefined {
  if (stream !== undefined) {
    const details = stream.settle(settlement);
    stream.dispose();
    return details;
  }
  // Nested/relay fallback: the relay carries no live session events, so the
  // final card is built from the authoritative settlement alone.
  const fallback = new PiDelegationCardStream({
    ...config,
    onUpdate: undefined,
  });
  const details = fallback.settle(settlement);
  fallback.dispose();
  return details;
}

function parseRelaySettlement(body: JsonValue): PiChildSettlement | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (record.ok !== true) return undefined;
  const settlement = record.settlement;
  if (
    typeof settlement !== "object" ||
    settlement === null ||
    Array.isArray(settlement)
  ) {
    return undefined;
  }
  const s = settlement as Record<string, unknown>;
  if (s.outcome === "completed") {
    let assistantOutput: string | undefined;
    if (typeof s.assistantOutput === "string") {
      assistantOutput = s.assistantOutput;
    } else if (typeof s.finalOutput === "string") {
      assistantOutput = s.finalOutput;
    }
    return {
      outcome: "completed",
      ...(assistantOutput === undefined ? {} : { assistantOutput }),
    };
  }
  if (s.outcome === "failed" && typeof s.reason === "string") {
    return { outcome: "failed", reason: s.reason };
  }
  if (s.outcome === "cancelled") {
    return { outcome: "cancelled" };
  }
  return undefined;
}

/**
 * The shared `renderResult` for the root and relayed `weave_delegate` tools.
 *
 * There is exactly one card path: a nested delegation draws the same card the
 * root one does, from the same parsed facts. A payload this adapter cannot
 * vouch for — foreign, older, malformed, or larger than the ceiling — and a
 * theme that cannot paint both end at the same honest fallback card, reported
 * through the caller's own failure reporter.
 */
export function renderDelegationCardResult(
  result: PiToolResult,
  options: PiToolRenderOptions,
  theme: PiUiThemePort,
  _context: PiToolRenderContext,
  onCardRenderFailure?: (code: string) => void,
): PiToolRenderComponent {
  const parsed = parseDelegationCardDetails(result.details);
  if (parsed.isErr()) {
    onCardRenderFailure?.(CARD_DETAILS_INVALID_CODE);
    return degradedPiChildCardComponent(parsed.error.reason);
  }
  return renderPiChildCardComponent(
    parsed.value.facts,
    { expanded: options.expanded, onFailure: onCardRenderFailure },
    theme,
  ).match(
    (component) => component,
    (code) => {
      onCardRenderFailure?.(code);
      return degradedPiChildCardComponent("render_failed");
    },
  );
}

/** Code points the pre-execution call row prints before it is clipped. */
const MAX_CALL_LABEL_CODE_POINTS = 120;

/** A component that draws nothing, so exactly one card occupies the entry. */
const CARD_EMPTY_COMPONENT: PiToolRenderComponent = {
  render: () => [],
  invalidate: () => undefined,
};

function callRowPaint(theme: PiUiThemePort): Paint {
  return Result.fromThrowable(
    () => makePaint(theme),
    () => undefined,
  )().unwrapOr(plainPaint());
}

/**
 * The one muted pre-execution row: the tool that was called and who it is for.
 *
 * It exists only while Pi streams the arguments; the card replaces it the
 * moment execution starts.
 */
function delegationCallComponent(
  theme: PiUiThemePort,
  label: string,
): PiToolRenderComponent {
  const paint = callRowPaint(theme);
  const bounded = Array.from(label)
    .slice(0, MAX_CALL_LABEL_CODE_POINTS)
    .join("");
  return {
    render(width) {
      const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
      return Result.fromThrowable(
        () => [emit(clipRow([seg("muted", bounded)], w), w, paint)],
        () => "call_render_failed",
      )().unwrapOr([]);
    },
    invalidate: () => undefined,
  };
}

/**
 * The pre-execution row for one delegation call.
 *
 * `renderShell: "self"` makes this tool the sole owner of its entry, so once
 * execution has started the call renderer must yield: a row drawn beside the
 * card would print a second, stateless head above a framed one.
 */
function renderDelegationCall(
  args: Record<string, unknown>,
  theme: PiUiThemePort,
  context: PiToolRenderContext,
  resolveAgentRuntime?: (agentName: string) => {
    readonly model?: string;
    readonly reasoningLevel?: string;
  },
): PiToolRenderComponent {
  if (context.executionStarted === true) return CARD_EMPTY_COMPONENT;
  const agent = typeof args.agent === "string" ? args.agent : "delegate";
  const runtime = resolveAgentRuntime?.(agent) ?? {};
  const suffix = [runtime.model, runtime.reasoningLevel]
    .filter((part): part is string => part !== undefined && part !== "")
    .join(" ");
  const target = formatDelegationAgentName(agent);
  return delegationCallComponent(
    theme,
    `${WEAVE_DELEGATION_TOOL_NAME} · ${target}${suffix === "" ? "" : ` ${suffix}`}`,
  );
}

/**
 * Wires the root tool's own Pi-supplied `AbortSignal` to
 * `controller.cancelSubtree(childId)` (Pi adapter contract cooperative
 * cancellation) so aborting the `weave_delegate` call - app-level
 * interrupt/escape - immediately cancels the exact generated child
 * subtree rather than only after it settles on its own.
 *
 * Returns a promise that resolves *only* if the abort-triggered
 * `cancelSubtree()` itself fails - never if it succeeds. A successful
 * cancellation must never "win" any race it is placed in: the delegated
 * child's own eventual `{ outcome: "cancelled" }` settlement (observed via
 * `controller.delegate()`'s own promise) is always the result that
 * actually resolves the tool call in that case. This is what lets the
 * caller safely `Promise.race` this against `controller.delegate()`
 * without a merely-successful cancellation ever short-circuiting past the
 * settlement the child itself reports - while a *failed* cancellation
 * still resolves promptly instead of leaving the tool hanging behind a
 * child that may now never settle.
 */
function watchForCancelSubtreeFailure(
  signal: AbortSignal,
  controller: PiDelegationController,
  childId: string,
): {
  readonly failure: Promise<{ content: readonly PiToolResultContent[] }>;
  readonly unwire: () => void;
} {
  let resolveFailure:
    | ((result: { content: readonly PiToolResultContent[] }) => void)
    | undefined;
  const failure = new Promise<{
    content: readonly PiToolResultContent[];
  }>((resolve) => {
    resolveFailure = resolve;
  });
  const onAbort = (): void => {
    void controller.cancelSubtree(childId).match(
      // A successful cancellation must never resolve this promise - only
      // `controller.delegate()`'s own settlement (racing alongside this)
      // is allowed to conclude the tool call in that case.
      () => undefined,
      (failures: readonly PiAdapterFailure[]) => {
        const first =
          failures[0] ??
          makeChildAbortFailedFailure(childId, "cancel-subtree-failed");
        resolveFailure?.(failureResult(first.code, first));
      },
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  // Closes the listener-registration race: the signal may have aborted
  // between the caller's own pre-dispatch `signal.aborted` check and this
  // listener actually attaching - `addEventListener` never re-fires for an
  // abort that already happened, so this must be checked explicitly.
  if (signal.aborted) onAbort();
  return {
    failure,
    unwire: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * The three accepted call forms. Parsing is strict and closed: a call that
 * mixes a start with a thread action, omits a required field, or carries a
 * field the chosen action never uses is refused outright rather than
 * silently reinterpreted as something else.
 */
type PiDelegationCall =
  | { readonly kind: "start"; readonly agent: string; readonly task: string }
  | {
      readonly kind: "retry";
      readonly threadId: string;
      readonly instruction?: string;
    }
  | {
      readonly kind: "continue";
      readonly threadId: string;
      readonly task: string;
    };

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

function parseDelegationCall(call: unknown): PiDelegationCall | undefined {
  if (typeof call !== "object" || call === null || Array.isArray(call))
    return undefined;
  const record = call as Record<string, unknown>;
  const action = record.action;
  const thread = record.thread;
  if (action === undefined && thread === undefined) {
    const agent = record.agent;
    const task = record.task;
    if (typeof agent !== "string" || typeof task !== "string") return undefined;
    if (task.length < 1) return undefined;
    if (record.instruction !== undefined) return undefined;
    return { kind: "start", agent, task };
  }
  if (typeof thread !== "string" || thread.length < 1) return undefined;
  if (thread.length > MAX_THREAD_ID_LENGTH) return undefined;
  // A thread already fixes its own agent; naming one here would imply the
  // caller can retarget an existing thread, which it cannot.
  if (record.agent !== undefined) return undefined;
  if (action === "retry") {
    if (record.task !== undefined) return undefined;
    if (record.instruction === undefined) {
      return { kind: "retry", threadId: thread };
    }
    const instruction = boundedText(record.instruction);
    if (instruction === undefined) return undefined;
    return { kind: "retry", threadId: thread, instruction };
  }
  if (action === "continue") {
    if (record.instruction !== undefined) return undefined;
    // Continue without a task is a validation error, never a default.
    const task = boundedText(record.task);
    if (task === undefined) return undefined;
    return { kind: "continue", threadId: thread, task };
  }
  return undefined;
}

/**
 * Runs the injected boundary refresh without ever letting it fail this call.
 *
 * A hook that throws or rejects is a broken contract, not a reason to refuse a
 * delegation: the catalog simply stays where it was.
 */
async function ensureCatalogFresh(
  ensureFresh: () => Promise<void>,
): Promise<void> {
  await ResultAsync.fromPromise(
    Promise.resolve().then(() => ensureFresh()),
    () => undefined,
  ).unwrapOr(undefined);
}

/**
 * Reads the one authoritative target gate for a root delegation. When the call
 * site wires `getInvocationContext`, its answer is final - including
 * `undefined`, which fails closed. Only call sites that wire no hook fall back
 * to the advisory registration-time data, which then *is* their invocation
 * context; production always wires the hook.
 */
function readInvocationContext(
  deps: PiDelegationToolDeps,
): PiDelegationInvocationContext | undefined {
  if (deps.getInvocationContext !== undefined) {
    return deps.getInvocationContext();
  }
  return {
    parentAgentName: deps.parentAgentName,
    targets: deps.targets,
  };
}

/** Builds the one Weave-owned delegation tool with runtime-scoped primary eligibility. */
export function buildDelegationToolRegistration(
  deps: PiDelegationToolDeps,
): PiToolRegistration {
  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave subagent",
    description:
      "Delegates one task to a single eligible normalized Weave subagent name, run as a private ephemeral child, and returns its structured result. Never advances or creates workflow state.",
    parameters: buildDelegationParameters(ROOT_AGENT_PARAMETER_DESCRIPTION),
    promptGuidelines: [
      "Pass the exact normalized subagent name from this agent's eligible delegation targets, as listed in its own prompt; never use a display label, description, or alias.",
    ],
    // The card owns its own frame, so Pi's coloured tool shell must stand down.
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderDelegationCall(args, theme, context, deps.resolveAgentRuntime),
    renderResult: (result, options, theme, context) =>
      renderDelegationCardResult(
        result,
        options,
        theme,
        context,
        deps.onCompactRenderFailure,
      ),
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      // The required-capability gate runs before everything else, including
      // the persistent-parent guard: when the host cannot prove
      // descriptor-relative native session I/O, delegation must fail without
      // reading the parent session state, parsing arguments, reaching the
      // delegation controller, or creating any child, session file, cache
      // entry, execution lease, or ref.
      const capability = requireSessionMutationCapability(
        deps.sessionMutationGate,
      );
      if (capability.isErr()) {
        return failureResult(capability.error.code, capability.error);
      }
      // The persistent-parent guard runs first, before this call parses
      // arguments, reads the controller, generates a child id, or touches any
      // other state: a `--no-session` or unproven parent must never produce a
      // partially created child, session file, lease, or ref.
      const guard = requirePersistentParentSession(
        deps.getParentSessionState(),
        "delegate",
      );
      if (guard.isErr()) {
        return failureResult(guard.error.code, guard.error);
      }
      const parsed = parseDelegationCall(params);
      if (parsed === undefined) {
        return failureResult("invalid-delegation-call");
      }
      const controller = deps.getController();
      if (controller === undefined) {
        return failureResult("delegation-transport-unavailable");
      }
      // The delegation boundary: the published catalog is refreshed here,
      // before any target, descriptor, or bootstrap is resolved, and before a
      // thread run samples its own dispatch snapshot. A call site that wires
      // no hook keeps its exact prior control flow - no await is introduced.
      if (deps.ensureFresh !== undefined) {
        await ensureCatalogFresh(deps.ensureFresh);
      }
      if (parsed.kind !== "start") {
        // A thread run reuses the thread's own recorded agent, model, and
        // native session; the caller supplies only the opaque thread id and,
        // for a continue, the new task. Each tool call opens a new compact
        // block; prior Pi tool blocks stay frozen.
        const instruction =
          parsed.kind === "retry" ? parsed.instruction : parsed.task;
        const timerPort = resolveCardTimerPort(deps, controller);
        let stream: PiDelegationCardStream | undefined;
        let assignedAgent = "delegate";
        let assignedRun = 1;
        return controller
          .resumeThread({
            threadId: parsed.threadId,
            action: parsed.kind,
            ...(instruction === undefined ? {} : { instruction }),
            initiator: {
              kind: "owner",
              parentSessionId:
                guard.value.persistence === "persistent"
                  ? guard.value.sessionId
                  : "",
            },
            onRunAssigned: (assignment) => {
              assignedAgent = assignment.agentName;
              assignedRun = assignment.runNumber;
              stream = new PiDelegationCardStream({
                threadId: assignment.threadId,
                agentName: assignment.agentName,
                assignment: instruction ?? "",
                runNumber: assignment.runNumber,
                action: assignment.action,
                ...(onUpdate === undefined ? {} : { onUpdate }),
                timerPort,
              });
              stream.start();
            },
            onSessionEvent: (event: PiChildSessionEvent) => {
              stream?.applyEvent(event);
            },
          })
          .match(
            (outcome) => {
              const card = settleCardStream(stream, outcome.settlement, {
                threadId: parsed.threadId,
                agentName: assignedAgent,
                assignment: instruction ?? "",
                runNumber: outcome.run > 0 ? outcome.run : assignedRun,
                action: parsed.kind,
                timerPort,
              });
              return threadResult(outcome, card);
            },
            (failure) => threadFailureResult(parsed.threadId, failure),
          );
      }
      // The one and only target gate: the live invocation context, then an
      // exact lookup inside it. No registration-time union is consulted, so a
      // target the runtime context gained is reachable without re-registering
      // this tool, and a target it lost is unreachable from the next call on.
      const invocation = readInvocationContext(deps);
      if (invocation === undefined) {
        return failureResult("delegation-transport-unavailable");
      }
      const target = invocation.targets.find(
        (candidate) => candidate.name === parsed.agent,
      );
      if (target === undefined) {
        return failureResult("invalid-delegation-target");
      }
      const childId = deps.idGenerator.next();
      // Cooperative cancellation (Pi adapter contract): a Pi tool call aborted
      // (app interrupt/escape) before this tool ever dispatched a child has
      // no in-flight task to report a structured cancelled *settlement*
      // for - the same fail-closed rule `PiRpcChild.completeCancellation`
      // applies to a cancel arriving before its own child leaves
      // handshake/bootstrap-ack. Fabricating a successful cancelled result
      // here instead would misreport a delegation that never actually ran.
      if (signal?.aborted === true) {
        const aborted = makeChildAbortFailedFailure(
          childId,
          "aborted-before-dispatch",
        );
        return failureResult(aborted.code, aborted);
      }
      // Root start: child id is also the opaque thread id (controller provision).
      const timerPort = resolveCardTimerPort(deps, controller);
      const cardConfig: PiDelegationCardStreamConfig = {
        threadId: childId,
        agentName: parsed.agent,
        assignment: parsed.task,
        runNumber: 1,
        action: "start",
        ...(onUpdate === undefined ? {} : { onUpdate }),
        timerPort,
      };
      const stream = new PiDelegationCardStream(cardConfig);
      // The first update is published before this call awaits anything, so Pi
      // never shows an empty entry while the arguments are still streaming.
      stream.start();
      const request: PiDelegationRequest = {
        parentId: deps.parentId,
        parentDepth: deps.parentDepth,
        parentAgentName: invocation.parentAgentName,
        agentName: parsed.agent,
        task: parsed.task,
        cwd: ctx.cwd,
        env: deps.buildEnv(),
        bootstrap: deps.buildBootstrap(
          target,
          parsed.task,
          childId,
          ctx,
          invocation.parentAgentName,
        ),
        // Live card updates come only from parser-approved session events.
        // Tree-snapshot onUpdate must not overwrite event-derived card facts.
        onSessionEvent: (event: PiChildSessionEvent) => {
          stream.applyEvent(event);
        },
        childId,
      };
      const settlement = controller.delegate(request).match(
        (value) => {
          const card = settleCardStream(stream, value, cardConfig);
          return successResult(value, card, childId);
        },
        (failure) => {
          // A delegation that never settled still owns a live timer.
          stream.dispose();
          return startFailureResult(controller, childId, failure);
        },
      );
      if (signal === undefined) return settlement;
      // Wires the exact generated `childId`'s subtree to this tool call's
      // own `AbortSignal` (Pi adapter contract) so aborting the root `weave_delegate`
      // tool immediately cancels it instead of only noticing after the child
      // settles on its own. Races the delegated child's own settlement
      // against only a *failed* cancellation attempt - a successful one never
      // wins this race and this call always still awaits the child's own
      // `{ outcome: "cancelled" }` settlement, per `watchForCancelSubtreeFailure`.
      const { failure: cancelFailure, unwire } = watchForCancelSubtreeFailure(
        signal,
        controller,
        childId,
      );
      try {
        return await Promise.race([settlement, cancelFailure]);
      } finally {
        unwire();
      }
    },
  };

  return tool;
}

/**
 * The thread label a relayed card opens under. The relay reply carries no
 * thread id, and the card never prints one, so this is an adapter-owned
 * constant rather than anything a caller or a host may set.
 */
const RELAY_CARD_THREAD_LABEL = "nested";

export interface PiRelayedDelegationToolDeps {
  /**
   * This child's own bootstrap-pinned targets. They shape no schema. They are
   * runtime data, not registration-time config: the authenticated parent built
   * them from the exact catalog snapshot pinned to this child's dispatch, so
   * they cannot go stale under it. An empty list means the parent named none
   * and the parent alone decides eligibility.
   */
  readonly targets: readonly DelegationTarget[];
  /** Lazily reads this child's own private-control runtime; `undefined` before bootstrap has applied (fails closed). */
  readonly getRuntime: () => PiChildRuntime | undefined;
  /**
   * Reports a stable compact-render failure code. Same contract as the root
   * tool; never receives paths or exception text.
   */
  readonly onCompactRenderFailure?: (code: string) => void;
  /** Same fail-closed required-capability gate contract as the root tool. */
  readonly sessionMutationGate?: PiSessionMutationGate;
  /** Same injected card-refresh timer contract as the root tool. */
  readonly timerPort?: TimerPort;
}

/**
 * Builds a delegated child's own `weave_delegate` tool (Pi adapter contract,
 * nested/descendant delegation). Unlike the root's direct
 * `buildDelegationToolRegistration`, this never talks to a
 * `PiDelegationController` directly - a private child process has none of
 * its own. Instead it relays the request through this exact child's own
 * authenticated `PiChildRuntime.requestDelegation`, which the parent's
 * `PiDelegationController.handleChildDelegationRequest` authorizes under
 * this child's own identity/depth against the exact same global
 * tree/process budget as every other delegation - nested delegation is
 * never a second, independent, untracked budget.
 *
 * Live session events are unavailable across the relay control channel, so the
 * card opens on the bootstrap facts this call already knows and is completed by
 * the structured settlement. One producer owns the entry from the first update
 * to the last, exactly as at the root. The renderer, the details payload and
 * the frame are the root tool's own: nested delegation never forks a second
 * card path.
 */
export function buildRelayedDelegationToolRegistration(
  deps: PiRelayedDelegationToolDeps,
): PiToolRegistration {
  // Bootstrap-pinned defence in depth, never the authority: the parent
  // re-resolves every relayed name against the same pinned snapshot before it
  // dispatches anything. Keeping the check here refuses an impossible name
  // without spending a control round-trip.
  const pinnedTargetNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave agent",
    description:
      "Delegates one task to a single eligible Weave agent, run as a private ephemeral child of this session, and returns its structured result. Never advances or creates workflow state.",
    // Unconditionally the stable shape, exactly like the root tool: a
    // parent-side snapshot update can then never imply a child-side schema
    // mismatch, whatever targets this child's bootstrap happened to carry.
    parameters: buildDelegationParameters(RELAYED_AGENT_PARAMETER_DESCRIPTION),
    promptGuidelines: [
      deps.targets.length === 0
        ? "Pass a normalized agent name; the authenticated parent validates eligibility."
        : "Use only an `agent` name listed as an eligible delegation target for this session.",
    ],
    // Same contract as the root tool: this tool draws its own frame.
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderDelegationCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderDelegationCardResult(
        result,
        options,
        theme,
        context,
        deps.onCompactRenderFailure,
      ),
    execute: async (_toolCallId, params, _signal, onUpdate) => {
      const capability = requireSessionMutationCapability(
        deps.sessionMutationGate,
      );
      if (capability.isErr()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: capability.error.code,
              }),
            },
          ],
        };
      }
      const parsed = parseDelegationCall(params);
      // A relayed child may only start a new delegation. Thread lifecycle
      // actions belong to the owning parent session, which alone holds the
      // refs, the native sessions, and the authority to act on them.
      if (
        parsed === undefined ||
        parsed.kind !== "start" ||
        (pinnedTargetNames.size > 0 && !pinnedTargetNames.has(parsed.agent))
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "invalid-delegation-target",
              }),
            },
          ],
        };
      }
      const runtime = deps.getRuntime();
      if (runtime === undefined) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: "delegation-transport-unavailable",
              }),
            },
          ],
        };
      }
      // The relay carries no thread id back to this child, so the card is
      // opened under an adapter-owned label. It names no host state and the
      // renderer never prints it.
      const cardConfig: PiDelegationCardStreamConfig = {
        threadId: RELAY_CARD_THREAD_LABEL,
        agentName: parsed.agent,
        assignment: parsed.task,
        runNumber: 1,
        action: "start",
        ...(onUpdate === undefined ? {} : { onUpdate }),
        timerPort: resolveCardTimerPort(deps),
      };
      const stream = new PiDelegationCardStream(cardConfig);
      // The bootstrap card is published before this call awaits the relay:
      // `renderCall` draws nothing once execution starts, so an entry that
      // waited for the settlement would sit blank for the whole nested run.
      stream.start();
      const reply: ResultAsync<JsonValue, PiChildRuntimeError> =
        runtime.requestDelegation({
          agentName: parsed.agent,
          task: parsed.task,
        });
      return reply.match(
        (body) => {
          const settlement = parseRelaySettlement(body);
          // A relay reply this tool cannot read is not turned into a card that
          // claims an outcome: the entry degrades instead.
          const card =
            settlement === undefined
              ? undefined
              : settleCardStream(stream, settlement, cardConfig);
          stream.dispose();
          return {
            content: [{ type: "text", text: JSON.stringify(body) }],
            details: card,
          };
        },
        (failure) => {
          stream.dispose();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: failure.type }),
              },
            ],
          };
        },
      );
    },
  };

  return tool;
}
