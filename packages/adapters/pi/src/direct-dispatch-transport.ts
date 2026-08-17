/**
 * Production `DirectDispatchTransport` (Pi adapter contract). Spawns a
 * fresh, ephemeral, single-use `PiRpcChild` for exactly one workflow step -
 * this deliberately bypasses `PiDelegationController`'s ordinary-delegation
 * budget/queue entirely, since direct workflow-step dispatch is a distinct
 * engine effect, not ordinary delegation. It reuses the same low-level
 * private child transport class (`PiRpcChild`) rather than a second
 * protocol implementation.
 */
import { dirname } from "node:path";
import type { ThinkingLevelDecl } from "@weaveio/weave-core";
import type { DelegationTarget } from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import { toModelIdentityBody } from "./child-control-bodies.js";
import type { HmacPort, RandomPort } from "./child-crypto.js";
import type { PiNativeSessionRecord } from "./child-native-sessions.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import type {
  AppendChildRefLifecycleInput,
  PiChildRefRecord,
} from "./child-session-refs.js";
import {
  describeChildSessionStorageUnavailable,
  type PiChildSessionStorageAuthority,
} from "./child-session-storage-authority.js";
import {
  PI_CHILD_TITLE_PROVENANCE,
  resolveDurableChildTitle,
} from "./child-title.js";
import { type PiChildInspectionRegistry, ROOT_NODE_ID } from "./child-tree.js";
import type {
  PiAuthenticatedDelegationRequest,
  PiThreadRefPort,
  PiThreadSessionPort,
} from "./delegation-controller.js";
import type {
  DirectDispatchSettlement,
  DirectDispatchTransport,
  PiDirectDispatchInput,
} from "./direct-dispatch.js";
import {
  makeChildAbortFailedFailure,
  makeChildRecordCorruptFailure,
  makeChildRecordQuarantinedFailure,
  makeChildRecordQuotaExceededFailure,
  makeChildRecoveryUnavailableFailure,
  makeChildSpawnFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { type PiModelInfo, PiModelResolver } from "./model-resolution.js";
import {
  type PiChildPrivateOutputCapture,
  type PiChildSettlement,
  PiRpcChild,
  type PiRpcChildSpawnSession,
} from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "./structured-completion.js";
import type { IdGenerator, PiAdapterLogger } from "./types.js";

const DIRECT_DISPATCH_PARENT_ID = ROOT_NODE_ID;
const DIRECT_DISPATCH_DEPTH = 0;
/**
 * Scope used when the storage-authority preflight refuses. No child id has
 * been drawn yet - drawing one would itself be an observable side effect - so
 * the failure names the dispatch path rather than a child that never existed.
 */
const DIRECT_DISPATCH_UNAUTHORIZED_CHILD_ID = "direct-step";

export interface PiDirectDispatchTransportDeps {
  readonly processPort: PiChildProcessPort;
  /**
   * The generation-scoped authority handed to the direct-step child. Direct
   * dispatch deliberately bypasses `PiDelegationController`'s budget and
   * tree, so it must name this authority explicitly. It is required, with no
   * default: a silent fallback would let readiness report ready while every
   * direct-step spawn refuses.
   */
  readonly sessionStorageAuthority: PiChildSessionStorageAuthority;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly logger: PiAdapterLogger;
  readonly idGenerator: IdGenerator;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  /**
   * Supplies the child-extension selection arguments for the direct-step
   * child. Direct dispatch bypasses the delegation controller's tree, so it
   * must receive the same generation-resolved provider explicitly; absent, or
   * an empty result, keeps today's inherit-all argv.
   */
  readonly resolveExtensionArgs?: () => readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly runtimeBudgetMs?: number;
  /**
   * Optional shared registry (Pi adapter contract) letting the extension's
   * `/weave:abort` command and its Esc-at-root editor binding reach the one
   * live direct-step child - which is never part of
   * `PiDelegationController`'s own tracked tree - to pause or cancel it.
   */
  readonly registry?: PiDirectStepChildRegistry;
  /** Shared topology/history registry for ordinary and workflow-step children. */
  readonly inspectionRegistry?: PiChildInspectionRegistry;
  /**
   * The authenticated model catalog captured once at session start (Spec
   * 33), used to resolve the direct-step descriptor's own `models`
   * intent into a concrete identity exactly as root-level ordinary
   * delegation does. Absent/empty means every entry is skipped and the
   * child resolves against its own catalog instead (graceful degradation,
   * never a hard failure).
   */
  readonly availableModels?: readonly PiModelInfo[];
  /**
   * Relays an authenticated request from the direct-step child into the
   * generation's shared ordinary-delegation controller. The direct child
   * itself remains exempt from ordinary budgets; every nested child does not.
   */
  readonly relayDelegation?: (
    request: PiAuthenticatedDelegationRequest,
  ) => ResultAsync<PiChildSettlement, PiAdapterFailure>;
  /**
   * The generation's Pi-native session store. A direct workflow step is a real
   * child session with a durable transcript, exactly like ordinary delegation,
   * so it is provisioned through this same approved store rather than launched
   * against an ephemeral or directory-only session.
   */
  readonly threadSessions?: () => PiThreadSessionPort | undefined;
  /**
   * The generation's child-ref authority. A native session with no parent ref
   * is unreachable authority, so the ref is written before the child runs.
   */
  readonly threadRefs?: () => PiThreadRefPort | undefined;
  /**
   * Production always reports `true`. When it does, a direct step refuses to
   * spawn unless a validated Pi-native restore session was provisioned first:
   * an absent store/ref port, an ephemeral session, or a directory-only session
   * fails closed with a typed, path-free failure and zero spawn. It is read per
   * dispatch so a generation that lost its native session sources still
   * refuses rather than silently degrading to an ephemeral child.
   */
  readonly requireNativeSession?: () => boolean;
  readonly now?: () => number;
  /** Required durable sink for complete direct-step output/candidates. */
  readonly onPrivateOutput?: (
    childId: string,
    capture: PiChildPrivateOutputCapture,
  ) => Result<void, PiAdapterFailure> | ResultAsync<void, PiAdapterFailure>;
}

/** A direct step's provisioned native session and its parent ref record. */
interface ProvisionedDirectSession {
  readonly session: PiDirectNativeSession;
  readonly record: PiNativeSessionRecord;
  /**
   * Opaque native-session ref used to persist complete private output onto the
   * already-provisioned required session. Never a filesystem path.
   */
  readonly ref: string;
  /**
   * The durable running ref this step wrote before spawning. It is the record
   * the terminal lifecycle append must extend, so the child never stays
   * `running` in the parent session after it settles.
   */
  readonly refRecord: PiChildRefRecord;
  /**
   * The parent session the running ref was written under. Settlement appends
   * only while the generation's live ref port still serves this same parent
   * session, so a replaced generation never writes through a stale record.
   */
  readonly parentSession: string;
}

/** The only spawn session shape a production direct step may ever use. */
export type PiDirectNativeSession = Extract<
  PiRpcChildSpawnSession,
  { readonly mode: "native" }
>;

/**
 * Validates the store-minted launch selector this transport built before it
 * can reach a spawn. `PiRpcChild` redeems the same grant at command
 * construction; this is the earlier, transport-level refusal the workflow
 * layer needs so an unusable session never reaches a process at all.
 *
 * An absent selector or a non-native mode (ephemeral) is rejected. The failure
 * carries a closed reason and never a filesystem path.
 */
export function validateDirectNativeSession(
  childId: string,
  session: PiRpcChildSpawnSession | undefined,
): Result<PiDirectNativeSession, PiAdapterFailure> {
  if (session === undefined) {
    return err(makeChildSpawnFailedFailure(childId, "direct-session-absent"));
  }
  if (session.mode !== "native") {
    return err(
      makeChildSpawnFailedFailure(childId, "direct-session-not-restorable"),
    );
  }
  return ok(session);
}

/**
 * Tracks the single in-flight direct-step child (Pi adapter contract forbids more
 * than one active workflow, so at most one direct-step child is ever live
 * at a time) so the extension can terminate or pause it from `/weave:abort`
 * or an Esc keypress at the root of the child tree - neither of which goes
 * through `PiDelegationController`, since direct dispatch is deliberately
 * exempt from its ordinary-delegation budget/tree.
 */
export class PiDirectStepChildRegistry {
  private active: PiRpcChild | undefined;

  setActive(child: PiRpcChild | undefined): void {
    this.active = child;
  }

  isActive(): boolean {
    return this.active !== undefined && !this.active.isSettled();
  }

  getActiveChildId(): string | undefined {
    if (!this.isActive()) return undefined;
    return this.active?.getId();
  }

  cancel(): ResultAsync<void, PiAdapterFailure> | undefined {
    const child = this.active;
    if (child === undefined) return undefined;
    return child.cancel();
  }
}

/**
 * Bootstrap payload shape delivered to a direct-step child. The `mode`
 * field is what tells the child-side extension instance
 * (`activateChildModeIfApplicable`) to register the
 * `weave_complete_step` tool and report its recorded structured
 * candidate as the structured completionCandidate, instead of the
 * ordinary-delegation free-text output path.
 */
export interface PiDirectStepBootstrap {
  readonly mode: "direct-step";
  readonly agentName: string;
  readonly composedPrompt: string;
  readonly models: readonly string[];
  readonly delegationTargets: readonly DelegationTarget[];
  /** Literal provider-acceleration intent. Omission preserves the provider default. */
  readonly fast?: true;
  readonly workflowInstanceId: string;
  readonly leaseId: string;
  readonly stepName: string;
  readonly correlationId: string;
  readonly context: {
    readonly parentAgentName: string;
    readonly parentDepth: number;
    readonly cwd: string;
  };
  readonly resolvedModel?: {
    readonly provider: string;
    readonly id: string;
    readonly name?: string;
  };
  readonly thinkingLevel?: ThinkingLevelDecl;
  readonly completionTool: typeof WEAVE_COMPLETE_STEP_TOOL_NAME;
}

export function createDirectDispatchTransport(
  deps: PiDirectDispatchTransportDeps,
  generationId: string,
): DirectDispatchTransport {
  const sessionStorageAuthority = deps.sessionStorageAuthority;
  return (
    input: PiDirectDispatchInput,
  ): ResultAsync<DirectDispatchSettlement, PiAdapterFailure> => {
    // Storage authority first: before an id is drawn, before the transport
    // object exists, before the bootstrap or model resolution is computed,
    // before the inspection registry is written, and before any spawn. The
    // dispatch input is not read at all until this passes.
    const authority = sessionStorageAuthority.requireNativeSessionAuthority();
    if (authority.isErr()) {
      return errAsync(
        makeChildSpawnFailedFailure(
          DIRECT_DISPATCH_UNAUTHORIZED_CHILD_ID,
          describeChildSessionStorageUnavailable(authority.error),
        ),
      );
    }

    const childId = `direct-${input.workflowInstanceId}-${input.stepName}-${deps.idGenerator.next()}`;
    /**
     * Complete private terminal output captured by `PiRpcChild` before the
     * transport-level settlement can succeed, together with its provenance.
     * The settlement's `assistantOutput` is a bounded projection and must
     * never be persisted as the authoritative result, and neither may the
     * observed terminal assistant prose a structured direct step happens to
     * leave behind.
     */
    let capturedPrivateOutput: PiChildPrivateOutputCapture | undefined;
    let child: PiRpcChild;
    const respondToDelegation = (
      correlationId: string,
      body: JsonValue,
    ): void => {
      void child.sendDelegationResponse(correlationId, body);
    };
    child = new PiRpcChild(
      childId,
      DIRECT_DISPATCH_PARENT_ID,
      generationId,
      input.agentName,
      DIRECT_DISPATCH_DEPTH,
      {
        processPort: deps.processPort,
        sessionStorageAuthority,
        randomPort: deps.randomPort,
        hmacPort: deps.hmacPort,
        logger: deps.logger,
        command: deps.command,
        resolveExtensionArgs: deps.resolveExtensionArgs,
        handshakeTimeoutMs: deps.handshakeTimeoutMs,
        replyTimeoutMs: deps.replyTimeoutMs,
        settlementTimeoutMs: deps.settlementTimeoutMs,
        runtimeBudgetMs: deps.runtimeBudgetMs,
        baseEnv: deps.baseEnv,
        sessionObserver: {
          onEvent: (event) => {
            deps.inspectionRegistry?.checkpointEvent(childId, event).match(
              () => undefined,
              () => undefined,
            );
            return ok(undefined);
          },
        },
        onStreamingUpdate: () => {
          deps.inspectionRegistry?.checkpoint(childId).match(
            () => undefined,
            () => undefined,
          );
        },
        onPrivateOutput: (capture) => {
          capturedPrivateOutput = capture;
          return deps.onPrivateOutput?.(childId, capture) ?? ok(undefined);
        },
        onDelegationRequest: (authenticatedChildId, correlationId, body) => {
          const relayDelegation = deps.relayDelegation;
          if (relayDelegation === undefined) {
            respondToDelegation(correlationId, {
              ok: false,
              error: "nested-delegation-unavailable",
            });
            return;
          }
          void relayDelegation({
            parentId: authenticatedChildId,
            parentDepth: DIRECT_DISPATCH_DEPTH,
            parentAgentName: input.agentName,
            agentName: body.agentName,
            task: body.task,
            cwd: input.cwd,
          }).match(
            (settlement) => {
              respondToDelegation(correlationId, { ok: true, settlement });
            },
            (failure) => {
              respondToDelegation(correlationId, {
                ok: false,
                error: failure.code,
              });
            },
          );
        },
      },
    );

    const spawnInput = {
      childId,
      parentId: DIRECT_DISPATCH_PARENT_ID,
      generationId,
      agentName: input.agentName,
      depth: DIRECT_DISPATCH_DEPTH,
      cwd: input.cwd,
      env: {},
      task: input.taskPrompt,
    };

    const resolution = new PiModelResolver().resolve(
      input.models,
      deps.availableModels ?? [],
    );
    // The matched entry is drawn straight from `deps.availableModels` (the
    // host's own catalog snapshot) and may carry fields beyond
    // provider/id/name; project it down before it ever reaches this
    // bootstrap's `ModelIdentityBodySchema`-validated field (Pi adapter contract
    //).
    const resolvedModel = resolution.resolved
      ? toModelIdentityBody(resolution.model)
      : undefined;

    const bootstrap: PiDirectStepBootstrap = {
      mode: "direct-step",
      agentName: input.agentName,
      composedPrompt: input.composedPrompt,
      models: [...input.models],
      // Large catalogs stay parent-authoritative instead of consuming one
      // signed bootstrap envelope.
      delegationTargets: [],
      workflowInstanceId: input.workflowInstanceId,
      leaseId: input.leaseId,
      stepName: input.stepName,
      // The bootstrap's `correlationId` authenticates this exact child to
      // itself (`applyChildBootstrap` requires it to equal the child's own
      // env-derived `state.childId`, as required by the Pi adapter contract) - it is never the
      // engine-level `input.correlationId` (`dispatchEffect.runAgent.correlationId`,
      // pre-generated by `PiWorkflowController` for its own effect/audit
      // correlation under the Pi adapter contract). Conflating the two meant every direct-step
      // bootstrap's `correlationId` mismatched this transport's own generated
      // `childId`, so the child always failed closed without ever acking -
      // ordinary delegation's `buildChildBootstrapBody` already gets this
      // right by using the generated `childId` here, never a caller-supplied
      // value.
      correlationId: childId,
      context: {
        parentAgentName: DIRECT_DISPATCH_PARENT_ID,
        parentDepth: DIRECT_DISPATCH_DEPTH,
        cwd: input.cwd,
      },
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(input.fast === true ? { fast: true as const } : {}),
      ...(resolution.resolved && resolution.thinkingLevel !== undefined
        ? { thinkingLevel: resolution.thinkingLevel }
        : {}),
      completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
    };

    const now = deps.now ?? (() => Date.now());

    /**
     * Tombstones a session whose thread never became reachable. The ref that
     * would have made it reachable was never written, so a failed tombstone
     * leaves an unreferenced file, never a resumable thread.
     */
    const tombstone = (
      sessions: PiThreadSessionPort,
      record: PiNativeSessionRecord,
    ): void => {
      void sessions.appendTombstone(record).match(
        () => undefined,
        () => undefined,
      );
    };

    /**
     * Provisions this direct step's authoritative Pi-native child session and
     * parent ref before any process or lease exists, exactly as ordinary
     * delegation does. A failure here leaves no child process, no lease, no
     * thread, and no half-written authority.
     */
    const provisionDirectSession = (): ResultAsync<
      ProvisionedDirectSession | undefined,
      PiAdapterFailure
    > => {
      const sessions = deps.threadSessions?.();
      if (sessions === undefined) {
        // Production always requires a native session; refuse before spawn
        // rather than silently launching an ephemeral child.
        return deps.requireNativeSession?.() === true
          ? errAsync(
              makeChildSpawnFailedFailure(
                childId,
                "thread-sessions-unavailable",
              ),
            )
          : okAsync(undefined);
      }
      const refs = deps.threadRefs?.();
      if (refs === undefined) {
        return errAsync(
          makeChildSpawnFailedFailure(childId, "thread-refs-unavailable"),
        );
      }
      const parentSession = refs.liveParentSessionId();
      if (parentSession.length === 0) {
        return errAsync(
          makeChildSpawnFailedFailure(childId, "thread-parent-unavailable"),
        );
      }
      const createdAt = now();
      return sessions
        .createChildSession({
          childId,
          parentSession,
          cwd: input.cwd,
        })
        .mapErr(() =>
          makeChildSpawnFailedFailure(childId, "thread-session-create-failed"),
        )
        .andThen((record) =>
          sessions
            .establishThreadLeaf(
              record.ref,
              {
                threadId: childId,
                agentName: input.agentName,
                parentId: DIRECT_DISPATCH_PARENT_ID,
                parentAgentName: DIRECT_DISPATCH_PARENT_ID,
                parentDepth: DIRECT_DISPATCH_DEPTH,
                ownerParentSessionId: parentSession,
                cwd: input.cwd,
                ...(resolvedModel === undefined
                  ? {}
                  : { model: `${resolvedModel.provider}/${resolvedModel.id}` }),
                ...(resolution.resolved &&
                resolution.thinkingLevel !== undefined
                  ? { reasoning: resolution.thinkingLevel }
                  : {}),
                createdAt,
              },
              parentSession,
            )
            .mapErr(() => {
              tombstone(sessions, record);
              return makeChildSpawnFailedFailure(
                childId,
                "thread-leaf-unavailable",
              );
            })
            .andThen((leaf) =>
              refs
                .appendNewChild({
                  childId,
                  threadId: childId,
                  nativeSessionId: record.sessionId,
                  sessionRef: record.ref,
                  // Title comes only from trusted identity metadata, never
                  // from the step's task or composed prompt text.
                  title: resolveDurableChildTitle({
                    agentName: input.agentName,
                    threadId: childId,
                  }),
                  titleProvenance: PI_CHILD_TITLE_PROVENANCE,
                  status: "running",
                  run: { action: "start", startedAt: createdAt },
                })
                .mapErr(() => {
                  tombstone(sessions, record);
                  return makeChildSpawnFailedFailure(
                    childId,
                    "thread-ref-write-failed",
                  );
                })
                .andThen((refRecord) =>
                  // The launch selector is minted by the store that validated
                  // this session, so no path-carrying selector ever exists.
                  sessions
                    .mintLaunchGrant({
                      childId,
                      record,
                      activeLeafId: leaf.leafId,
                    })
                    .mapErr(() => {
                      tombstone(sessions, record);
                      return makeChildSpawnFailedFailure(
                        childId,
                        "thread-launch-grant-unavailable",
                      );
                    })
                    .andThen((grant) => {
                      const validated = validateDirectNativeSession(childId, {
                        mode: "native",
                        grant,
                      });
                      if (validated.isErr()) {
                        tombstone(sessions, record);
                        return errAsync<
                          ProvisionedDirectSession | undefined,
                          PiAdapterFailure
                        >(validated.error);
                      }
                      return okAsync<
                        ProvisionedDirectSession | undefined,
                        PiAdapterFailure
                      >({
                        session: validated.value,
                        record,
                        ref: record.ref,
                        refRecord,
                        parentSession,
                      });
                    }),
                ),
            ),
        );
    };

    const registration =
      deps.inspectionRegistry?.register({
        id: childId,
        parentId: DIRECT_DISPATCH_PARENT_ID,
        name: input.agentName,
        kind: "workflow-step",
        workflowInstanceId: input.workflowInstanceId,
        stepName: input.stepName,
        snapshot: () => child.snapshot(),
      }) ?? okAsync(undefined);
    let terminalLifecycleAppended = false;
    /**
     * The terminal ref status for one settled direct step. It follows the raw
     * child outcome, not the workflow-facing projection: a cancelled child is
     * recorded as `cancelled` even though the settlement the workflow layer
     * receives is the closed failed shape, and a transport error is recorded
     * as `failed`.
     */
    const terminalRefStatusFor = (
      outcome: Result<PiChildSettlement, PiAdapterFailure>,
    ): AppendChildRefLifecycleInput["status"] => {
      if (outcome.isErr()) return "failed";
      if (outcome.value.outcome === "cancelled") return "cancelled";
      if (outcome.value.outcome === "completed") return "completed";
      return "failed";
    };

    /**
     * Appends exactly one terminal lifecycle record for a step that already
     * has a durable running ref, so the parent session never keeps a settled
     * direct child at `running`. Nothing is appended before that ref exists.
     * The append goes only through the port that wrote the running ref, and
     * only while it is still this generation's live port and still names this
     * child; anything else is an unproven identity and fails closed.
     */
    const appendTerminalLifecycle = async (
      provisioned: ProvisionedDirectSession | undefined,
      status: AppendChildRefLifecycleInput["status"],
    ): Promise<Result<undefined, PiAdapterFailure>> => {
      if (provisioned === undefined) return ok(undefined);
      // Exactly once per dispatch, even if this settlement path were ever
      // re-entered.
      if (terminalLifecycleAppended) return ok(undefined);
      terminalLifecycleAppended = true;
      const liveRefs = deps.threadRefs?.();
      if (
        liveRefs === undefined ||
        liveRefs.liveParentSessionId() !== provisioned.parentSession ||
        provisioned.refRecord.childId !== childId
      ) {
        deps.logger.error(
          { childId, agentName: input.agentName, status },
          "direct-step terminal lifecycle identity unproven",
        );
        return err(
          makeChildAbortFailedFailure(
            childId,
            "direct-lifecycle-identity-unproven",
          ),
        );
      }
      const appended = await liveRefs.appendLifecycle(provisioned.refRecord, {
        status,
        settledAt: now(),
      });
      if (appended.isErr()) {
        deps.logger.error(
          { childId, agentName: input.agentName, status },
          "direct-step terminal lifecycle write failed",
        );
        // Closed reason string: never the ref store's own error text.
        return err(
          makeChildAbortFailedFailure(
            childId,
            "direct-lifecycle-writeback-failed",
          ),
        );
      }
      return ok(undefined);
    };

    /**
     * Writes the direct step's verified completion candidate onto the
     * already-provisioned required native session before a completed
     * settlement can succeed.
     *
     * A direct step's authoritative result is its structured completion
     * candidate - inline or transferred - and nothing else. A capture whose
     * provenance is observed terminal prose, or one that disagrees with the
     * settlement's own candidate, is refused rather than persisted, so the
     * durable result can never be unrelated assistant text.
     */
    const persistCompletedOutput = async (
      provisioned: ProvisionedDirectSession | undefined,
      capture: PiChildPrivateOutputCapture | undefined,
      settlementCandidate: string | undefined,
    ): Promise<Result<undefined, PiAdapterFailure>> => {
      if (provisioned === undefined) return ok(undefined);
      if (capture === undefined) {
        deps.logger.error(
          { childId, agentName: input.agentName },
          "direct-step result capture missing",
        );
        return err(makeChildRecoveryUnavailableFailure(childId));
      }
      if (
        capture.source !== "inline-candidate" &&
        capture.source !== "transferred-candidate"
      ) {
        deps.logger.error(
          { childId, agentName: input.agentName, source: capture.source },
          "direct-step result capture is not a completion candidate",
        );
        return err(makeChildRecoveryUnavailableFailure(childId));
      }
      if (
        settlementCandidate === undefined ||
        settlementCandidate !== capture.output
      ) {
        deps.logger.error(
          { childId, agentName: input.agentName, source: capture.source },
          "direct-step result capture does not match the settled candidate",
        );
        return err(makeChildRecoveryUnavailableFailure(childId));
      }
      const output = capture.output;
      const sessions = deps.threadSessions?.();
      const append = sessions?.appendResultOutput;
      if (sessions === undefined || append === undefined) {
        deps.logger.error(
          { childId, agentName: input.agentName },
          "direct-step result persist unavailable",
        );
        return err(makeChildRecoveryUnavailableFailure(childId));
      }
      const appended = await append.call(sessions, provisioned.ref, output, {
        childId: provisioned.record.childId,
        nativeSessionId: provisioned.record.sessionId,
        parentSession: provisioned.parentSession,
      });
      if (appended.isErr()) {
        deps.logger.error(
          { childId, agentName: input.agentName },
          "direct-step result persist failed",
        );
        return err(
          appended.error.type === "SessionCorrupt"
            ? makeChildRecordCorruptFailure(childId)
            : makeChildRecoveryUnavailableFailure(childId),
        );
      }
      return ok(undefined);
    };

    const historyFailure = (failure: {
      readonly reason: "unavailable" | "corrupt" | "quota" | "invalid";
    }): PiAdapterFailure => {
      if (failure.reason === "quota")
        return makeChildRecordQuotaExceededFailure(childId);
      if (failure.reason === "corrupt")
        return makeChildRecordCorruptFailure(childId);
      if (failure.reason === "unavailable")
        return makeChildRecoveryUnavailableFailure(childId);
      return makeChildRecordQuarantinedFailure(childId);
    };
    return registration
      .mapErr(historyFailure)
      .andThen(() => provisionDirectSession())
      .andThen((provisioned) => {
        deps.registry?.setActive(child);
        // The validated restore selector is the only session a production
        // direct step ever launches with, so RPC always receives both
        // `--session-dir` and `--session` and never `--no-session`.
        const sessionSpawnInput =
          provisioned === undefined
            ? spawnInput
            : { ...spawnInput, session: provisioned.session };
        const execution = child
          .spawnAndHandshake(sessionSpawnInput)
          .andThen(() =>
            child.runTask(sessionSpawnInput, bootstrap as unknown as JsonValue),
          );
        return new ResultAsync(
          (async () => {
            const outcome = await execution;
            const finalOutput =
              outcome.isOk() && outcome.value.outcome === "completed"
                ? outcome.value.assistantOutput
                : undefined;
            const persisted =
              deps.inspectionRegistry === undefined
                ? ok(undefined)
                : await deps.inspectionRegistry.retainTerminal(
                    childId,
                    child.snapshot(),
                    finalOutput,
                  );
            // Cleanup is unconditional, including when history persistence fails.
            child.dispose();
            deps.registry?.setActive(undefined);
            // The authoritative result is persisted *before* any terminal
            // lifecycle record exists. A durable `completed` lifecycle is a
            // claim that this step's result is retrievable, so it may never
            // be written first and then contradicted: when persistence fails,
            // the step settles at `failed` and the durable lifecycle says so.
            const outputPersisted =
              outcome.isOk() && outcome.value.outcome === "completed"
                ? await persistCompletedOutput(
                    provisioned,
                    capturedPrivateOutput,
                    outcome.value.completionCandidate,
                  )
                : ok<undefined, PiAdapterFailure>(undefined);
            const lifecycle = await appendTerminalLifecycle(
              provisioned,
              outputPersisted.isErr()
                ? "failed"
                : terminalRefStatusFor(outcome),
            );
            if (persisted.isErr()) return err(historyFailure(persisted.error));
            if (outcome.isErr()) {
              deps.logger.error(
                {
                  childId,
                  agentName: input.agentName,
                  code: outcome.error.code,
                  correlation: outcome.error.correlation,
                },
                "direct-step child transport failed",
              );
              return err(outcome.error);
            }
            // A step whose result never landed is never reported completed.
            if (outputPersisted.isErr()) return err(outputPersisted.error);
            // The primary transport/persistence facts above are reported
            // first; a lost lifecycle append surfaces only after nothing more
            // important remains to report.
            if (lifecycle.isErr()) return err(lifecycle.error);
            // A direct-step child's cancellation is projected to the closed
            // failed shape expected by the workflow layer.
            if (outcome.value.outcome === "cancelled")
              return ok<DirectDispatchSettlement, PiAdapterFailure>({
                outcome: "failed",
                reason: "cancelled",
              });
            if (outcome.value.outcome === "completed") {
              return ok<DirectDispatchSettlement, PiAdapterFailure>({
                outcome: "completed",
                completionCandidate: outcome.value.completionCandidate,
                interventionCount: outcome.value.interventionCount ?? 0,
              });
            }
            return ok<DirectDispatchSettlement, PiAdapterFailure>({
              outcome: "failed",
              reason: outcome.value.reason,
            });
          })(),
        );
      });
  };
}
