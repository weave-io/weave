/**
 * The immutable catalog view one dispatched child is pinned to.
 *
 * A generation's catalog can be republished between delegations (see
 * `catalog-cell.ts`). Everything a *future* dispatch decides - which limits
 * apply, which lifecycle budgets a child runs under, which nested targets it
 * may reach, what its bootstrap says - must therefore be sampled at the moment
 * that child is dispatched, and then held still for as long as it lives.
 *
 * This module is that sample. One snapshot projects exactly one immutable
 * {@link PiConfigActivationResult}:
 *
 * - **Sampled once, never re-read.** A child's four lifecycle budgets and its
 *   nested-target authority come from the same activation, taken in one read.
 *   Four independent accessors could straddle a publication and give a child
 *   one catalog's handshake timeout with another catalog's runtime budget.
 * - **Pinned by reference.** A `PiConfigActivationResult` is immutable, so
 *   pinning is one reference, not a copy. The bound is one reference per live
 *   child; the controller releases it when the child settles or is disposed.
 * - **Fail closed.** {@link EMPTY_PI_DISPATCH_SNAPSHOT} is what a revoked
 *   generation - or a controller wired without a catalog - resolves to: no
 *   target is eligible, no role is known, and no bootstrap is built.
 */

import type { AgentDescriptor, DelegationTarget } from "@weaveio/weave-engine";
import type { PiConfigActivationResult } from "./config-activator.js";
import type { JsonValue } from "./strict-json.js";

/** A task/context object echoed at multiple layers (Pi adapter contract). */
export interface PiDelegationContext {
  readonly parentAgentName: string;
  readonly parentDepth: number;
  readonly cwd: string;
}

/**
 * The four child lifecycle budgets one dispatch samples together.
 *
 * They are read as a group, from one activation, because they describe a
 * single child's timing contract. An absent value keeps `PiRpcChild`'s own
 * default, exactly as an omitted dep did before.
 */
export interface PiChildDispatchBudgets {
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly runtimeBudgetMs?: number;
}

/** One catalog activation, projected into what a dispatch needs from it. */
export interface PiDispatchSnapshot {
  /**
   * The exact immutable activation this snapshot projects, or `undefined` for
   * the empty snapshot. Carried so a pinned child can be proven to hold the
   * catalog it was dispatched with, even after a later publication.
   */
  readonly catalog: PiConfigActivationResult | undefined;
  /** Lifecycle budgets, all four from this one activation. */
  readonly budgets: PiChildDispatchBudgets;
  /**
   * Resolves a nested/descendant delegation target: the requesting agent's own
   * normalized `delegationTargets` only, never an arbitrary configured agent.
   * `undefined` fails the request closed.
   */
  readonly resolveDelegationTarget: (
    requestingAgentName: string,
    targetAgentName: string,
  ) => DelegationTarget | undefined;
  /**
   * The configured category name for one agent, used as the inspector's
   * `role` fact. `undefined` for an agent this catalog did not configure, or
   * one with no category: a role is reported, never invented.
   */
  readonly resolveAgentRole: (agentName: string) => string | undefined;
  /** Builds a resolved target's bootstrap payload from this catalog. */
  readonly buildBootstrap: (
    target: DelegationTarget,
    childId: string,
    context: PiDelegationContext,
  ) => JsonValue;
}

/**
 * The snapshot that resolves nothing.
 *
 * Used for a revoked generation and for any controller constructed without a
 * catalog. Every resolution returns `undefined`, so a delegation attempted
 * against it fails closed with `invalid-delegation-target` rather than
 * reaching a spawn, and every budget falls back to the transport's default.
 */
function noDispatchResolution(): undefined {}

export const EMPTY_PI_DISPATCH_SNAPSHOT: PiDispatchSnapshot = Object.freeze({
  catalog: undefined,
  budgets: Object.freeze({}),
  resolveDelegationTarget: noDispatchResolution,
  resolveAgentRole: noDispatchResolution,
  buildBootstrap: () => null,
});

/** What one snapshot is projected from. */
export interface PiDispatchSnapshotInput {
  /** The immutable activation this snapshot pins. */
  readonly catalog: PiConfigActivationResult;
  /**
   * Builds a child's bootstrap from *this snapshot's own* descriptors and
   * disabled skills, which are passed in rather than read from a live cell so
   * a pinned child's bootstrap can never be composed from a later catalog.
   */
  readonly buildBootstrap: (
    descriptors: ReadonlyMap<string, AgentDescriptor>,
    disabledSkills: readonly string[],
    target: DelegationTarget,
    childId: string,
    context: PiDelegationContext,
  ) => JsonValue;
}

/**
 * Projects one immutable activation into the view a dispatch pins.
 *
 * Pure and total: it only reads the activation it is given. Callers memoize
 * per activation reference, so an unchanged catalog yields the same snapshot
 * object on every sample.
 */
export function createPiDispatchSnapshot(
  input: PiDispatchSnapshotInput,
): PiDispatchSnapshot {
  const descriptors = input.catalog.descriptors.byName;
  const disabledSkills = input.catalog.config.disabled?.skills ?? [];
  const lifecycle = input.catalog.childLifecycleSettings;
  const snapshot: PiDispatchSnapshot = {
    catalog: input.catalog,
    budgets: Object.freeze({
      handshakeTimeoutMs: lifecycle.handshakeTimeoutMs,
      replyTimeoutMs: lifecycle.replyTimeoutMs,
      settlementTimeoutMs: lifecycle.settlementInactivityTimeoutMs,
      runtimeBudgetMs: lifecycle.absoluteRuntimeBudgetMs,
    }),
    resolveDelegationTarget: (requestingAgentName, targetAgentName) =>
      descriptors
        .get(requestingAgentName)
        ?.delegationTargets.find((target) => target.name === targetAgentName),
    resolveAgentRole: (agentName) => descriptors.get(agentName)?.category?.name,
    buildBootstrap: (target, childId, context) =>
      input.buildBootstrap(
        descriptors,
        disabledSkills,
        target,
        childId,
        context,
      ),
  };
  return Object.freeze(snapshot);
}
