/**
 * PlanStateProvider — abstract interface for revisioned plan snapshots and
 * coordinator-authorized transitions.
 *
 * The engine owns this interface, snapshot/transition types, transition-rule
 * helpers, and coordinator authorization. Adapters (or the default Bun-backed
 * implementation in `@weaveio/weave-config`) own concrete plan I/O, parsing,
 * compare-and-swap, and atomic replacement.
 *
 * `planExists` and `isPlanComplete` remain compatibility projections over
 * `readSnapshot`.
 *
 * @see docs/specs/19-spec-plan-state-provider/19-spec-plan-state-provider.md
 * @see docs/specs/33-spec-pi-adapter/33-spec-pi-adapter.md §16
 * @see docs/adr/0010-plan-state-and-artifact-approval-authority.md
 * @see docs/adapter-boundary.md — Plan State Provider subsection
 */

import { err, errAsync, ok, type Result, type ResultAsync } from "neverthrow";

// ---------------------------------------------------------------------------
// Task / snapshot types
// ---------------------------------------------------------------------------

/** Leaf/parent task progress state derived from checkbox markers. */
export type PlanTaskState = "pending" | "in_progress" | "completed";

/** All valid `PlanTaskState` values as a readonly tuple (Spec 33 §16 plan markers). */
export const PLAN_TASK_STATES = [
  "pending",
  "in_progress",
  "completed",
] as const satisfies readonly PlanTaskState[];

/** Whether the parsed plan matched the canonical two-level grammar. */
export type PlanFormat = "canonical" | "legacy";

/**
 * One node in the normalized plan task tree.
 *
 * Parents carry visible numeric IDs (`"1"`, `"2"`). Direct children carry
 * dotted IDs (`"1.a"`, `"1.b"`). Depth is at most two levels.
 */
export interface PlanTaskNode {
  /** Visible task ID (`"1"` or `"1.a"`). */
  readonly id: string;
  /** Task title text after the ID label. */
  readonly title: string;
  /** Effective state (derived for parents with children). */
  readonly state: PlanTaskState;
  /** Ordered direct children; empty for leaves. */
  readonly children: readonly PlanTaskNode[];
}

/**
 * Normalized revisioned snapshot of a plan file.
 *
 * `contentRevision` is an opaque CAS token (typically a content digest).
 * `complete` is true only when every leaf is `completed`.
 */
export interface PlanTaskSnapshot {
  readonly planName: string;
  readonly contentRevision: string;
  readonly format: PlanFormat;
  readonly parents: readonly PlanTaskNode[];
  readonly totalParentCount: number;
  readonly complete: boolean;
}

/**
 * Compare-and-swap transition request for a single leaf task.
 *
 * Engine helpers authorize the coordinator; the provider enforces leaf
 * transition rules, expected-revision CAS, and atomic durable replacement.
 */
export interface PlanTaskTransition {
  readonly planName: string;
  /** Leaf task ID (`"1"` for childless parent, or `"1.a"` for a subtask). */
  readonly taskId: string;
  /** Snapshot `contentRevision` that must still match on disk. */
  readonly expectedRevision: string;
  /** Requested leaf state after the transition. */
  readonly toState: PlanTaskState;
  /** Logical agent requesting the transition (Tapestry by default). */
  readonly coordinatorAgent: string;
}

// ---------------------------------------------------------------------------
// PlanStateError — discriminated union
// ---------------------------------------------------------------------------

/**
 * Errors that a `PlanStateProvider` implementation or engine plan helper may
 * return.
 *
 * Compatibility variants:
 * - `InvalidPlanName` — unsafe plan name (optional `reason` for detail)
 * - `ProviderUnavailable` — infrastructure failure (`cause` retained for
 *   existing call sites; `reason` is a stable summary)
 *
 * Spec 33 closed plan failures:
 * - `PlanMissing`, `PlanReadFailed`, `PlanWriteFailed`, `PlanRevisionStale`,
 *   `PlanTreeMalformed`, `LegacyPlanUnsupported`
 *
 * Engine authorization / transition failures:
 * - `UnauthorizedCoordinator`, `InvalidTransition`, `TaskNotFound`
 */
export type PlanStateError =
  | {
      readonly type: "InvalidPlanName";
      readonly planName: string;
      readonly reason?: string;
    }
  | {
      readonly type: "ProviderUnavailable";
      readonly cause: Error | { readonly message: string };
      readonly reason?: string;
    }
  | { readonly type: "PlanMissing"; readonly planName: string }
  | {
      readonly type: "PlanReadFailed";
      readonly planName: string;
      readonly reason: string;
    }
  | {
      readonly type: "PlanWriteFailed";
      readonly planName: string;
      readonly reason: string;
    }
  | {
      readonly type: "PlanRevisionStale";
      readonly planName: string;
      readonly expectedRevision: string;
      readonly actualRevision: string;
    }
  | {
      readonly type: "PlanTreeMalformed";
      readonly planName: string;
      readonly reason: string;
    }
  | {
      readonly type: "LegacyPlanUnsupported";
      readonly planName: string;
      readonly reason: string;
    }
  | {
      readonly type: "UnauthorizedCoordinator";
      readonly planName: string;
      readonly coordinatorAgent: string;
      readonly reason: string;
    }
  | {
      readonly type: "InvalidTransition";
      readonly planName: string;
      readonly taskId: string;
      readonly from: PlanTaskState;
      readonly to: PlanTaskState;
      readonly reason: string;
    }
  | {
      readonly type: "TaskNotFound";
      readonly planName: string;
      readonly taskId: string;
    };

// ---------------------------------------------------------------------------
// PlanStateProvider — interface
// ---------------------------------------------------------------------------

/**
 * Abstract provider for revisioned plan snapshots and transitions.
 *
 * Implementations must:
 * 1. Validate `planName` against the safe-name allowlist before constructing
 *    any filesystem path (prevents path traversal).
 * 2. Prove canonical-root containment, reject symlink components, and use
 *    no-follow stable file identity for reads and atomic replacement when the
 *    platform can prove those properties; otherwise fail closed.
 * 3. Treat `planExists` / `isPlanComplete` as projections of `readSnapshot`.
 */
export interface PlanStateProvider {
  /**
   * Parse the plan into a revisioned normalized snapshot.
   *
   * Returns `err({ type: "PlanMissing" })` when the file does not exist.
   */
  readSnapshot(planName: string): ResultAsync<PlanTaskSnapshot, PlanStateError>;

  /**
   * Apply a leaf-task transition with expected-revision compare-and-swap.
   *
   * Returns the post-write snapshot on success. Stale revisions, illegal
   * transitions, and identity changes fail closed.
   */
  applyTransition(
    input: PlanTaskTransition,
  ): ResultAsync<PlanTaskSnapshot, PlanStateError>;

  /**
   * Compatibility projection: whether the plan file exists.
   *
   * Returns `ok(true)` when `readSnapshot` would succeed, `ok(false)` when the
   * plan is missing, or a typed error for invalid names / I/O failures.
   */
  planExists(planName: string): ResultAsync<boolean, PlanStateError>;

  /**
   * Compatibility projection: whether every leaf is completed.
   *
   * Returns `ok(true)` / `ok(false)` from snapshot completeness. Missing plans
   * return a typed error (not `ok(false)`), preserving the Spec 19 contract.
   */
  isPlanComplete(planName: string): ResultAsync<boolean, PlanStateError>;
}

// ---------------------------------------------------------------------------
// Pure helpers — engine-owned transition and completion semantics
// ---------------------------------------------------------------------------

/** Default authorized plan coordinator (Tapestry). */
export const DEFAULT_PLAN_COORDINATOR = "tapestry";

/**
 * Allowed leaf transitions:
 * - pending → in_progress → completed
 * - explicit coordinator retry: in_progress → pending
 *
 * Completed leaves are terminal.
 */
export function isAllowedPlanLeafTransition(
  from: PlanTaskState,
  to: PlanTaskState,
): boolean {
  if (from === to) return false;
  if (from === "pending" && to === "in_progress") return true;
  if (from === "in_progress" && to === "completed") return true;
  if (from === "in_progress" && to === "pending") return true;
  return false;
}

/**
 * Derive parent state from ordered child states.
 *
 * - all pending → pending
 * - all completed → completed
 * - otherwise → in_progress
 */
export function derivePlanParentState(
  childStates: readonly PlanTaskState[],
): PlanTaskState {
  if (childStates.length === 0) return "pending";
  let allPending = true;
  let allCompleted = true;
  for (const state of childStates) {
    if (state !== "pending") allPending = false;
    if (state !== "completed") allCompleted = false;
  }
  if (allPending) return "pending";
  if (allCompleted) return "completed";
  return "in_progress";
}

/** True when every leaf under the parent list is completed. */
export function isPlanSnapshotComplete(
  parents: readonly PlanTaskNode[],
): boolean {
  if (parents.length === 0) return true;
  for (const parent of parents) {
    if (parent.children.length === 0) {
      if (parent.state !== "completed") return false;
      continue;
    }
    for (const child of parent.children) {
      if (child.state !== "completed") return false;
    }
  }
  return true;
}

/**
 * Locate a mutable leaf by visible task ID.
 *
 * Parents with children are not leaves — only childless parents and children
 * may transition.
 */
export function findPlanLeaf(
  parents: readonly PlanTaskNode[],
  taskId: string,
): PlanTaskNode | undefined {
  for (const parent of parents) {
    if (parent.id === taskId) {
      if (parent.children.length > 0) return undefined;
      return parent;
    }
    for (const child of parent.children) {
      if (child.id === taskId) return child;
    }
  }
  return undefined;
}

/**
 * Authorize a plan transition coordinator.
 *
 * Only the active workflow coordinator (Tapestry by default) may request
 * transitions. Workers cannot mutate or self-certify plan tasks.
 */
export function authorizePlanCoordinator(
  coordinatorAgent: string,
  planName: string,
  authorizedCoordinator: string = DEFAULT_PLAN_COORDINATOR,
): Result<undefined, PlanStateError> {
  if (coordinatorAgent.trim().length === 0) {
    return err({
      type: "UnauthorizedCoordinator",
      planName,
      coordinatorAgent,
      reason: "coordinatorAgent is required",
    });
  }
  if (coordinatorAgent !== authorizedCoordinator) {
    return err({
      type: "UnauthorizedCoordinator",
      planName,
      coordinatorAgent,
      reason: `only the authorized plan coordinator "${authorizedCoordinator}" may apply transitions`,
    });
  }
  return ok(undefined);
}

/**
 * Validate transition rules against a snapshot before the provider mutates.
 *
 * Checks coordinator authority, leaf existence, and allowed state edges.
 * Does not perform I/O or revision compare-and-swap — the provider owns CAS.
 */
export function validatePlanTransition(
  snapshot: PlanTaskSnapshot,
  input: PlanTaskTransition,
  authorizedCoordinator: string = DEFAULT_PLAN_COORDINATOR,
): Result<PlanTaskNode, PlanStateError> {
  const auth = authorizePlanCoordinator(
    input.coordinatorAgent,
    input.planName,
    authorizedCoordinator,
  );
  if (auth.isErr()) return err(auth.error);

  if (input.expectedRevision !== snapshot.contentRevision) {
    return err({
      type: "PlanRevisionStale",
      planName: input.planName,
      expectedRevision: input.expectedRevision,
      actualRevision: snapshot.contentRevision,
    });
  }

  const leaf = findPlanLeaf(snapshot.parents, input.taskId);
  if (leaf === undefined) {
    return err({
      type: "TaskNotFound",
      planName: input.planName,
      taskId: input.taskId,
    });
  }

  if (!isAllowedPlanLeafTransition(leaf.state, input.toState)) {
    return err({
      type: "InvalidTransition",
      planName: input.planName,
      taskId: input.taskId,
      from: leaf.state,
      to: input.toState,
      reason: `transition ${leaf.state} → ${input.toState} is not allowed`,
    });
  }

  return ok(leaf);
}

/**
 * Engine-owned authorized transition entry point.
 *
 * Validates coordinator authority and transition rules against the current
 * snapshot, then delegates durable CAS replacement to the provider.
 */
export function applyAuthorizedPlanTransition(
  provider: PlanStateProvider,
  input: PlanTaskTransition,
  authorizedCoordinator: string = DEFAULT_PLAN_COORDINATOR,
): ResultAsync<PlanTaskSnapshot, PlanStateError> {
  return provider.readSnapshot(input.planName).andThen((snapshot) => {
    const validated = validatePlanTransition(
      snapshot,
      input,
      authorizedCoordinator,
    );
    if (validated.isErr()) return errAsync(validated.error);
    return provider.applyTransition(input);
  });
}
