/**
 * The single Weave-owned ordinary-delegation tool (Pi adapter contract). Targets
 * are restricted to the invoking descriptor's own normalized
 * `delegationTargets` - never re-derived, never bypassing Task 8's
 * caller-supplied-resolver/guarded-registration path. Execution returns a
 * structured result to the caller and never creates or advances workflow
 * state; direct workflow dispatch is a distinct port for a later task.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { err, ok, type ResultAsync } from "neverthrow";
import { Type } from "typebox";
import type { PiChildRuntime, PiChildRuntimeError } from "./child-runtime.js";
import type {
  PiDelegationController,
  PiDelegationRequest,
} from "./delegation-controller.js";
import { MAX_TASK_INPUT_CHARS } from "./delegation-limits.js";
import {
  makeChildAbortFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { PiWeaveToolRegistration } from "./permission-bridge.js";
import type { PiChildSettlement } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import type {
  IdGenerator,
  PiSessionContext,
  PiToolRegistration,
  PiToolResultContent,
} from "./types.js";

export const WEAVE_DELEGATION_TOOL_NAME = "weave_delegate";
export const WEAVE_DELEGATION_TOOL_OWNER = "@weaveio/weave-adapter-pi";
export const WEAVE_DELEGATION_TOOL_REVISION = "1";
const MAX_TASK_PREVIEW_CHARS = 200;
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
      maxLength: MAX_TASK_INPUT_CHARS,
      description: "The bounded task description for the delegated agent.",
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
}

function truncatePreview(text: string): string {
  return text.length <= MAX_TASK_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MAX_TASK_PREVIEW_CHARS)}\u2026`;
}

function toolResult(text: PiToolResultContent["text"]): {
  content: readonly PiToolResultContent[];
} {
  return { content: [{ type: "text", text }] };
}

function successResult(settlement: PiChildSettlement): {
  content: readonly PiToolResultContent[];
} {
  return toolResult(JSON.stringify({ ok: true, settlement }));
}

function failureResult(error: string): {
  content: readonly PiToolResultContent[];
} {
  return toolResult(JSON.stringify({ ok: false, error }));
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
        resolveFailure?.(failureResult(first.code));
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
  if (task.length < 1 || task.length > MAX_TASK_INPUT_CHARS) return undefined;
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
): PiWeaveToolRegistration {
  const allowedNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave subagent",
    description:
      "Delegates one bounded task to a single eligible normalized Weave subagent name, run as a private ephemeral child, and returns its structured result. Never advances or creates workflow state.",
    parameters: buildDelegationParameters(allowedNames),
    promptGuidelines: [
      "Pass the exact normalized subagent name from the `agent` enum; never use a display label, description, or alias.",
    ],
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
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
        return failureResult(
          makeChildAbortFailedFailure(childId, "aborted-before-dispatch").code,
        );
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
        childId,
      };
      const settlement = controller.delegate(request).match(
        (value) => successResult(value),
        (failure) => failureResult(failure.code),
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

  return {
    tool,
    owner: WEAVE_DELEGATION_TOOL_OWNER,
    revision: WEAVE_DELEGATION_TOOL_REVISION,
    summary: "Delegate a bounded task to one eligible agent.",
    resolver: ({ call }) => {
      const parsed = parseDelegationCall(call);
      if (parsed === undefined) {
        return ok([
          {
            unresolved: true,
            display: { summary: "Delegate to an eligible agent" },
          },
        ]);
      }
      const invocation = readInvocationContext(deps);
      const isActiveTarget = invocation?.targets.some(
        (target) => target.name === parsed.agent,
      );
      if (!allowedNames.has(parsed.agent) || isActiveTarget !== true) {
        return err({
          type: "unsafe_input",
          path: "agent",
          message: "not an eligible delegation target",
        });
      }
      return ok([
        {
          unresolved: false,
          capability: "delegate",
          operation: "delegate",
          target: { kind: "weave-agent", identifier: parsed.agent },
          display: {
            summary: `Delegate to ${parsed.agent}`,
            details: truncatePreview(parsed.task),
          },
        },
      ]);
    },
  };
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
): PiWeaveToolRegistration {
  const allowedNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave agent",
    description:
      "Delegates one bounded task to a single eligible Weave agent, run as a private ephemeral child of this session, and returns its structured result. Never advances or creates workflow state.",
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

  return {
    tool,
    owner: WEAVE_DELEGATION_TOOL_OWNER,
    revision: WEAVE_DELEGATION_TOOL_REVISION,
    summary: "Delegate a bounded task to one eligible agent.",
    resolver: ({ call }) => {
      const parsed = parseDelegationCall(call);
      if (parsed === undefined) {
        return ok([
          {
            unresolved: true,
            display: { summary: "Delegate to an eligible agent" },
          },
        ]);
      }
      if (!allowedNames.has(parsed.agent)) {
        return err({
          type: "unsafe_input",
          path: "agent",
          message: "not an eligible delegation target",
        });
      }
      return ok([
        {
          unresolved: false,
          capability: "delegate",
          operation: "delegate",
          target: { kind: "weave-agent", identifier: parsed.agent },
          display: {
            summary: `Delegate to ${parsed.agent}`,
            details: truncatePreview(parsed.task),
          },
        },
      ]);
    },
  };
}
