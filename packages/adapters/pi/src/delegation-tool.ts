/**
 * The single Weave-owned ordinary-delegation tool (Pi adapter contract). Targets
 * are restricted to the invoking descriptor's own normalized
 * `delegationTargets` - never re-derived, never bypassing's
 * caller-supplied-resolver/guarded-registration path. Execution returns a
 * structured result to the caller and never creates or advances workflow
 * state; direct workflow dispatch is a distinct port for a later task.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { Result, type ResultAsync } from "neverthrow";
import { Type } from "typebox";
import {
  type ChildCompactRenderOutput,
  degradedChildCompactRender,
  PiChildCompactProjection,
} from "./child-compact-render.js";
import {
  CHILD_COMPACT_NATIVE_RENDER_FAILED,
  renderPiChildCompactComponent,
} from "./child-native-components.js";
import type { PiChildRuntime, PiChildRuntimeError } from "./child-runtime.js";
import type { PiChildSessionEvent } from "./child-session-events.js";
import {
  MAX_FINAL_OUTPUT_BYTES,
  truncateFinalOutput,
} from "./child-tree.js";
import type {
  PiDelegationController,
  PiDelegationRequest,
  PiThreadRunOutcome,
} from "./delegation-controller.js";
import {
  makeChildAbortFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
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

/** Stable logger code when compact native theming fails. */
export const COMPACT_RENDER_FAILED_CODE = CHILD_COMPACT_NATIVE_RENDER_FAILED;

export const WEAVE_DELEGATION_TOOL_NAME = "weave_delegate";
// The raw `task` tool argument validation (Pi adapter contract) lives in
// `delegation-limits.js` - a dependency-free leaf module shared with
// `child-control-bodies.ts`, `delegation-controller.ts`, and `rpc-child.ts`
// - so every layer enforces the exact same limit without this tool module
// becoming (or being reachable from) a schema-layer dependency.

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_delegate`
 * (Pi adapter contract) - built from the actual `typebox` package Pi itself
 * validates tool arguments against, using `@earendil-works/pi-ai`'s
 * `StringEnum` helper so the `agent` enum stays compatible with providers
 * (e.g. Google) that reject `anyOf`/`const`-shaped unions. `task` is a
 * non-empty string, never a bare unconstrained JSON-schema object literal.
 */
function buildDelegationParameters(
  allowedNames: ReadonlySet<string>,
  acceptParentAuthorizedName = false,
) {
  return Type.Object({
    agent: Type.Optional(
      acceptParentAuthorizedName
        ? Type.String({
            minLength: 1,
            maxLength: 256,
            description:
              "Normalized subagent name. The authenticated parent validates eligibility.",
          })
        : StringEnum(Array.from(allowedNames), {
            description:
              "Exact normalized subagent name from this agent's eligible delegation targets. Required to start a new thread; omitted when retrying or continuing one.",
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
  /** Union used by Pi's static tool schema. Runtime eligibility comes from `getInvocationContext` when supplied. */
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
}

/**
 * Strict §6 compact projection payload carried on tool-result details.
 * Prefer this over the legacy snapshot details shape.
 */
export interface PiDelegationCompactDetails {
  readonly kind: "weave-delegation-compact";
  readonly lines: readonly [string, string, string];
  readonly expandedCurrentItem: string | undefined;
  readonly degraded: boolean;
}

/** Legacy snapshot-driven details retained only as a render fallback. */
interface PiDelegationLegacyRenderDetails {
  readonly kind: "weave-delegation";
  readonly agent: string;
  readonly displayName: string;
  readonly status: string;
  readonly currentTool?: string;
  readonly latestOutput: string;
}

type PiDelegationRenderDetails =
  | PiDelegationCompactDetails
  | PiDelegationLegacyRenderDetails;

function formatNamePart(part: string): string {
  if (part.length === 0) return part;
  return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
}

/** Formats normalized names for transcript display without changing tool identity. */
export function formatDelegationAgentName(agentName: string): string {
  if (agentName === "shuttle") return "Shuttle";
  if (agentName.startsWith("shuttle-")) {
    const category = agentName
      .slice("shuttle-".length)
      .split("-")
      .map(formatNamePart)
      .join("-");
    return `${category}-Shuttle`;
  }
  return agentName.split("-").map(formatNamePart).join("-");
}

function toolResult(
  text: PiToolResultContent["text"],
  details?: PiDelegationRenderDetails,
): PiToolResult {
  return { content: [{ type: "text", text }], details };
}

function compactDetailsFrom(
  output: ChildCompactRenderOutput,
): PiDelegationCompactDetails {
  return {
    kind: "weave-delegation-compact",
    lines: output.lines,
    expandedCurrentItem: output.expandedCurrentItem,
    degraded: output.degraded,
  };
}

/** Always stores both collapsed lines and the bounded expanded item. */
function projectCompactDetails(
  projection: PiChildCompactProjection,
): PiDelegationCompactDetails {
  const collapsed = projection.render();
  const expanded = projection.render({ expanded: true });
  return {
    kind: "weave-delegation-compact",
    lines: collapsed.lines,
    expandedCurrentItem: expanded.expandedCurrentItem,
    degraded: collapsed.degraded || expanded.degraded,
  };
}

function compactPartialResult(
  modelVisibleText: string,
  details: PiDelegationCompactDetails,
): PiToolResult {
  return toolResult(modelVisibleText, details);
}

function modelVisibleFromCompact(details: PiDelegationCompactDetails): string {
  // Keep model-visible partial content as the activity line, never chrome.
  const activity = details.lines[1];
  return activity.length > 0 ? activity : "…";
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
  compact?: PiDelegationCompactDetails,
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
    compact,
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
  compact?: PiDelegationCompactDetails,
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
    compact,
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

function readCompactDetails(
  details: unknown,
): PiDelegationCompactDetails | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details))
    return undefined;
  const candidate = details as Partial<PiDelegationCompactDetails>;
  if (candidate.kind !== "weave-delegation-compact") return undefined;
  if (
    !Array.isArray(candidate.lines) ||
    candidate.lines.length !== 3 ||
    typeof candidate.lines[0] !== "string" ||
    typeof candidate.lines[1] !== "string" ||
    typeof candidate.lines[2] !== "string" ||
    typeof candidate.degraded !== "boolean"
  ) {
    return undefined;
  }
  return {
    kind: "weave-delegation-compact",
    lines: [candidate.lines[0], candidate.lines[1], candidate.lines[2]],
    expandedCurrentItem:
      typeof candidate.expandedCurrentItem === "string"
        ? candidate.expandedCurrentItem
        : undefined,
    degraded: candidate.degraded,
  };
}

/** Legacy snapshot details — fallback only for older stored results. */
function readLegacyRenderDetails(
  details: unknown,
): PiDelegationLegacyRenderDetails | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details))
    return undefined;
  const candidate = details as Partial<PiDelegationLegacyRenderDetails>;
  if (candidate.kind !== "weave-delegation") return undefined;
  if (
    typeof candidate.agent !== "string" ||
    typeof candidate.displayName !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.latestOutput !== "string"
  )
    return undefined;
  return candidate as PiDelegationLegacyRenderDetails;
}

function renderStatus(
  details: PiDelegationLegacyRenderDetails,
  theme: PiUiThemePort,
): string {
  const tool =
    details.currentTool === undefined ? "" : ` · ${details.currentTool}`;
  return theme.fg("muted", `${details.status}${tool}`);
}

const COLLAPSED_PREVIEW_CODE_POINT_LIMIT = 240;

/** Width of the rule that separates the delegation call line from its output. */
const DELEGATION_RULE_WIDTH = 50;

function collapsedPreview(output: string): string {
  const normalized = output.replace(/\s+/gu, " ").trim();
  const codePoints = Array.from(normalized);
  if (codePoints.length <= COLLAPSED_PREVIEW_CODE_POINT_LIMIT) {
    return normalized;
  }
  return `…${codePoints
    .slice(-(COLLAPSED_PREVIEW_CODE_POINT_LIMIT - 1))
    .join("")}`;
}

function pushCompactUpdate(
  onUpdate: ((update: PiToolResult) => void) | undefined,
  projection: PiChildCompactProjection,
): PiDelegationCompactDetails {
  const details = projectCompactDetails(projection);
  onUpdate?.(compactPartialResult(modelVisibleFromCompact(details), details));
  return details;
}

function settleCompactProjection(
  projection: PiChildCompactProjection | undefined,
  settlement: PiChildSettlement,
  agentName: string,
  threadId: string,
  runNumber: number,
  action: "start" | "retry" | "continue",
): PiDelegationCompactDetails {
  if (projection !== undefined) {
    projection.settle(settlement);
    return projectCompactDetails(projection);
  }
  // Nested/relay fallback: build the final three-line block from settlement.
  const fallback = new PiChildCompactProjection({
    threadId,
    agentName,
  });
  fallback.startRun({ runNumber, action, agentName });
  fallback.settle(settlement);
  return projectCompactDetails(fallback);
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
 * Shared compact `renderResult` for root and relayed `weave_delegate` tools.
 * Prefer strict compact details; fall back to legacy snapshot details; theme
 * failures degrade without affecting execution.
 */
export function renderDelegationCompactResult(
  result: PiToolResult,
  options: PiToolRenderOptions,
  theme: PiUiThemePort,
  context: PiToolRenderContext,
  onCompactRenderFailure?: (code: string) => void,
): PiToolRenderComponent {
  const degrade = (code: string): PiToolRenderComponent => {
    onCompactRenderFailure?.(code);
    const degraded = degradedChildCompactRender("render_failed");
    return new Text(degraded.lines.join("\n"), 0, 0);
  };

  const compact = readCompactDetails(result.details);
  if (compact !== undefined) {
    return renderPiChildCompactComponent(
      {
        lines: compact.lines,
        expandedCurrentItem: compact.expandedCurrentItem,
        degraded: compact.degraded,
      },
      { expanded: options.expanded },
      theme,
    ).match(
      (component) => component,
      (code) => degrade(code),
    );
  }

  return Result.fromThrowable(
    () => {
      const legacy = readLegacyRenderDetails(result.details);
      const agent =
        legacy?.agent ??
        (typeof context.args?.agent === "string"
          ? context.args.agent
          : "delegate");
      if (legacy === undefined) {
        const fallback = result.content[0]?.text ?? "";
        return new Text(
          theme.fg(
            "toolOutput",
            fallback === "" ? formatDelegationAgentName(agent) : fallback,
          ),
          0,
          0,
        );
      }
      const rule = theme.fg("muted", "\u2500".repeat(DELEGATION_RULE_WIDTH));
      const body =
        legacy.latestOutput.length === 0
          ? renderStatus(legacy, theme)
          : theme.fg(
              "toolOutput",
              options.expanded
                ? legacy.latestOutput
                : collapsedPreview(legacy.latestOutput),
            );
      return new Text(`${rule}\n${body}`, 0, 0);
    },
    () => COMPACT_RENDER_FAILED_CODE,
  )().match(
    (component) => component,
    (code) => degrade(code),
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
  const allowedNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave subagent",
    description:
      "Delegates one task to a single eligible normalized Weave subagent name, run as a private ephemeral child, and returns its structured result. Never advances or creates workflow state.",
    parameters: buildDelegationParameters(allowedNames),
    promptGuidelines: [
      "Pass the exact normalized subagent name from the `agent` enum; never use a display label, description, or alias.",
    ],
    renderCall: (args, theme) => {
      const agent = typeof args.agent === "string" ? args.agent : "delegate";
      const displayName = formatDelegationAgentName(agent);
      const runtime = deps.resolveAgentRuntime?.(agent) ?? {};
      const suffix = [runtime.model, runtime.reasoningLevel]
        .filter((part): part is string => part !== undefined && part !== "")
        .join(" ");
      const title = theme.fg("toolTitle", theme.bold(displayName));
      return new Text(
        suffix === "" ? title : `${title} ${theme.fg("muted", suffix)}`,
        0,
        0,
      );
    },
    renderResult: (result, options, theme, context) =>
      renderDelegationCompactResult(
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
      if (parsed.kind !== "start") {
        // A thread run reuses the thread's own recorded agent, model, and
        // native session; the caller supplies only the opaque thread id and,
        // for a continue, the new task. Each tool call opens a new compact
        // block; prior Pi tool blocks stay frozen.
        const instruction =
          parsed.kind === "retry" ? parsed.instruction : parsed.task;
        let projection: PiChildCompactProjection | undefined;
        let assignedAgent = "delegate";
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
              projection = new PiChildCompactProjection({
                threadId: assignment.threadId,
                agentName: assignment.agentName,
              });
              projection.startRun({
                runNumber: assignment.runNumber,
                action: assignment.action,
                agentName: assignment.agentName,
              });
              pushCompactUpdate(onUpdate, projection);
            },
            onSessionEvent: (event: PiChildSessionEvent) => {
              if (projection === undefined) return;
              projection.applySessionEvent(event);
              pushCompactUpdate(onUpdate, projection);
            },
          })
          .match(
            (outcome) => {
              const compact = settleCompactProjection(
                projection,
                outcome.settlement,
                assignedAgent,
                parsed.threadId,
                outcome.run,
                parsed.kind,
              );
              return threadResult(outcome, compact);
            },
            (failure) => threadFailureResult(parsed.threadId, failure),
          );
      }
      if (!allowedNames.has(parsed.agent)) {
        return failureResult("invalid-delegation-target");
      }
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
      const projection = new PiChildCompactProjection({
        threadId: childId,
        agentName: parsed.agent,
      });
      projection.startRun({
        runNumber: 1,
        action: "start",
        agentName: parsed.agent,
      });
      pushCompactUpdate(onUpdate, projection);
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
        // Compact live updates come only from parser-approved session events.
        // Tree-snapshot onUpdate must not overwrite compact event output.
        onSessionEvent: (event: PiChildSessionEvent) => {
          projection.applySessionEvent(event);
          pushCompactUpdate(onUpdate, projection);
        },
        childId,
      };
      const settlement = controller.delegate(request).match(
        (value) => {
          const compact = settleCompactProjection(
            projection,
            value,
            parsed.agent,
            childId,
            1,
            "start",
          );
          return successResult(value, compact, childId);
        },
        (failure) => startFailureResult(controller, childId, failure),
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

export interface PiRelayedDelegationToolDeps {
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
 * Live session events are unavailable across the relay control channel, so
 * the compact block is built from the structured settlement only. Final
 * appearance and the three-line contract match the root tool.
 */
export function buildRelayedDelegationToolRegistration(
  deps: PiRelayedDelegationToolDeps,
): PiToolRegistration {
  const allowedNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave agent",
    description:
      "Delegates one task to a single eligible Weave agent, run as a private ephemeral child of this session, and returns its structured result. Never advances or creates workflow state.",
    parameters: buildDelegationParameters(allowedNames, deps.targets.length === 0),
    promptGuidelines: [
      deps.targets.length === 0
        ? "Pass a normalized agent name; the authenticated parent validates eligibility."
        : "Use only an `agent` name listed as an eligible delegation target for this session.",
    ],
    renderResult: (result, options, theme, context) =>
      renderDelegationCompactResult(
        result,
        options,
        theme,
        context,
        deps.onCompactRenderFailure,
      ),
    execute: async (_toolCallId, params) => {
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
        (allowedNames.size > 0 && !allowedNames.has(parsed.agent))
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
      const reply: ResultAsync<JsonValue, PiChildRuntimeError> =
        runtime.requestDelegation({
          agentName: parsed.agent,
          task: parsed.task,
        });
      return reply.match(
        (body) => {
          const settlement = parseRelaySettlement(body);
          const compact =
            settlement === undefined
              ? compactDetailsFrom(degradedChildCompactRender("invalid_input"))
              : settleCompactProjection(
                  undefined,
                  settlement,
                  parsed.agent,
                  "nested",
                  1,
                  "start",
                );
          return {
            content: [{ type: "text", text: JSON.stringify(body) }],
            details: compact,
          };
        },
        (failure) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: failure.type }),
            },
          ],
        }),
      );
    },
  };

  return tool;
}
