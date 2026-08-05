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
import type { ResultAsync } from "neverthrow";
import { Type } from "typebox";
import type { PiChildRuntime, PiChildRuntimeError } from "./child-runtime.js";
import type { PiChildTreeNode } from "./child-tree.js";
import { truncateLatestOutput } from "./child-tree.js";
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "./delegation-controller.js";
import {
  makeChildAbortFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiParentSessionState } from "./primary-session.js";
import { requirePersistentParentSession } from "./primary-session.js";
import type { PiChildSettlement } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import type {
  IdGenerator,
  PiSessionContext,
  PiToolRegistration,
  PiToolResult,
  PiToolResultContent,
  PiUiThemePort,
} from "./types.js";

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
 * bounded (never unlimited) string, never a bare unconstrained JSON-schema
 * object literal.
 */
function buildDelegationParameters(allowedNames: ReadonlySet<string>) {
  return Type.Object({
    agent: StringEnum(Array.from(allowedNames), {
      description:
        "Exact normalized subagent name from this agent's eligible delegation targets.",
    }),
    task: Type.String({
      minLength: 1,
      description: "The task description for the delegated agent.",
    }),
  });
}

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
}

interface PiDelegationRenderDetails {
  readonly kind: "weave-delegation";
  readonly agent: string;
  readonly displayName: string;
  readonly status: string;
  readonly currentTool?: string;
  readonly latestOutput: string;
}

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

function settlementOutput(settlement: PiChildSettlement): string {
  if (settlement.outcome === "completed") {
    return settlement.assistantOutput ?? settlement.completionCandidate ?? "";
  }
  if (settlement.outcome === "failed") return settlement.reason;
  return "Cancelled";
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

function parentVisibleSettlement(
  settlement: PiChildSettlement,
): Record<string, unknown> {
  if (settlement.outcome === "completed") {
    const output =
      typeof settlement.assistantOutput === "string"
        ? truncateLatestOutput(settlement.assistantOutput)
        : "";
    return {
      outcome: "completed",
      ...(output.length > 0 ? { finalOutput: output } : {}),
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

function successResult(
  agent: string,
  settlement: PiChildSettlement,
): PiToolResult {
  return toolResult(
    JSON.stringify({
      ok: true,
      settlement: parentVisibleSettlement(settlement),
    }),
    {
      kind: "weave-delegation",
      agent,
      displayName: formatDelegationAgentName(agent),
      status: settlement.outcome,
      latestOutput: settlementOutput(settlement),
    },
  );
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

function streamingResult(
  agent: string,
  snapshot: PiChildTreeNode,
): PiToolResult {
  const details: PiDelegationRenderDetails = {
    kind: "weave-delegation",
    agent,
    displayName: formatDelegationAgentName(agent),
    status: snapshot.status,
    currentTool: snapshot.currentTool,
    latestOutput: snapshot.latestOutput,
  };
  const text = snapshot.latestOutput || `Status: ${snapshot.status}`;
  return toolResult(text, details);
}

function readRenderDetails(
  details: unknown,
): PiDelegationRenderDetails | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details))
    return undefined;
  const candidate = details as Partial<PiDelegationRenderDetails>;
  if (candidate.kind !== "weave-delegation") return undefined;
  if (
    typeof candidate.agent !== "string" ||
    typeof candidate.displayName !== "string" ||
    typeof candidate.status !== "string" ||
    typeof candidate.latestOutput !== "string"
  )
    return undefined;
  return candidate as PiDelegationRenderDetails;
}

function renderStatus(
  details: PiDelegationRenderDetails,
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

function parseDelegationCall(
  call: unknown,
): { agent: string; task: string } | undefined {
  if (typeof call !== "object" || call === null || Array.isArray(call))
    return undefined;
  const record = call as Record<string, unknown>;
  const agent = record.agent;
  const task = record.task;
  if (typeof agent !== "string" || typeof task !== "string") return undefined;
  if (task.length < 1) return undefined;
  return { agent, task };
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
    renderResult: (result, options, theme, context) => {
      const details = readRenderDetails(result.details);
      const agent =
        details?.agent ??
        (typeof context.args?.agent === "string"
          ? context.args.agent
          : "delegate");
      if (details === undefined) {
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
      // The call line already names the agent, model, and reasoning level, so
      // the result body is a rule and the child's latest thought.
      const rule = theme.fg("muted", "\u2500".repeat(DELEGATION_RULE_WIDTH));
      const body =
        details.latestOutput.length === 0
          ? renderStatus(details, theme)
          : theme.fg(
              "toolOutput",
              options.expanded
                ? details.latestOutput
                : collapsedPreview(details.latestOutput),
            );
      return new Text(`${rule}\n${body}`, 0, 0);
    },
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
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
      if (parsed === undefined || !allowedNames.has(parsed.agent)) {
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
      const controller = deps.getController();
      if (controller === undefined) {
        return failureResult("delegation-transport-unavailable");
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
        onUpdate:
          onUpdate === undefined
            ? undefined
            : (snapshot) => onUpdate(streamingResult(parsed.agent, snapshot)),
        childId,
      };
      const settlement = controller.delegate(request).match(
        (value) => successResult(parsed.agent, value),
        (failure) => failureResult(failure.code, failure),
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
    parameters: buildDelegationParameters(allowedNames),
    promptGuidelines: [
      "Use only an `agent` name listed as an eligible delegation target for this session.",
    ],
    execute: async (_toolCallId, params) => {
      const parsed = parseDelegationCall(params);
      if (parsed === undefined || !allowedNames.has(parsed.agent)) {
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
        (body) => ({
          content: [{ type: "text", text: JSON.stringify(body) }],
        }),
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
