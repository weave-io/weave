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
  makeChildRecordCorruptFailure,
  makeChildRecordQuarantinedFailure,
  makeChildRecordQuotaExceededFailure,
  makeChildRecoveryUnavailableFailure,
  makeChildSpawnFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { type PiModelInfo, PiModelResolver } from "./model-resolution.js";
import {
  type PiChildSettlement,
  PiRpcChild,
  type PiRpcChildSpawnSession,
} from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "./structured-completion.js";
import type { IdGenerator, PiAdapterLogger } from "./types.js";

const DIRECT_DISPATCH_PARENT_ID = ROOT_NODE_ID;
const DIRECT_DISPATCH_DEPTH = 0;

export interface PiDirectDispatchTransportDeps {
  readonly processPort: PiChildProcessPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly logger: PiAdapterLogger;
  readonly idGenerator: IdGenerator;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
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
}

/** A direct step's provisioned native session and its parent ref record. */
interface ProvisionedDirectSession {
  readonly session: PiDirectRestoreSession;
  readonly record: PiNativeSessionRecord;
}

/** The only spawn session shape a production direct step may ever use. */
export type PiDirectRestoreSession = Extract<
  PiRpcChildSpawnSession,
  { readonly mode: "restore" }
>;

/**
 * Validates the restore selector this transport built before it can reach a
 * spawn. `PiRpcChild` re-validates the same selector at command construction;
 * this is the earlier, transport-level refusal the workflow layer needs so an
 * unusable session never reaches a process at all.
 *
 * A non-restore mode (ephemeral), a directory-only selection (no session file),
 * a missing active leaf, or a session file that does not live directly in the
 * selected directory are all rejected. The failure carries a closed reason and
 * never the candidate path.
 */
export function validateDirectRestoreSession(
  childId: string,
  session: PiRpcChildSpawnSession | undefined,
): Result<PiDirectRestoreSession, PiAdapterFailure> {
  if (session === undefined) {
    return err(makeChildSpawnFailedFailure(childId, "direct-session-absent"));
  }
  if (session.mode !== "restore") {
    return err(
      makeChildSpawnFailedFailure(childId, "direct-session-not-restorable"),
    );
  }
  if (session.sessionDir.length === 0 || session.sessionPath.length === 0) {
    return err(
      makeChildSpawnFailedFailure(childId, "direct-session-incomplete"),
    );
  }
  if (session.activeLeafId.length === 0) {
    return err(makeChildSpawnFailedFailure(childId, "direct-session-no-leaf"));
  }
  if (dirname(session.sessionPath) !== session.sessionDir) {
    return err(
      makeChildSpawnFailedFailure(childId, "direct-session-outside-directory"),
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
  return (
    input: PiDirectDispatchInput,
  ): ResultAsync<DirectDispatchSettlement, PiAdapterFailure> => {
    const childId = `direct-${input.workflowInstanceId}-${input.stepName}-${deps.idGenerator.next()}`;
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
        randomPort: deps.randomPort,
        hmacPort: deps.hmacPort,
        logger: deps.logger,
        command: deps.command,
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
      models: input.models,
      delegationTargets: input.delegationTargets,
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
                .andThen(() => {
                  // The selector is validated here, before it can reach a
                  // spawn: an ephemeral or directory-only selection never
                  // becomes a launched child.
                  const validated = validateDirectRestoreSession(childId, {
                    mode: "restore",
                    sessionDir: dirname(record.path),
                    sessionPath: record.path,
                    activeLeafId: leaf.leafId,
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
                  >({ session: validated.value, record });
                }),
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
            // A direct-step child's cancellation is projected to the closed
            // failed shape expected by the workflow layer.
            if (outcome.value.outcome === "cancelled")
              return ok<DirectDispatchSettlement, PiAdapterFailure>({
                outcome: "failed",
                reason: "cancelled",
              });
            if (outcome.value.outcome === "completed")
              return ok<DirectDispatchSettlement, PiAdapterFailure>({
                outcome: "completed",
                completionCandidate: outcome.value.completionCandidate,
                interventionCount: outcome.value.interventionCount ?? 0,
              });
            return ok<DirectDispatchSettlement, PiAdapterFailure>({
              outcome: "failed",
              reason: outcome.value.reason,
            });
          })(),
        );
      });
  };
}
