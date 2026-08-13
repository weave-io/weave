/**
 * Adapter-owned coordinator that projects all ten engine execution-lifecycle
 * operations (Pi adapter contract; docs/architecture/adapter-boundary.md "Execution Lifecycle
 * Surface"). This class never reimplements engine state-transition logic -
 * every method is a thin, typed projection that calls the corresponding
 * `@weaveio/weave-engine` lifecycle function and applies the effects it
 * returns *exactly once*. It owns only:
 *
 *  - explicit user-authorization enforcement for start/resume (Pi adapter contract,
 *    ADR 0004): callers must present an `AuthorizedByUser` token that only
 *    {@link authorizeByExplicitUser} can mint, and only from a real
 *    `confirmed === true` boolean - never from prompt text, delegation,
 *    tools, idle/session events, or continuation/recovery banners;
 *  - lease/generation rebind-and-recheck at every async boundary;
 *  - the direct-step dispatch loop. The *first* dispatch of a run/resume
 *    calls `dispatchStep` once; every subsequent step has the same
 *    uninterrupted generation is driven exclusively by the `dispatch-agent`
 *    effect `completeStep` itself returns (Pi adapter contract: "apply each
 *    returned effect exactly once... auto-dispatch next only when returned
 *    by completeStep") - `dispatchStep` is never called a second time for a
 *    step `completeStep` already advanced past;
 *  - artifact digest recomputation before dispatch (adapter-owned per
 *    docs/architecture/adapter-boundary.md) and explicit `pinnedArtifactRevisions`
 *    computed from the current `inspect()` snapshot for every declared
 *    step input - reusing the exact revisions the step's prior attempt
 *    (if any) already consumed by default, and only pinning the current
 *    latest revision for inputs with no prior attempt (execution lifecycle contract:
 *    "reuse the same consumed artifact revisions on retry by default";
 *    Non-Goal 5: no automatic latest-artifact rebinding on retry - see
 *    `computePinnedArtifactRevisions`), and routing a pinned-digest/
 *    revision mismatch to `reconcileExecution` with reason
 *    `"execution-mismatch"` instead of silently rebinding (Pi adapter contract);
 *  - session observation at every Pi adapter contract point (authorized
 *    start/resume, each direct-step activation, each settlement, pause,
 *    and termination);
 *  - appending a bounded recovery pointer after a matching Runtime Store
 *    commit succeeds.
 */
import {
  type AgentDescriptor,
  type ArtifactApprovalActor,
  type ArtifactRef,
  approveArtifact,
  type ConsumedArtifactRecord,
  completeStep,
  createArtifactId,
  createExecutionLeaseId,
  createOwnerId,
  createWorkflowInstanceId,
  dispatchStep,
  handleUserInterrupt,
  type InspectExecutionOutput,
  inspectExecution,
  type LifecycleEffect,
  type LifecycleError,
  observeSession,
  type PlanStateError,
  type PlanStateProvider,
  type PlanTaskSnapshot,
  type RECONCILIATION_REASONS,
  type RuntimeStore,
  reconcileExecution,
  resumeExecution,
  type StepAttemptRecord,
  type StepCompletionSignal,
  startExecution,
  type WorkflowExecutionContext,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import type { PiArtifactProvider } from "./artifact-provider.js";
import type { PiDirectDispatchPort } from "./direct-dispatch.js";
import {
  makeCompletionRejectedFailure,
  makeInvariantViolationFailure,
  makeLeaseLostFailure,
  makeLifecycleEffectFailedFailure,
  makeLifecycleProjectionFailedFailure,
  mapPlanStateErrorToPiFailure,
  type PiAdapterFailure,
} from "./errors.js";
import {
  createWorkflowAttemptLinkage,
  type PiRecoveryPointerStore,
  type PiWeaveRecoveryPointerV1,
  type PiWorkflowAttemptLinkage,
} from "./recovery-pointer.js";
import type { Clock, IdGenerator, PiAdapterLogger } from "./types.js";

/**
 * A branded proof that a real, explicit user action authorized this call.
 * Only {@link authorizeByExplicitUser} can construct one, and only from a
 * literal `confirmed === true`. Command handlers built from a real
 * `ctx.ui.confirm(...)`/palette selection are the only legitimate source;
 * hooks, agents, tools, and lifecycle observations structurally cannot
 * obtain one.
 */
export interface AuthorizedByUser {
  readonly __brand: "weave-user-authorized";
}

export type PiReconciliationReason = (typeof RECONCILIATION_REASONS)[number];

const USER_AUTHORIZATION_TOKEN: AuthorizedByUser = {
  __brand: "weave-user-authorized",
};

/**
 * Fallback task for a legacy direct dispatch with no configured step prompt.
 * The activated descriptor prompt still arrives through the signed bootstrap
 * and becomes the child's system context; this task only starts the
 * turn without duplicating that potentially large prompt.
 */
const DEFAULT_DIRECT_STEP_TASK_PROMPT =
  "Execute the current workflow step according to your system instructions.";

/** Pi adapter contract: only an explicit `confirmed === true` from a real user action mints this token. Never call with a value derived from prompt text, agent output, or a hook/event payload. */
export function authorizeByExplicitUser(
  confirmed: boolean,
): Result<AuthorizedByUser, PiAdapterFailure> {
  if (!confirmed) {
    return err(
      makeInvariantViolationFailure(
        "start/resume requires explicit user confirmation",
      ),
    );
  }
  return ok(USER_AUTHORIZATION_TOKEN);
}

/**
 * True when a `dispatchStep` failure is a pinned artifact digest or plan
 * revision mismatch (Pi adapter contract) - the only condition that routes to
 * `reconcileExecution` with reason `"execution-mismatch"` instead of a bare
 * typed failure. This is a typed discriminant on the engine's own
 * `LifecycleError` shape (`policy_decision` with `rule ===
 * "artifact_integrity"`, raised by the engine's `verifyArtifactIntegrity` -
 * plans are tracked as artifacts with integrity digests, so a plan
 * mismatch routes through the same rule), never a string/message heuristic
 * (project rule: typed engine errors/effects only, never string
 * heuristics). A distinct rule, `"artifact_approval"`, means an approval
 * was invalidated - not an execution mismatch - and must not be folded in
 * here.
 */
function isArtifactMismatch(cause: LifecycleError): boolean {
  return (
    cause.type === "policy_decision" && cause.rule === "artifact_integrity"
  );
}

/**
 * Reduces a `LifecycleError` to a bounded, closed-vocabulary reason string
 * built only from the error's typed discriminant fields (`type`, `field`,
 * `entity`, `rule`, `cause.type`) - never `cause.message`. Engine
 * `LifecycleError.message` is free text that can embed persistence-layer
 * detail (e.g. absolute paths, driver text); it must never reach
 * `PiAdapterFailure.correlation`, which is safe-by-construction diagnostic
 * data (Pi adapter contract).
 */
function sanitizeLifecycleErrorReason(cause: LifecycleError): string {
  if (cause.type === "validation") {
    return cause.field !== undefined
      ? `validation:${cause.field}`
      : "validation";
  }
  if (cause.type === "not_found") return `not_found:${cause.entity}`;
  if (cause.type === "lease_conflict") return "lease_conflict";
  if (cause.type === "persistence") {
    return cause.cause !== undefined
      ? `persistence:${cause.cause.type}`
      : "persistence";
  }
  return cause.rule !== undefined
    ? `policy_decision:${cause.rule}`
    : "policy_decision";
}

/**
 * True when a prior revision of `name` in `artifacts` was approved and the
 * current (latest) revision is not - i.e. a newer, not-yet-approved
 * revision has silently superseded an approved one. Mirrors the engine's
 * own `isApprovalInvalidated` (`packages/engine/src/execution-lifecycle/
 * artifacts.ts`) exactly, using the same "last matching entry is latest"
 * convention, so the adapter never pins an artifact identity that would
 * cause the engine to *skip* a check it would otherwise correctly enforce.
 */
/**
 * The most recent {@link StepAttemptRecord} for `stepName`, or `undefined`
 * if the step has never been dispatched. Mirrors the engine's own
 * `latestAttemptForStep` (`packages/engine/src/execution-lifecycle/
 * artifacts.ts`) exactly - same "last matching entry in dispatch order is
 * latest" convention - so the adapter's retry-pin computation agrees with
 * what the engine would reuse by default if `pinnedArtifactRevisions` were
 * omitted (execution lifecycle contract).
 */
function latestStepAttempt(
  stepAttempts: readonly StepAttemptRecord[],
  stepName: string,
): StepAttemptRecord | undefined {
  let latest: StepAttemptRecord | undefined;
  for (const attempt of stepAttempts) {
    if (attempt.stepName === stepName) latest = attempt;
  }
  return latest;
}

function isApprovalInvalidatedForName(
  artifacts: readonly ArtifactRef[],
  name: string,
): boolean {
  const revisions = artifacts.filter((artifact) => artifact.name === name);
  if (revisions.length < 2) return false;
  const latest = revisions[revisions.length - 1];
  if (latest === undefined || latest.approvalState === "approved") {
    return false;
  }
  return revisions
    .slice(0, -1)
    .some((revision) => revision.approvalState === "approved");
}

export interface PiWorkflowControllerDeps {
  readonly store: RuntimeStore;
  readonly planStateProvider: PlanStateProvider;
  readonly artifactProvider: PiArtifactProvider;
  readonly directDispatch: PiDirectDispatchPort;
  readonly recoveryPointerStore: PiRecoveryPointerStore;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly logger: PiAdapterLogger;
  readonly controllerGenerationId: string;
  readonly harnessName?: string;
  /** Rechecks controller-generation staleness at an async boundary (bound from `PiOperationHandle.assertStillCurrent`). */
  readonly assertGenerationCurrent: () => Result<void, PiAdapterFailure>;
  readonly ownerId: string;
  readonly projectRoot: string;
  /** Bounded upper bound on auto-advance iterations within one call, closing any pathological infinite-effect loop. */
  readonly maxAutoAdvanceSteps?: number;
  /** Notifies the extension of direct-step activity with the exact normalized descriptor name, without depending on any Pi UI/event type. */
  readonly onDirectStepActiveChange?: (
    active: boolean,
    agentName: string,
  ) => void;
  /**
   * Notified after every dispatch, completion, plan-transition-bearing
   * completion, resume, and interrupt outcome that leaves the instance in
   * a new state (Pi adapter contract) - lets the extension refresh the bounded
   * compact plan widget without this class depending on any Pi UI type or
   * re-deriving "which plan is active" itself. Best-effort and read-only
   * from this class's perspective: it never reads plan state itself, only
   * signals that the caller's own next `inspect()`/`readPlanSnapshot()`
   * pair may now return something new. A no-op when undefined.
   */
  readonly onPlanSnapshotChanged?: (workflowInstanceId: string) => void;
  /** Cancels the currently in-flight direct-step child's underlying process, if any (Pi adapter contract). Distinct from ordinary delegation's `cancelSubtree` - direct-step children are never part of that tree. A no-op resolves `ok(undefined)` when nothing is active. */
  readonly cancelActiveDirectStepChild?: () => ResultAsync<
    void,
    PiAdapterFailure
  >;
  /**
   * Resolves a direct-step agent's own real descriptor (composed prompt,
   * models, delegation targets) from the adapter's own activated descriptor
   * catalog by name (Pi adapter contract) - parallel to how ordinary
   * delegation's `buildChildBootstrapBody` resolves from `target.name`.
   * The engine's own `RunAgentEffect.agentDescriptor` is deliberately never
   * used for this (its `composedPrompt` and `models` are empty/minimal - a
   * security invariant, not a bug).
   * Absent/returning `undefined` for a name the engine itself dispatched
   * is an adapter-catalog invariant violation and fails the dispatch
   * closed rather than silently sending an empty prompt.
   */
  readonly resolveAgentDescriptor?: (
    agentName: string,
  ) => AgentDescriptor | undefined;
}

export interface PiStartWorkflowInput {
  readonly workflowInstanceId: string;
  readonly context: WorkflowExecutionContext;
  readonly metadata?: Record<string, string | number | boolean>;
}

export interface PiResumeWorkflowInput {
  readonly workflowInstanceId: string;
  readonly context: WorkflowExecutionContext;
  readonly metadata?: Record<string, string | number | boolean>;
  /**
   * Explicit, user-authorized takeover correlation for one exact
   * pre-reload lease (Issue #21 S020). Populated only from a
   * durable recovery pointer's `leaseId`/`controllerGeneration` after the
   * pointer has been judged eligible and the user has freshly confirmed
   * `/weave:resume` - never automatically. Forwarded verbatim to the
   * engine's `resumeExecution`, which is the sole authority over whether
   * the takeover actually succeeds.
   */
  readonly recoveryTakeover?: {
    readonly expectedLeaseId: string;
    readonly expectedControllerGeneration: string;
  };
}

export interface PiRunResult {
  readonly workflowInstanceId: string;
  readonly leaseId?: string;
  readonly finalStatus:
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  readonly currentStepName?: string;
}

interface DispatchAgentEffect {
  readonly kind: "dispatch-agent";
  readonly runAgent: Extract<
    LifecycleEffect,
    { kind: "dispatch-agent" }
  >["runAgent"];
}

export class PiWorkflowController {
  /**
   * Set only while a direct-step agent has submitted a validated
   * `user_confirm`-method candidate that is withheld pending a genuine
   * `/weave:advance` (Pi adapter contract). Cleared the instant it is
   * released by {@link confirmStep}, so a replayed advance can never
   * settle the same signal twice. Never persisted - a fresh generation
   * (new `PiWorkflowController`) always starts with this undefined, so a
   * stale pending confirmation from a prior generation can never leak
   * forward.
   */
  private currentAttemptLinkage: PiWorkflowAttemptLinkage | undefined;

  private pendingUserConfirmation:
    | {
        workflowInstanceId: string;
        leaseId: string;
        agentName: string;
        context: WorkflowExecutionContext;
        stepName: string;
        signal: StepCompletionSignal;
        iteration: number;
        maxSteps: number;
      }
    | undefined;

  constructor(private readonly deps: PiWorkflowControllerDeps) {}

  /** Fires {@link PiWorkflowControllerDeps.onPlanSnapshotChanged} exactly once per outcome (Pi adapter contract) - a no-op when undefined. */
  private notifyPlanChanged(workflowInstanceId: string): void {
    this.deps.onPlanSnapshotChanged?.(workflowInstanceId);
  }

  /** Lifecycle op 1: adapter reports a normalized session observation. */
  observe(input: {
    workflowInstanceId: string;
    leaseId: string;
    harnessName: string;
    agentName: string;
    sessionStatus: "active" | "idle" | "terminated";
    stepName?: string;
    modelId?: string;
  }): ResultAsync<{ snapshotId: string }, PiAdapterFailure> {
    return observeSession(
      {
        workflowInstanceId: createWorkflowInstanceId(input.workflowInstanceId),
        leaseId: createExecutionLeaseId(input.leaseId),
        harnessName: input.harnessName,
        agentName: input.agentName,
        sessionStatus: input.sessionStatus,
        ...(input.stepName !== undefined ? { stepName: input.stepName } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      },
      this.deps.store,
    )
      .map((output) => ({ snapshotId: String(output.snapshotId) }))
      .mapErr((cause) =>
        this.mapLifecycleError(
          input.workflowInstanceId,
          "observeSession",
          cause,
        ),
      );
  }

  /** Best-effort observation: logs but never fails the caller - session observation is a diagnostic side channel, never a gate on real lifecycle progress. */
  private observeBestEffort(input: {
    workflowInstanceId: string;
    leaseId: string;
    agentName: string;
    sessionStatus: "active" | "idle" | "terminated";
    stepName?: string;
  }): ResultAsync<void, never> {
    return this.observe({
      ...input,
      harnessName: this.deps.harnessName ?? "pi",
    })
      .map(() => undefined)
      .orElse((failure) => {
        this.deps.logger.warn({ failure }, "observeSession failed; degrading");
        return ResultAsync.fromSafePromise(Promise.resolve(undefined));
      });
  }

  /** Lifecycle op 2: explicit-start only - requires {@link AuthorizedByUser}. */
  startExecution(
    input: PiStartWorkflowInput,
    authorization: AuthorizedByUser,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    void authorization; // type-level proof of explicit authorization; no runtime branching needed
    const generationCheck = this.deps.assertGenerationCurrent();
    if (generationCheck.isErr()) {
      return errAsync(generationCheck.error);
    }
    const attempt = this.ensureCurrentAttemptId();
    if (attempt.isErr()) return errAsync(attempt.error);
    return startExecution(
      {
        workflowInstanceId: createWorkflowInstanceId(input.workflowInstanceId),
        ownerId: createOwnerId(this.deps.ownerId),
        authorizationSource: "user",
        context: input.context,
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      this.deps.store,
    )
      .mapErr((cause) =>
        this.mapLifecycleError(
          input.workflowInstanceId,
          "startExecution",
          cause,
        ),
      )
      .andThen((output) =>
        this.observeBestEffort({
          workflowInstanceId: input.workflowInstanceId,
          leaseId: String(output.leaseId),
          agentName: input.context.workflowName,
          sessionStatus: "active",
        }).andThen(() =>
          this.runDispatchLoop(
            input.workflowInstanceId,
            String(output.leaseId),
            input.context,
          ).map((result) => {
            this.notifyPlanChanged(input.workflowInstanceId);
            return result;
          }),
        ),
      );
  }

  /** Lifecycle op 3: explicit-resume only - requires {@link AuthorizedByUser}; rebinds a fresh lease. */
  resumeExecution(
    input: PiResumeWorkflowInput,
    authorization: AuthorizedByUser,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    void authorization;
    const generationCheck = this.deps.assertGenerationCurrent();
    if (generationCheck.isErr()) {
      return errAsync(generationCheck.error);
    }
    const metadataAttemptId = input.metadata?.weaveResumeAttemptId;
    if (typeof metadataAttemptId === "string") {
      const linkage = createWorkflowAttemptLinkage(
        input.metadata?.weaveResumePreviousAttemptId as string | undefined,
        metadataAttemptId,
      );
      if (linkage.isErr())
        return errAsync(
          makeInvariantViolationFailure("invalid resume attempt linkage"),
        );
      this.currentAttemptLinkage = linkage.value;
    } else {
      const attempt = this.ensureCurrentAttemptId();
      if (attempt.isErr()) return errAsync(attempt.error);
    }
    return resumeExecution(
      {
        workflowInstanceId: createWorkflowInstanceId(input.workflowInstanceId),
        ownerId: createOwnerId(this.deps.ownerId),
        authorizationSource: "user",
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        ...(input.recoveryTakeover !== undefined
          ? {
              recoveryTakeover: {
                expectedLeaseId: createExecutionLeaseId(
                  input.recoveryTakeover.expectedLeaseId,
                ),
                expectedOwnerId: createOwnerId(
                  input.recoveryTakeover.expectedControllerGeneration,
                ),
              },
            }
          : {}),
      },
      this.deps.store,
    )
      .mapErr((cause) =>
        this.mapLifecycleError(
          input.workflowInstanceId,
          "resumeExecution",
          cause,
        ),
      )
      .andThen((output) =>
        this.observeBestEffort({
          workflowInstanceId: input.workflowInstanceId,
          leaseId: String(output.leaseId),
          agentName: input.context.workflowName,
          sessionStatus: "active",
        }).andThen(() =>
          this.runDispatchLoop(
            input.workflowInstanceId,
            String(output.leaseId),
            input.context,
          ).map((result) => {
            this.notifyPlanChanged(input.workflowInstanceId);
            return result;
          }),
        ),
      );
  }

  /** Lifecycle op 4: user-initiated interrupt. `signal: 'cancel'` maps from confirmed /weave:abort or Esc-on-direct-step-child; `signal: 'pause'` maps from a confirmed pause-before-delivering-a-parent-prompt choice. Never routes anything but pause/cancel. Also terminates any in-flight direct-step child - it is never part of the ordinary delegation tree, so the engine effect alone would leave its process running. */
  handleUserInterrupt(input: {
    workflowInstanceId: string;
    leaseId: string;
    signal: "cancel" | "pause";
  }): ResultAsync<{ effects: readonly LifecycleEffect[] }, PiAdapterFailure> {
    return handleUserInterrupt(
      {
        workflowInstanceId: createWorkflowInstanceId(input.workflowInstanceId),
        leaseId: createExecutionLeaseId(input.leaseId),
        signal: input.signal,
      },
      this.deps.store,
    )
      .map((output) => ({ effects: output.effects }))
      .mapErr((cause) =>
        this.mapLifecycleError(
          input.workflowInstanceId,
          "handleUserInterrupt",
          cause,
        ),
      )
      .andThen((result) =>
        this.applyNonDispatchEffects(result.effects)
          .andThen(
            () =>
              this.deps.cancelActiveDirectStepChild?.() ?? okAsync(undefined),
          )
          .andThen(() =>
            this.observeBestEffort({
              workflowInstanceId: input.workflowInstanceId,
              leaseId: input.leaseId,
              agentName: "workflow-controller",
              sessionStatus: input.signal === "cancel" ? "terminated" : "idle",
            }),
          )
          .map(() => {
            this.notifyPlanChanged(input.workflowInstanceId);
            return result;
          }),
      );
  }

  /** Lifecycle op 8: read-only, no side effects - safe for status/palette/recovery-banner/artifacts widgets. */
  inspect(
    workflowInstanceId: string,
  ): ResultAsync<InspectExecutionOutput, PiAdapterFailure> {
    return inspectExecution(
      { workflowInstanceId: createWorkflowInstanceId(workflowInstanceId) },
      this.deps.store,
    ).mapErr((cause) =>
      this.mapLifecycleError(workflowInstanceId, "inspectExecution", cause),
    );
  }

  /** Lifecycle op 9: explicit user artifact action, or an authorized structured review/security gate verdict. Self-approval and revision/digest mismatch are engine-owned; this method only recomputes the current digest before delegating. */
  approveArtifact(input: {
    workflowInstanceId: string;
    leaseId: string;
    artifactId: string;
    approvalState: "approved" | "rejected";
    actor: ArtifactApprovalActor;
    expectedRevision: number;
    relativePathForDigest?: string;
    context?: WorkflowExecutionContext;
  }): ResultAsync<{ instanceStatus: string }, PiAdapterFailure> {
    const digestStep: ResultAsync<string | undefined, PiAdapterFailure> =
      input.relativePathForDigest === undefined
        ? okAsync(undefined)
        : this.deps.artifactProvider
            .readAndDigest({
              projectRoot: this.deps.projectRoot,
              relativePath: input.relativePathForDigest,
            })
            .map((digest) => digest.digest);

    return digestStep.andThen((expectedDigest) =>
      approveArtifact(
        {
          workflowInstanceId: createWorkflowInstanceId(
            input.workflowInstanceId,
          ),
          leaseId: createExecutionLeaseId(input.leaseId),
          artifactId: createArtifactId(input.artifactId),
          approvalState: input.approvalState,
          actor: input.actor,
          expectedRevision: input.expectedRevision,
          ...(expectedDigest !== undefined ? { expectedDigest } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
        },
        this.deps.store,
      )
        .map((output) => ({ instanceStatus: output.instance.status }))
        .mapErr((cause) =>
          this.mapLifecycleError(
            input.workflowInstanceId,
            "approveArtifact",
            cause,
          ),
        ),
    );
  }

  /** Lifecycle op 10: routes a typed mismatch/rejection to its authorized handler (pinned artifact digest/revision mismatch, plan mismatch, explicit user revision request, review rejection, security rejection), applying returned effects exactly once. */
  reconcile(input: {
    workflowInstanceId: string;
    leaseId: string;
    reason: PiReconciliationReason;
    authorizationSource: "user" | "runtime" | "review-gate" | "security-gate";
    context?: WorkflowExecutionContext;
  }): ResultAsync<{ effects: readonly LifecycleEffect[] }, PiAdapterFailure> {
    return reconcileExecution(
      {
        workflowInstanceId: createWorkflowInstanceId(input.workflowInstanceId),
        leaseId: createExecutionLeaseId(input.leaseId),
        reason: input.reason,
        authorizationSource: input.authorizationSource,
        planStateProvider: this.deps.planStateProvider,
        ...(input.context !== undefined ? { context: input.context } : {}),
      },
      this.deps.store,
    )
      .mapErr((cause) =>
        this.mapLifecycleError(
          input.workflowInstanceId,
          "reconcileExecution",
          cause,
        ),
      )
      .andThen((output) =>
        this.applyReconciliationEffects(
          input.workflowInstanceId,
          input.leaseId,
          input.context,
          output,
        ).map(() => {
          this.notifyPlanChanged(input.workflowInstanceId);
          return { effects: output.effects };
        }),
      );
  }

  /**
   * Applies every effect `reconcileExecution` returns exactly once (Pi adapter contract
   *) - including a `dispatch-agent` effect, which `applyNonDispatchEffects`
   * alone cannot project (a redirect to an earlier step's declared
   * `reconciliation_handlers` entry is exactly this shape). Falls back to
   * `applyNonDispatchEffects`'s warn-and-drop only when no
   * `WorkflowExecutionContext` was supplied to `reconcile()` - dispatching a
   * fresh agent turn is impossible without one, and this is logged rather
   * than silently swallowed.
   */
  private applyReconciliationEffects(
    workflowInstanceId: string,
    leaseId: string,
    context: WorkflowExecutionContext | undefined,
    output: {
      readonly effects: readonly LifecycleEffect[];
      readonly handlerStepName?: string;
      readonly gateReRunStepName?: string;
      readonly stepPromptText?: string;
    },
  ): ResultAsync<void, PiAdapterFailure> {
    const dispatchEffect = output.effects.find(
      (effect): effect is DispatchAgentEffect =>
        effect.kind === "dispatch-agent",
    );
    if (dispatchEffect === undefined) {
      return this.applyNonDispatchEffects(output.effects);
    }
    if (context === undefined) {
      this.deps.logger.warn(
        {},
        "reconcileExecution returned a dispatch-agent effect but no WorkflowExecutionContext was supplied; cannot project it (Pi adapter contract)",
      );
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }
    const stepName =
      output.handlerStepName ?? output.gateReRunStepName ?? "unknown";
    return this.runDispatchAgentEffect(
      workflowInstanceId,
      leaseId,
      context,
      dispatchEffect,
      stepName,
      0,
      this.deps.maxAutoAdvanceSteps ?? 50,
      output.stepPromptText,
    ).map(() => undefined);
  }

  /**
   * A `review_verdict` rejection is always handled internally by `completeStep`
   * itself (`applyGateRejection`'s pause/fail/retry per `on_reject`) - no
   * schema field distinguishes a review gate from a security gate, so this is
   * an *additional*, optional, discriminant-driven `reconcile()` call layered
   * afterward, used only to let an *earlier* step's declared
   * `reconciliation_handlers` entry redirect execution (something `on_reject`
   * alone cannot do). Scans every other step in the workflow: if exactly one
   * of `"review-rejection"`/`"security-rejection"` has a declared handler
   * anywhere, reconciles under that reason with its fixed authorization
   * source; if both or neither are declared, skips the extra call and relies
   * solely on `completeStep`'s own effects (logged, never silently dropped).
   * Never a string/name heuristic on the rejecting step itself.
   */
  private maybeReconcileReviewRejection(
    workflowInstanceId: string,
    leaseId: string,
    context: WorkflowExecutionContext,
    stepName: string,
    signal: StepCompletionSignal,
  ): ResultAsync<void, never> {
    if (signal.method !== "review_verdict" || signal.approved !== false) {
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }
    const steps = context.workflows[context.workflowName]?.steps ?? [];
    const hasHandlerFor = (
      reason: "review-rejection" | "security-rejection",
    ): boolean =>
      steps.some(
        (step) =>
          step.name !== stepName &&
          step.reconciliation_handlers?.some(
            (handler) => handler.reason === reason,
          ) === true,
      );
    const reviewDeclared = hasHandlerFor("review-rejection");
    const securityDeclared = hasHandlerFor("security-rejection");
    let reason: "review-rejection" | "security-rejection" | undefined;
    if (reviewDeclared && !securityDeclared) reason = "review-rejection";
    else if (securityDeclared && !reviewDeclared) reason = "security-rejection";
    if (reason === undefined) {
      this.deps.logger.warn(
        { stepName, reviewDeclared, securityDeclared },
        "review_verdict rejection has no unambiguous review-rejection/security-rejection reconciliation_handlers declaration; relying solely on completeStep's own on_reject effects",
      );
      return ResultAsync.fromSafePromise(Promise.resolve(undefined));
    }
    const authorizationSource =
      reason === "review-rejection" ? "review-gate" : "security-gate";
    return this.reconcile({
      workflowInstanceId,
      leaseId,
      reason,
      authorizationSource,
      context,
    })
      .map(() => undefined)
      .orElse((failure) => {
        this.deps.logger.warn(
          { err: failure },
          "optional review/security-rejection reconcile() call failed; completeStep's own effects were already applied",
        );
        return ResultAsync.fromSafePromise(Promise.resolve(undefined));
      });
  }

  /** Read-only recovery pointer projection for a startup banner (Pi adapter contract). Never triggers resume - the caller must still obtain fresh {@link AuthorizedByUser} authorization via `/weave:resume`. */
  readRecoveryPointer(): ResultAsync<
    PiWeaveRecoveryPointerV1 | undefined,
    PiAdapterFailure
  > {
    return this.deps.recoveryPointerStore.readLatestPointer();
  }

  /**
   * Read-only plan snapshot projection for `/weave:plan` (Pi adapter contract).
   * Thin passthrough to the injected `PlanStateProvider.readSnapshot` -
   * never reimplements plan parsing/CAS logic; only maps the engine's
   * `PlanStateError` onto this adapter's closed failure taxonomy. Never
   * mutates anything.
   */
  readPlanSnapshot(
    planName: string,
  ): ResultAsync<PlanTaskSnapshot, PiAdapterFailure> {
    return this.deps.planStateProvider
      .readSnapshot(planName)
      .mapErr((error: PlanStateError) => mapPlanStateErrorToPiFailure(error));
  }

  /**
   * Internal dispatch loop shared by `startExecution`/`resumeExecution`.
   * Bare `startExecution`/`resumeExecution` never emit a `dispatch-agent`
   * effect themselves (proven by the engine's own integration tests: their
   * `effects` is always `[]`), so this calls `dispatchStep` exactly **once**
   * to obtain the first effect. Every subsequent step within this same call
   * is driven exclusively by whatever `dispatch-agent` effect
   * `completeStep` itself returns (see {@link runDispatchAgentEffect}) -
   * `dispatchStep` is never invoked a second time for a step `completeStep`
   * already advanced past.
   */
  private runDispatchLoop(
    workflowInstanceId: string,
    leaseId: string,
    context: WorkflowExecutionContext,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    const maxSteps = this.deps.maxAutoAdvanceSteps ?? 50;
    const generationCheck = this.deps.assertGenerationCurrent();
    if (generationCheck.isErr()) return errAsync(generationCheck.error);

    return this.inspect(workflowInstanceId).andThen((snapshot) => {
      if (snapshot.status !== "running") {
        return okAsync<PiRunResult, PiAdapterFailure>({
          workflowInstanceId,
          leaseId,
          finalStatus: this.mapInstanceStatusToFinal(snapshot.status),
          ...(snapshot.currentStepName !== undefined
            ? { currentStepName: snapshot.currentStepName }
            : {}),
        });
      }
      if (snapshot.currentStepName === undefined) {
        return errAsync(
          makeLifecycleProjectionFailedFailure(
            workflowInstanceId,
            "dispatchStep",
            "running instance has no currentStepName",
          ),
        );
      }
      const stepName = snapshot.currentStepName;
      const pinnedArtifactRevisions = this.computePinnedArtifactRevisions(
        snapshot.artifacts,
        this.resolveDeclaredArtifactInputNames(context, stepName),
        snapshot.stepAttempts,
        stepName,
      );
      return this.computeArtifactDigests(snapshot)
        .andThen((artifactDigests) =>
          dispatchStep(
            {
              workflowInstanceId: createWorkflowInstanceId(workflowInstanceId),
              leaseId: createExecutionLeaseId(leaseId),
              stepName,
              context,
              ...(Object.keys(artifactDigests).length > 0
                ? { artifactDigests }
                : {}),
              ...(pinnedArtifactRevisions.length > 0
                ? { pinnedArtifactRevisions }
                : {}),
            },
            this.deps.store,
          ).orElse((cause) =>
            this.handleDispatchStepFailure(workflowInstanceId, leaseId, cause),
          ),
        )
        .andThen((dispatchOutput) => {
          const dispatchEffect = dispatchOutput.effects.find(
            (effect): effect is DispatchAgentEffect =>
              effect.kind === "dispatch-agent",
          );
          if (dispatchEffect === undefined) {
            return okAsync<PiRunResult, PiAdapterFailure>({
              workflowInstanceId,
              leaseId,
              finalStatus: "running",
              currentStepName: dispatchOutput.stepName,
            });
          }
          return this.runDispatchAgentEffect(
            workflowInstanceId,
            leaseId,
            context,
            dispatchEffect,
            dispatchOutput.stepName,
            0,
            maxSteps,
            dispatchOutput.stepPromptText,
          );
        });
    });
  }

  /** Maps a `dispatchStep` failure caused by a pinned artifact digest/revision mismatch (Pi adapter contract) to `reconcileExecution` with reason `"execution-mismatch"` instead of silently rebinding; every other cause returns the bare typed failure unchanged. */
  private handleDispatchStepFailure(
    workflowInstanceId: string,
    leaseId: string,
    cause: LifecycleError,
  ): ResultAsync<never, PiAdapterFailure> {
    const mapped = this.mapLifecycleError(
      workflowInstanceId,
      "dispatchStep",
      cause,
    );
    if (!isArtifactMismatch(cause)) return errAsync(mapped);
    return reconcileExecution(
      {
        workflowInstanceId: createWorkflowInstanceId(workflowInstanceId),
        leaseId: createExecutionLeaseId(leaseId),
        reason: "execution-mismatch",
        authorizationSource: "runtime",
        planStateProvider: this.deps.planStateProvider,
      },
      this.deps.store,
    )
      .andThen((output) => this.applyNonDispatchEffects(output.effects))
      .orElse(() => ResultAsync.fromSafePromise(Promise.resolve(undefined)))
      .andThen(() => errAsync<never, PiAdapterFailure>(mapped));
  }

  private mapInstanceStatusToFinal(
    status: InspectExecutionOutput["status"],
  ): PiRunResult["finalStatus"] {
    if (
      status === "paused" ||
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      return status;
    }
    return "running";
  }

  /**
   * Projects exactly one `dispatch-agent` effect: spawns the direct-step
   * child, validates its one structured completion candidate, and calls
   * `completeStep`. If `completeStep` itself returns a further
   * `dispatch-agent` effect under the Pi adapter contract (auto-advance), this recurses
   * directly on *that* effect - it never calls `dispatchStep` again for the
   * step the engine already advanced past.
   */
  private runDispatchAgentEffect(
    workflowInstanceId: string,
    leaseId: string,
    context: WorkflowExecutionContext,
    dispatchEffect: DispatchAgentEffect,
    stepName: string,
    iteration: number,
    maxSteps: number,
    /**
     * EPHEMERAL rendered `step.prompt` text for `stepName`, threaded in
     * from the engine's `stepPromptText` output field (never from any
     * `LifecycleEffect`). `undefined` for legacy/fallback dispatch, which
     * has no configured `step.prompt` to render.
     */
    stepPromptText: string | undefined,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    if (iteration >= maxSteps) {
      return errAsync(
        makeLifecycleEffectFailedFailure(
          workflowInstanceId,
          "dispatch-agent",
          "max-auto-advance-exceeded",
        ),
      );
    }
    const generationCheck = this.deps.assertGenerationCurrent();
    if (generationCheck.isErr()) return errAsync(generationCheck.error);

    // Resolve the real descriptor (composed prompt, models, delegation
    // targets) from the adapter's own activated catalog - never from
    // `dispatchEffect.runAgent.agentDescriptor`, whose corresponding fields
    // are deliberately empty/minimal (engine security invariant: raw prompt
    // text never travels in an effect). A name the engine itself dispatched but the adapter's own
    // catalog does not recognise is an adapter-catalog invariant
    // violation, not a degraded-but-safe case - fail closed rather than
    // silently spawn a child with an empty prompt and no governed tools.
    const realDescriptor = this.deps.resolveAgentDescriptor?.(
      dispatchEffect.runAgent.agentName,
    );
    if (realDescriptor === undefined) {
      return errAsync(
        makeLifecycleEffectFailedFailure(
          workflowInstanceId,
          "dispatch-agent",
          "agent-descriptor-not-found",
        ),
      );
    }

    const models = [...realDescriptor.models];
    const delegationTargets = realDescriptor.delegationTargets.map(
      (target) => ({
        name: target.name,
        ...(target.description === undefined
          ? {}
          : { description: target.description }),
        triggers: [...target.triggers],
        isCategory: target.isCategory,
      }),
    );

    this.deps.onDirectStepActiveChange?.(true, realDescriptor.name);
    const settleActive = (): void =>
      this.deps.onDirectStepActiveChange?.(false, realDescriptor.name);

    return this.observeBestEffort({
      workflowInstanceId,
      leaseId,
      agentName: dispatchEffect.runAgent.agentName,
      sessionStatus: "active",
      stepName,
    })
      .andThen(() =>
        this.deps.directDispatch.dispatch({
          workflowInstanceId,
          leaseId,
          stepName,
          agentName: dispatchEffect.runAgent.agentName,
          composedPrompt: realDescriptor.composedPrompt,
          taskPrompt: stepPromptText ?? DEFAULT_DIRECT_STEP_TASK_PROMPT,
          models,
          delegationTargets,
          ...(realDescriptor.fast === true ? { fast: true as const } : {}),
          cwd: this.deps.projectRoot,
          correlationId:
            dispatchEffect.runAgent.correlationId ??
            this.deps.idGenerator.next(),
        }),
      )
      .map((candidate) => {
        settleActive();
        return candidate;
      })
      .orElse((failure) => {
        settleActive();
        return errAsync<never, PiAdapterFailure>(failure);
      })
      .andThen((candidate) => {
        const generationCheck2 = this.deps.assertGenerationCurrent();
        if (generationCheck2.isErr()) return errAsync(generationCheck2.error);
        // Project only the normalized StepCompletionSignal fields. The
        // authenticated agent_settled boundary has already selected this one
        // structured candidate; transcript, finalOutput/summary,
        // intervention text/count, thinking, tool, and UI payloads are not
        // workflow metadata and must not cross into completeStep.
        const signal: StepCompletionSignal = {
          outcome: candidate.outcome,
          ...(candidate.method !== undefined
            ? { method: candidate.method }
            : {}),
          ...(candidate.approved !== undefined
            ? { approved: candidate.approved }
            : {}),
          ...(candidate.message !== undefined
            ? { message: candidate.message }
            : {}),
          ...(candidate.nextStepHint !== undefined
            ? { nextStepHint: candidate.nextStepHint }
            : {}),
          ...(candidate.artifacts !== undefined
            ? { artifacts: candidate.artifacts }
            : {}),
        };
        // Record the idle observation now, while `leaseId` still
        // references a live lease - `completeStep` (called below) releases
        // and, for a terminal step, deletes it (#21).
        return this.observeBestEffort({
          workflowInstanceId,
          leaseId,
          agentName: dispatchEffect.runAgent.agentName,
          sessionStatus: "idle",
          stepName,
        }).andThen(() => {
          // Pi adapter contract: `user_confirm` requires an explicit
          // `/weave:advance` (-> {@link confirmStep}) to release - an
          // agent-supplied candidate alone is never enough.
          if (signal.method === "user_confirm") {
            this.pendingUserConfirmation = {
              workflowInstanceId,
              leaseId,
              agentName: dispatchEffect.runAgent.agentName,
              context,
              stepName,
              signal,
              iteration,
              maxSteps,
            };
            return okAsync<PiRunResult, PiAdapterFailure>({
              workflowInstanceId,
              leaseId,
              finalStatus: "running",
              currentStepName: stepName,
            });
          }
          return this.settleCompletionSignal(
            workflowInstanceId,
            leaseId,
            context,
            stepName,
            signal,
            iteration,
            maxSteps,
          );
        });
      });
  }

  /**
   * `/weave:advance` (Pi adapter contract): the ONLY caller that may release a
   * pending `user_confirm` completion signal - requires a fresh
   * {@link AuthorizedByUser} token, never prose/idle/continuation. A no-op
   * candidate is never fabricated here: this only ever forwards the exact
   * validated signal the direct-step agent already produced via
   * `weave_complete_step` (Pi adapter contract candidate protocol preserved -
   * `/weave:advance` gates *release*, it never invents a substitute
   * candidate). Returns a typed failure - never a silent no-op - when no
   * step is currently awaiting confirmation, or when it targets a
   * different instance/lease than the one actually pending (stale advance
   * after e.g. an intervening abort).
   */
  confirmStep(
    input: { workflowInstanceId: string; leaseId: string },
    authorization: AuthorizedByUser,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    void authorization;
    const generationCheck = this.deps.assertGenerationCurrent();
    if (generationCheck.isErr()) return errAsync(generationCheck.error);
    const pending = this.pendingUserConfirmation;
    if (
      pending === undefined ||
      pending.workflowInstanceId !== input.workflowInstanceId ||
      pending.leaseId !== input.leaseId
    ) {
      return errAsync(
        makeLifecycleProjectionFailedFailure(
          input.workflowInstanceId,
          "confirmStep",
          "no step is currently awaiting user confirmation",
        ),
      );
    }
    // Clear immediately (before settling) so a replayed/duplicate
    // `/weave:advance` can never release the same signal twice.
    this.pendingUserConfirmation = undefined;
    return this.settleCompletionSignal(
      pending.workflowInstanceId,
      pending.leaseId,
      pending.context,
      pending.stepName,
      pending.signal,
      pending.iteration,
      pending.maxSteps,
    ).map((result) => {
      this.notifyPlanChanged(pending.workflowInstanceId);
      return result;
    });
  }

  /**
   * Shared tail of the direct-step dispatch loop: calls `completeStep`
   * exactly once with an already-validated {@link StepCompletionSignal},
   * appends the recovery pointer, applies the optional review/security-
   * rejection reconciliation, and projects completeStep's own returned
   * effects (pause/complete/auto-advance) exactly once (Pi adapter contract).
   * The idle observation already fired in {@link runDispatchAgentEffect}
   * before this `completeStep` call, so a terminal step's lease release
   * never races it (#21). Shared by the immediate
   * non-`user_confirm` path in {@link runDispatchAgentEffect} and by
   * {@link confirmStep}.
   */
  private settleCompletionSignal(
    workflowInstanceId: string,
    leaseId: string,
    context: WorkflowExecutionContext,
    stepName: string,
    signal: StepCompletionSignal,
    iteration: number,
    maxSteps: number,
  ): ResultAsync<PiRunResult, PiAdapterFailure> {
    return completeStep(
      {
        workflowInstanceId: createWorkflowInstanceId(workflowInstanceId),
        leaseId: createExecutionLeaseId(leaseId),
        stepName,
        completionSignal: signal,
        context,
        planStateProvider: this.deps.planStateProvider,
      },
      this.deps.store,
    )
      .mapErr((cause) =>
        this.mapCompletionError(workflowInstanceId, stepName, cause),
      )
      .andThen((completeOutput) =>
        // No idle observation here - it already fired in
        // {@link runDispatchAgentEffect} before `leaseId` could be released
        // (#21).
        this.appendRecoveryPointer(workflowInstanceId, leaseId)
          .andThen(() =>
            this.maybeReconcileReviewRejection(
              workflowInstanceId,
              leaseId,
              context,
              stepName,
              signal,
            ),
          )
          .map(() => ({
            effects: completeOutput.effects,
            stepPromptText: completeOutput.stepPromptText,
          })),
      )
      .andThen(({ effects, stepPromptText }) => {
        const pause = effects.find(
          (effect) => effect.kind === "pause-execution",
        );
        if (pause !== undefined) {
          return okAsync<PiRunResult, PiAdapterFailure>({
            workflowInstanceId,
            leaseId,
            finalStatus: "paused",
            currentStepName: stepName,
          });
        }
        const complete = effects.find(
          (effect) => effect.kind === "complete-execution",
        );
        if (complete !== undefined) {
          return okAsync<PiRunResult, PiAdapterFailure>({
            workflowInstanceId,
            leaseId,
            finalStatus: "completed",
            currentStepName: stepName,
          });
        }
        const nextDispatch = effects.find(
          (effect): effect is DispatchAgentEffect =>
            effect.kind === "dispatch-agent",
        );
        if (nextDispatch === undefined) {
          return okAsync<PiRunResult, PiAdapterFailure>({
            workflowInstanceId,
            leaseId,
            finalStatus: "running",
            currentStepName: stepName,
          });
        }
        // completeStep itself returned the next dispatch - apply *that*
        // exact effect, never re-derive one via a redundant dispatchStep
        // call (Pi adapter contract: apply each returned effect exactly once). The
        // effect's `runAgent.agentName` is the *agent* assigned to the next
        // step, not necessarily the step's own name, so the authoritative
        // step name is read back from the instance completeStep just
        // advanced rather than guessed from the effect.
        return this.inspect(workflowInstanceId).andThen((freshSnapshot) => {
          if (freshSnapshot.currentStepName === undefined) {
            return errAsync<PiRunResult, PiAdapterFailure>(
              makeLifecycleProjectionFailedFailure(
                workflowInstanceId,
                "completeStep",
                "auto-advanced instance has no currentStepName",
              ),
            );
          }
          return this.runDispatchAgentEffect(
            workflowInstanceId,
            leaseId,
            context,
            nextDispatch,
            freshSnapshot.currentStepName,
            iteration + 1,
            maxSteps,
            stepPromptText,
          );
        });
      });
  }

  /**
   * Determines the *exact* required `pinnedArtifactRevisions` for a step's
   * declared inputs before dispatch (Pi adapter contract: "recompute required
   * digests AND pass pinned revisions").
   *
   * Retry-safe by construction (execution lifecycle contract: "reuse the same consumed
   * artifact revisions on retry by default"; Non-Goal 5: "This spec does
   * not allow silent rebinding to newer approved artifacts during retry or
   * reconciliation"): for each declared input name, this first looks for
   * the step's most recent prior attempt in `stepAttempts` (mirroring the
   * engine's own `latestAttemptForStep` - packages/engine/src/
   * execution-lifecycle/artifacts.ts - "last matching entry wins"
   * convention exactly). If a prior attempt consumed that name, its exact
   * `{artifactId, name, revision}` is reused verbatim - regardless of
   * whether a newer revision has since appeared or even been approved.
   * Pinning the *current latest* revision unconditionally here (as a
   * cruder implementation might) would silently rebind a running step to
   * different content than it originally consumed every time it retries,
   * which is exactly the automatic-rebinding behavior Non-Goal 5
   * forbids - rebinding is only ever done by an explicit workflow
   * transition (reconciliation).
   *
   * Only a name with **no** prior consumed record (this step's first
   * attempt, or a declared input added since the last attempt) falls back
   * to pinning the current latest revision - matching the engine's own
   * `buildConsumedArtifacts` first-attempt fallback. In that fallback path
   * only, an input whose latest revision has an *invalidated* approval (a
   * newer, not-yet-approved revision superseded a previously-approved one,
   * per {@link isApprovalInvalidatedForName}) is deliberately left
   * unpinned. Pinning it would flip on the engine's pinned-name skip of
   * its own approval-invalidation check (`validateStepInputs`), silently
   * letting an unapproved revision through - exactly the
   * "artifact_approval" condition {@link isArtifactMismatch}'s doc
   * explicitly says must not be folded into execution-mismatch handling.
   * Leaving it unpinned lets `dispatchStep` apply its normal, correct,
   * fail-closed check instead.
   *
   * Digest integrity (tamper detection) is independent of pinning -
   * {@link computeArtifactDigests} always recomputes it, and the engine's
   * `verifyArtifactIntegrity` always enforces it regardless of pin status.
   * A retry pin whose reused revision no longer matches recomputed bytes
   * fails closed via the pinned-digest mismatch path (Pi adapter contract) instead
   * of silently rebinding to whatever newer revision now matches.
   */
  private computePinnedArtifactRevisions(
    artifacts: readonly ArtifactRef[],
    declaredInputNames: readonly string[],
    stepAttempts: readonly StepAttemptRecord[],
    stepName: string,
  ): readonly ConsumedArtifactRecord[] {
    const priorAttempt = latestStepAttempt(stepAttempts, stepName);
    const priorConsumedByName = new Map(
      (priorAttempt?.consumedArtifacts ?? []).map((record) => [
        record.name,
        record,
      ]),
    );

    const pins: ConsumedArtifactRecord[] = [];
    for (const name of declaredInputNames) {
      const priorPin = priorConsumedByName.get(name);
      if (priorPin !== undefined) {
        pins.push(priorPin);
        continue;
      }
      if (isApprovalInvalidatedForName(artifacts, name)) continue;
      const revisions = artifacts.filter((artifact) => artifact.name === name);
      const latest = revisions[revisions.length - 1];
      if (latest === undefined) continue;
      pins.push({
        artifactId: latest.id,
        name: latest.name,
        revision: latest.revision,
      });
    }
    return pins;
  }

  /** Reads a step's declared artifact-input names straight from the composed `WorkflowExecutionContext` - never from prose or agent output. Missing workflow/step/inputs all degrade to an empty list (no pins to compute), matching `dispatchStep`'s own tolerant lookups. */
  private resolveDeclaredArtifactInputNames(
    context: WorkflowExecutionContext,
    stepName: string,
  ): readonly string[] {
    const steps = context.workflows[context.workflowName]?.steps ?? [];
    const step = steps.find((candidate) => candidate.name === stepName);
    return step?.inputs?.map((input) => input.name) ?? [];
  }

  private computeArtifactDigests(
    snapshot: InspectExecutionOutput,
  ): ResultAsync<Record<string, string>, PiAdapterFailure> {
    if (snapshot.artifacts.length === 0) {
      return ResultAsync.fromSafePromise(Promise.resolve({}));
    }
    return ResultAsync.combine(
      snapshot.artifacts.map((artifact) =>
        this.deps.artifactProvider
          .readAndDigest({
            projectRoot: this.deps.projectRoot,
            relativePath: artifact.path,
          })
          .map((digest) => [artifact.name, digest.digest] as const),
      ),
    ).map((pairs) => Object.fromEntries(pairs));
  }

  /** Applies pause/complete effects returned outside the dispatch loop (interrupt/reconcile) - never a dispatch-agent effect, which only the dispatch loop is authorized to project. */
  private applyNonDispatchEffects(
    effects: readonly LifecycleEffect[],
  ): ResultAsync<void, PiAdapterFailure> {
    for (const effect of effects) {
      if (effect.kind === "dispatch-agent") {
        this.deps.logger.warn(
          { effectKind: effect.kind },
          "unexpected dispatch-agent effect outside the dispatch loop; ignoring",
        );
      }
    }
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  }

  private ensureCurrentAttemptId(): Result<string, PiAdapterFailure> {
    if (this.currentAttemptLinkage !== undefined) {
      return ok(this.currentAttemptLinkage.attemptId);
    }
    const linkage = createWorkflowAttemptLinkage(undefined);
    if (linkage.isErr()) {
      return err(
        makeInvariantViolationFailure(
          "could not create workflow attempt linkage",
        ),
      );
    }
    this.currentAttemptLinkage = linkage.value;
    return ok(linkage.value.attemptId);
  }

  private appendRecoveryPointer(
    workflowInstanceId: string,
    leaseId: string,
  ): ResultAsync<void, PiAdapterFailure> {
    const pointer: PiWeaveRecoveryPointerV1 = {
      schemaVersion: 1,
      workflowId: workflowInstanceId,
      leaseId,
      controllerGeneration: this.deps.controllerGenerationId,
      ...(this.currentAttemptLinkage !== undefined
        ? { attempt: this.currentAttemptLinkage }
        : {}),
      status: "recoverable",
      observedAt: new Date(this.deps.clock.now()).toISOString(),
    };
    // A pointer-append failure degrades telemetry only; it must never roll
    // back or repeat the Runtime Store commit that already succeeded.
    return this.deps.recoveryPointerStore
      .appendPointer(pointer)
      .orElse((failure) => {
        this.deps.logger.warn(
          { failure },
          "recovery pointer append failed; degrading telemetry only",
        );
        return ResultAsync.fromSafePromise(Promise.resolve(undefined));
      });
  }

  /**
   * Maps a `LifecycleError` to a `PiAdapterFailure` using only
   * {@link sanitizeLifecycleErrorReason}'s bounded discriminant-derived
   * reason - the engine's free-text `cause.message` never reaches
   * `correlation` (Pi adapter contract).
   */
  private mapLifecycleError(
    workflowInstanceId: string,
    operation: string,
    cause: LifecycleError,
  ): PiAdapterFailure {
    if (cause.type === "lease_conflict") {
      return makeLeaseLostFailure(
        workflowInstanceId,
        sanitizeLifecycleErrorReason(cause),
      );
    }
    return makeLifecycleProjectionFailedFailure(
      workflowInstanceId,
      operation,
      sanitizeLifecycleErrorReason(cause),
    );
  }

  /**
   * `completeStep` failures get their own mapping: a `policy_decision`
   * rejection of the candidate itself (as opposed to a lease/persistence
   * problem) is a distinct `CompletionRejected` failure, not a generic
   * projection failure. Every branch uses only
   * {@link sanitizeLifecycleErrorReason}'s bounded reason - never
   * `cause.message` (Pi adapter contract).
   */
  private mapCompletionError(
    workflowInstanceId: string,
    stepName: string,
    cause: LifecycleError,
  ): PiAdapterFailure {
    if (cause.type === "lease_conflict") {
      return makeLeaseLostFailure(
        workflowInstanceId,
        sanitizeLifecycleErrorReason(cause),
      );
    }
    if (cause.type === "policy_decision") {
      return makeCompletionRejectedFailure(
        stepName,
        sanitizeLifecycleErrorReason(cause),
      );
    }
    return makeLifecycleProjectionFailedFailure(
      workflowInstanceId,
      "completeStep",
      sanitizeLifecycleErrorReason(cause),
    );
  }
}
