/**
 * Transform-based agent reconciliation for the V2 adapter.
 *
 * Implements Spec 33 §5–§6 (`docs/specs/33-spec-opencode2-adapter/33-spec-opencode2-adapter.md`).
 * `reconcileAgent()` takes an already-translated `V2AgentInfo` (produced by
 * `./translate-agent`'s `translateAgent()`, marker already prepended to
 * `description`) and upserts it into the V2 runtime via
 * `facade.agent.transform(editor => editor.update(...))` (A5 finding:
 * `update` is the single upsert method used for both create and update).
 *
 * ## Foreign-agent detection (A5 finding)
 *
 * `editor.list()` inside the transform callback only reflects agents
 * already materialized through a prior `agent.transform` call — it does
 * NOT include config-declared agents that the V2 runtime resolves lazily.
 * Those are only visible via the async `facade.agent.list()` accessor.
 * Because Weave must hard-error (default policy) rather than silently
 * overwrite a foreign, non-Weave-owned agent occupying the same id, this
 * module performs the classification read via `facade.agent.list()`
 * *before* opening the transform, then performs the upsert inside the
 * transform only when no foreign collision was found.
 *
 * Classification: an existing agent is Weave-owned iff its `description`
 * starts with `WEAVE_OWNERSHIP_MARKER` (`./translate-agent`).
 *
 * This module MUST NOT import from `packages/adapters/opencode/` (the V1
 * adapter) — see Spec 33 and `./errors.ts` header for the independent V2
 * error union rationale.
 */

import { errAsync, ResultAsync } from "neverthrow";
import {
  agentReconciliationError,
  foreignAgentCollision,
  type OpenCode2AdapterError,
} from "./errors.js";
import type { PluginContextFacade } from "./plugin-context.js";
import type { V2AgentInfo, V2Registration } from "./sdk-types.js";
import { WEAVE_OWNERSHIP_MARKER } from "./translate-agent.js";

/** True iff an existing V2 agent's description carries the Weave ownership marker. */
function isWeaveOwned(agent: V2AgentInfo): boolean {
  return (agent.description ?? "").startsWith(WEAVE_OWNERSHIP_MARKER);
}

/**
 * Reconciles a single already-translated Weave agent into the V2 runtime.
 *
 * Algorithm:
 * 1. Read `facade.agent.list()` to get the full picture, including
 *    config-declared foreign agents invisible to `editor.list()`.
 * 2. If an existing agent with the same id is found and is NOT Weave-owned,
 *    return `err(foreignAgentCollision(...))` — no transform is opened.
 * 3. Otherwise open `facade.agent.transform()` and upsert via
 *    `editor.update(agentInfo.id, cb)`, returning the resulting
 *    `V2Registration`.
 */
export function reconcileAgent(
  facade: PluginContextFacade,
  agentInfo: V2AgentInfo,
): ResultAsync<V2Registration, OpenCode2AdapterError> {
  return ResultAsync.fromPromise(facade.agent.list(), (cause) =>
    agentReconciliationError(agentInfo.id, "verify", cause),
  ).andThen((existingAgents) => {
    const existing = existingAgents.find((a) => a.id === agentInfo.id);
    if (existing !== undefined && !isWeaveOwned(existing)) {
      return errAsync(foreignAgentCollision(agentInfo.id, existing));
    }
    return ResultAsync.fromPromise(
      facade.agent.transform((editor) => {
        editor.update(agentInfo.id, (cur) => {
          Object.assign(cur, agentInfo);
        });
      }),
      (cause) => agentReconciliationError(agentInfo.id, "transform", cause),
    );
  });
}
