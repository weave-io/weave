/**
 * Production `DirectDispatchTransport` (Pi adapter contract). Spawns a
 * fresh, ephemeral, single-use `PiRpcChild` for exactly one workflow step -
 * this deliberately bypasses `PiDelegationController`'s ordinary-delegation
 * budget/queue entirely, since direct workflow-step dispatch is a distinct
 * engine effect, not ordinary delegation. It reuses the same low-level
 * private child transport class (`PiRpcChild`) rather than a second
 * protocol implementation.
 */
import type { DelegationTarget } from "@weaveio/weave-engine";
import type { ResultAsync } from "neverthrow";
import { toModelIdentityBody } from "./child-control-bodies.js";
import type { HmacPort, RandomPort } from "./child-crypto.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import type { PiAuthenticatedDelegationRequest } from "./delegation-controller.js";
import { WEAVE_DELEGATION_TOOL_NAME } from "./delegation-tool.js";
import type {
  DirectDispatchSettlement,
  DirectDispatchTransport,
  PiDirectDispatchInput,
} from "./direct-dispatch.js";
import type { PiAdapterFailure } from "./errors.js";
import { type PiModelInfo, PiModelResolver } from "./model-resolution.js";
import { type PiChildSettlement, PiRpcChild } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import { WEAVE_COMPLETE_STEP_TOOL_NAME } from "./structured-completion.js";
import { deriveActiveToolNames } from "./tool-governance.js";
import type { IdGenerator, PiAdapterLogger } from "./types.js";

const DIRECT_DISPATCH_PARENT_ID = "workflow-controller";
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
  /**
   * The authenticated model catalog captured once at session start (Spec
   * 33 §9.2), used to resolve the direct-step descriptor's own `models`
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
 * (`activateChildModeIfApplicable`) to register the governed
 * `weave_complete_step` tool and to report its recorded structured
 * candidate as the settlement summary, instead of the ordinary-delegation
 * free-text summary path.
 */
export interface PiDirectStepBootstrap {
  readonly mode: "direct-step";
  readonly agentName: string;
  readonly composedPrompt: string;
  readonly models: readonly string[];
  readonly effectiveToolPolicy: Record<string, unknown> | undefined;
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
  readonly activeTools: readonly string[];
  readonly resolvedModel:
    | { readonly provider: string; readonly id: string; readonly name?: string }
    | undefined;
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

    // Derive the direct-step child's own governed active-tool set exactly
    // as ordinary root-level delegation does (Spec 33 §12), plus the
    // always-present completion tool - never registered for any other
    // bootstrap mode (Spec 33 §15).
    const hasDelegationTool = input.delegationTargets.length > 0;
    const activeTools = [
      ...deriveActiveToolNames(
        input.effectiveToolPolicy,
        hasDelegationTool ? WEAVE_DELEGATION_TOOL_NAME : undefined,
      ),
      WEAVE_COMPLETE_STEP_TOOL_NAME,
    ];
    const resolution = new PiModelResolver().resolve(
      input.models,
      deps.availableModels ?? [],
    );
    // The matched entry is drawn straight from `deps.availableModels` (the
    // host's own catalog snapshot) and may carry fields beyond
    // provider/id/name; project it down before it ever reaches this
    // bootstrap's `ModelIdentityBodySchema`-validated field (Pi adapter contract
    // finding 2).
    const resolvedModel = resolution.resolved
      ? toModelIdentityBody(resolution.model)
      : undefined;

    const bootstrap: PiDirectStepBootstrap = {
      mode: "direct-step",
      agentName: input.agentName,
      composedPrompt: input.composedPrompt,
      models: input.models,
      effectiveToolPolicy: input.effectiveToolPolicy as
        | Record<string, unknown>
        | undefined,
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
      activeTools,
      resolvedModel,
      completionTool: WEAVE_COMPLETE_STEP_TOOL_NAME,
    };

    deps.registry?.setActive(child);
    return child
      .spawnAndHandshake(spawnInput)
      .andThen(() =>
        child.runTask(spawnInput, bootstrap as unknown as JsonValue),
      )
      .map((settlement): DirectDispatchSettlement => {
        deps.registry?.setActive(undefined);
        // A direct-step child's own cancellation (Pi adapter contract) is
        // handled by `handleUserInterrupt(...pause)` at the workflow layer,
        // never as a structured completion candidate - `PiChildSettlement`'s
        // `"cancelled"` outcome has no equivalent in the narrower
        // `DirectDispatchSettlement` shape `interpretSettlement` expects, so
        // it is projected down to the same closed `"failed"` shape every
        // other non-completion outcome already uses here.
        if (settlement.outcome === "cancelled") {
          return { outcome: "failed", reason: "cancelled" };
        }
        return settlement;
      })
      .mapErr((failure) => {
        deps.registry?.setActive(undefined);
        deps.logger.error(
          {
            childId,
            agentName: input.agentName,
            code: failure.code,
            correlation: failure.correlation,
          },
          "direct-step child transport failed",
        );
        return failure;
      });
  };
}
