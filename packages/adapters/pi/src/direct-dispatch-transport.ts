/**
 * Production `DirectDispatchTransport` (Pi adapter contract). Spawns a
 * fresh, ephemeral, single-use `PiRpcChild` for exactly one workflow step -
 * this deliberately bypasses `PiDelegationController`'s ordinary-delegation
 * budget/queue entirely, since direct workflow-step dispatch is a distinct
 * engine effect, not ordinary delegation. It reuses the same low-level
 * private child transport class (`PiRpcChild`) rather than a second
 * protocol implementation.
 */
import type { ThinkingLevelDecl } from "@weaveio/weave-core";
import type { DelegationTarget } from "@weaveio/weave-engine";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import { toModelIdentityBody } from "./child-control-bodies.js";
import type { HmacPort, RandomPort } from "./child-crypto.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import {
  createPiChildSessionStorageAuthority,
  describeChildSessionStorageUnavailable,
  type PiChildSessionStorageAuthority,
} from "./child-session-storage-authority.js";
import { type PiChildInspectionRegistry, ROOT_NODE_ID } from "./child-tree.js";
import type { PiAuthenticatedDelegationRequest } from "./delegation-controller.js";
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
import { type PiChildSettlement, PiRpcChild } from "./rpc-child.js";
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
   * Storage authority handed to the direct-step child. Direct dispatch
   * deliberately bypasses `PiDelegationController`'s budget and tree, so it
   * must name its own authority rather than inherit one. Absent means the
   * production authority, which always refuses.
   */
  readonly sessionStorageAuthority?: PiChildSessionStorageAuthority;
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
  const sessionStorageAuthority =
    deps.sessionStorageAuthority ?? createPiChildSessionStorageAuthority();
  return (
    input: PiDirectDispatchInput,
  ): ResultAsync<DirectDispatchSettlement, PiAdapterFailure> => {
    // Storage authority first: before an id is drawn, before the transport
    // object exists, before the bootstrap or model resolution is computed,
    // before the inspection registry is written, and before any spawn. The
    // dispatch input is not read at all until this passes.
    const authority = sessionStorageAuthority.requireDescriptorSafeSessionIo();
    if (authority.isErr()) {
      return errAsync(
        makeChildSpawnFailedFailure(
          DIRECT_DISPATCH_UNAUTHORIZED_CHILD_ID,
          describeChildSessionStorageUnavailable(authority.error),
        ),
      );
    }

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
        sessionStorageAuthority,
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
      models: [...input.models],
      delegationTargets: input.delegationTargets.map((target) => ({
        name: target.name,
        ...(target.description === undefined
          ? {}
          : { description: target.description }),
        triggers: [...target.triggers],
        isCategory: target.isCategory,
      })),
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
    return registration.mapErr(historyFailure).andThen(() => {
      deps.registry?.setActive(child);
      const execution = child
        .spawnAndHandshake(spawnInput)
        .andThen(() =>
          child.runTask(spawnInput, bootstrap as unknown as JsonValue),
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
