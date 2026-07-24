/**
 * The single Weave-owned ordinary-delegation tool (Spec 33 §11.1). Targets
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
import type { PiWeaveToolRegistration } from "./permission-bridge.js";
import type { JsonValue } from "./strict-json.js";
import type {
  IdGenerator,
  PiSessionContext,
  PiToolRegistration,
} from "./types.js";

export const WEAVE_DELEGATION_TOOL_NAME = "weave_delegate";
export const WEAVE_DELEGATION_TOOL_OWNER = "@weaveio/weave-adapter-pi";
export const WEAVE_DELEGATION_TOOL_REVISION = "1";
const MAX_TASK_PREVIEW_CHARS = 200;
// The raw `task` tool argument bound itself (Spec 33 §11.2 Task 9) lives in
// `delegation-limits.js` - a dependency-free leaf module shared with
// `child-control-bodies.ts`, `delegation-controller.ts`, and `rpc-child.ts`
// - so every layer enforces the exact same limit without this tool module
// becoming (or being reachable from) a schema-layer dependency.

/**
 * The real Pi-compatible TypeBox parameter schema for `weave_delegate`
 * (Spec 33 §7/§11.1) - built from the actual `typebox` package Pi itself
 * validates tool arguments against, using `@earendil-works/pi-ai`'s
 * `StringEnum` helper so the `agent` enum stays compatible with providers
 * (e.g. Google) that reject `anyOf`/`const`-shaped unions. `task` is a
 * bounded (never unlimited) string, never a bare unconstrained JSON-schema
 * object literal.
 */
function buildDelegationParameters(allowedNames: ReadonlySet<string>) {
  return Type.Object({
    agent: StringEnum(Array.from(allowedNames), {
      description: "Name of the eligible Weave agent to delegate to.",
    }),
    task: Type.String({
      minLength: 1,
      maxLength: MAX_TASK_INPUT_CHARS,
      description: "The bounded task description for the delegated agent.",
    }),
  });
}

export interface PiDelegationToolDeps {
  readonly targets: readonly DelegationTarget[];
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
  /** The invoking primary's own agent name - limits are the parent's own budget, never the target's (Spec 33 §10). */
  readonly parentAgentName: string;
  /** Generates each delegated child's id up front (Spec 33 §11.2 Task 9), so it can be embedded as the bootstrap's own `correlationId` before `controller.delegate()` assigns one internally. */
  readonly idGenerator: IdGenerator;
  /**
   * Builds the bootstrap payload, given the pre-generated `childId` and the
   * live session `ctx` - the only place a root-level delegation has access
   * to `ctx.modelRegistry` for a concrete parent-resolved model identity
   * (Spec 33 §9.2, §11.2 Task 9).
   */
  readonly buildBootstrap: (
    target: DelegationTarget,
    task: string,
    childId: string,
    ctx: PiSessionContext,
  ) => JsonValue;
  readonly buildEnv: () => Record<string, string>;
}

function truncatePreview(text: string): string {
  return text.length <= MAX_TASK_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MAX_TASK_PREVIEW_CHARS)}\u2026`;
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

/** Builds the one Weave-owned delegation tool, restricted to `deps.targets`, for one eligible primary or child. */
export function buildDelegationToolRegistration(
  deps: PiDelegationToolDeps,
): PiWeaveToolRegistration {
  const allowedNames = new Set(deps.targets.map((target) => target.name));

  const tool: PiToolRegistration = {
    name: WEAVE_DELEGATION_TOOL_NAME,
    label: "Delegate to a Weave agent",
    description:
      "Delegates one bounded task to a single eligible Weave agent, run as a private ephemeral child, and returns its structured result. Never advances or creates workflow state.",
    parameters: buildDelegationParameters(allowedNames),
    promptGuidelines: [
      "Use only an `agent` name listed as an eligible delegation target for this session.",
    ],
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
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
      const target = deps.targets.find(
        (candidate) => candidate.name === parsed.agent,
      );
      if (target === undefined) {
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
      const controller = deps.getController();
      if (controller === undefined) {
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
      const childId = deps.idGenerator.next();
      const request: PiDelegationRequest = {
        parentId: deps.parentId,
        parentDepth: deps.parentDepth,
        parentAgentName: deps.parentAgentName,
        agentName: parsed.agent,
        task: parsed.task,
        cwd: ctx.cwd,
        env: deps.buildEnv(),
        bootstrap: deps.buildBootstrap(target, parsed.task, childId, ctx),
        childId,
      };
      return controller.delegate(request).match(
        (settlement) => ({
          content: [
            { type: "text", text: JSON.stringify({ ok: true, settlement }) },
          ],
        }),
        (failure) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: false, error: failure.code }),
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

export interface PiRelayedDelegationToolDeps {
  readonly targets: readonly DelegationTarget[];
  /** Lazily reads this child's own private-control runtime; `undefined` before bootstrap has applied (fails closed). */
  readonly getRuntime: () => PiChildRuntime | undefined;
}

/**
 * Builds a delegated child's own `weave_delegate` tool (Spec 33 §10-11,
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
