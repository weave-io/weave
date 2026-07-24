/**
 * Adapter-owned delegation transport (Spec 33 §10-§11): enforces the
 * engine's pure `authorizeDelegation()` decision against live,
 * adapter-supplied counts; owns the per-parent FIFO queue, global process
 * budget, spawn/handshake/settlement of `PiRpcChild` instances, whole-tree
 * cancellation with descendant cleanup, and the bounded inspectable tree
 * snapshot. Never reimplements the engine's limit-decision logic.
 */
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  authorizeDelegation,
  type DelegationAuthorizationDecision,
  type DelegationAuthorizationError,
  type DelegationLimitsError,
  type DelegationTarget,
  resolveEffectiveDelegationLimits,
} from "@weaveio/weave-engine";
import { err, errAsync, ok, type Result, ResultAsync } from "neverthrow";
import type {
  PiApprovalRequestBody,
  PiDelegateRequestBody,
} from "./child-control-bodies.js";
import { MAX_CWD_LENGTH, MAX_NAME_LENGTH } from "./child-control-bodies.js";
import type { HmacPort, RandomPort } from "./child-crypto.js";
import type { PiChildProcessPort } from "./child-process-port.js";
import type { TimerHandle, TimerPort } from "./child-timer.js";
import {
  addUsage,
  EMPTY_USAGE_AGGREGATE,
  type PiChildTreeNode,
  ROOT_NODE_ID,
  subtreeIds,
} from "./child-tree.js";
import { MAX_TASK_INPUT_CHARS } from "./delegation-limits.js";
import {
  makeChildAbortFailedFailure,
  makeChildCapacityExceededFailure,
  makeUiBridgeFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import { type PiChildSettlement, PiRpcChild } from "./rpc-child.js";
import type { JsonValue } from "./strict-json.js";
import type { IdGenerator, PiAdapterLogger } from "./types.js";

/** A bounded task/context object, echoed at multiple layers (Spec 33 §11.2 Task 9): tool parsing, control schema, this controller, and the RPC prompt send in `rpc-child.ts`. */
export interface PiDelegationContext {
  readonly parentAgentName: string;
  readonly parentDepth: number;
  readonly cwd: string;
}

export interface PiDelegationControllerDeps {
  readonly config: WeaveConfig;
  readonly generationId: string;
  readonly idGenerator: IdGenerator;
  readonly logger: PiAdapterLogger;
  readonly processPort: PiChildProcessPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly timerPort?: TimerPort;
  readonly cancelGraceMs?: number;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly command?: readonly string[];
  /**
   * The real primary/root agent's own logical name for this generation, as
   * activated by the extension - never caller-supplied. Used to verify
   * that a `delegate()` call claiming to originate from the synthetic
   * root (`parentId === ROOT_NODE_ID`) isn't forging a different
   * `parentAgentName` to pick a looser delegation budget than the real
   * root actually has (Spec 33 §10). A lazy accessor, not a plain string,
   * because the real primary agent may not finish activating until after
   * this controller is constructed for the generation - callers must
   * always read the *current* value, never one captured too early.
   * Returns `undefined` only in tests that don't exercise root-level
   * delegation, or before the primary has activated.
   */
  readonly rootAgentName?: () => string | undefined;
  /** Relayed whenever any live child requests approval for one of its own governed tool calls (Spec 33 §11.5/§12). */
  readonly onChildApprovalRequest?: (
    childId: string,
    correlationId: string,
    request: PiApprovalRequestBody,
  ) => void;
  /**
   * Resolves a nested/descendant delegation target (Spec 33 §10-11): given
   * the *requesting* child's own agent name and the target agent name it
   * asked for, returns that target only if it is one of the requester's
   * OWN normalized `delegationTargets` - never any arbitrary agent in the
   * project. Returns `undefined` to fail closed (invalid/ineligible
   * target, or nested delegation not wired for this generation).
   */
  readonly resolveDelegationTarget?: (
    requestingAgentName: string,
    targetAgentName: string,
  ) => DelegationTarget | undefined;
  /**
   * Builds the bootstrap payload for a resolved nested delegation target,
   * given the pre-generated child id (used as the bootstrap's
   * `correlationId`, Spec 33 §11.2 Task 9) and the requesting child's own
   * delegation context.
   */
  readonly buildBootstrap?: (
    target: DelegationTarget,
    childId: string,
    context: PiDelegationContext,
  ) => JsonValue;
  /**
   * Invoked whenever the inspectable tree may have changed (Spec 33
   * §11.5) - immediately on spawn/settle/cancel/dispose, and on a bounded
   * poll interval while any child is live, so turn/tool/usage/output
   * updates streaming from a running child are eventually reflected too.
   */
  readonly onTreeChanged?: () => void;
  readonly treeRefreshIntervalMs?: number;
}

export interface PiDelegationRequest {
  readonly parentId: string;
  readonly parentDepth: number;
  /**
   * The invoking (parent) agent's own logical name - portable delegation
   * limits (Spec 33 §10, ADR 0008) are the *parent's* budget for how many
   * children it may spawn, never the target's own settings.
   */
  readonly parentAgentName: string;
  readonly agentName: string;
  readonly task: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly bootstrap: JsonValue;
  /**
   * Pre-generated by the caller when it must know the child id *before*
   * calling `delegate()` - e.g. to embed it as the bootstrap's
   * `correlationId` (Spec 33 §11.2 Task 9). Falls back to a
   * controller-generated id when absent.
   */
  readonly childId?: string;
}

interface QueuedDelegation {
  readonly childId: string;
  readonly request: PiDelegationRequest;
  readonly resolve: (
    result: Result<PiChildSettlement, PiAdapterFailure>,
  ) => void;
}

const DEFAULT_TREE_REFRESH_INTERVAL_MS = 500;

export class PiDelegationController {
  private readonly children = new Map<string, PiRpcChild>();
  private readonly queue: QueuedDelegation[] = [];
  private disposedAll = false;
  private treeRefreshTimer: TimerHandle | undefined;

  constructor(private readonly deps: PiDelegationControllerDeps) {}

  /** Requests one delegated child. Resolves immediately if denied, queues if over budget, spawns once authorized. */
  delegate(
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const childId = request.childId ?? this.deps.idGenerator.next();
    if (this.disposedAll) {
      return errAsync(
        makeChildAbortFailedFailure(childId, "controller disposed"),
      );
    }
    if (
      request.parentId.length === 0 ||
      !Number.isInteger(request.parentDepth) ||
      request.parentDepth < 0
    ) {
      return errAsync(
        makeChildAbortFailedFailure(childId, "invalid parent reference"),
      );
    }
    // Defense-in-depth bound re-check (Spec 33 §11.2 Task 9): the same task
    // and context limits are enforced at tool parsing, the bootstrap control
    // schema, here (the controller), and again at RPC prompt send in
    // `rpc-child.ts` - never trusting a single upstream layer alone.
    if (
      request.task.length < 1 ||
      request.task.length > MAX_TASK_INPUT_CHARS ||
      request.parentAgentName.length < 1 ||
      request.parentAgentName.length > MAX_NAME_LENGTH ||
      request.agentName.length < 1 ||
      request.agentName.length > MAX_NAME_LENGTH ||
      request.cwd.length < 1 ||
      request.cwd.length > MAX_CWD_LENGTH
    ) {
      return errAsync(
        makeChildAbortFailedFailure(childId, "task or context exceeds bound"),
      );
    }
    const identity = this.verifyParentIdentity(request);
    if (identity.isErr()) {
      return errAsync(makeChildAbortFailedFailure(childId, identity.error));
    }
    const decision = this.authorize(request);
    if (decision.isErr()) {
      // Config-level limit-resolution failures should already be rejected at
      // config-validation time; treat any that slip through as a hard cap so
      // delegation never fails open (Spec 33 §10, ADR 0008).
      return errAsync(
        makeChildCapacityExceededFailure(childId, "max_children"),
      );
    }
    if (decision.value.outcome === "denied") {
      return errAsync(
        makeChildCapacityExceededFailure(childId, decision.value.reason),
      );
    }
    if (decision.value.outcome === "authorized") {
      return this.spawnNow(childId, request);
    }
    return this.enqueue(childId, request);
  }

  /**
   * Verifies `parentId` names *exactly* the real synthetic root or a real
   * live, non-terminal requesting child, and that the request's claimed
   * `parentAgentName`/`parentDepth` match that identity's true recorded
   * values (Spec 33 §10-11). `authorize()` alone can't catch a forged
   * identity since it only trusts the request's own claimed fields as
   * given - without this, a caller could name a completely fabricated
   * `parentId` to get a brand-new, uncapped budget bucket, or name a real
   * *existing* parent's own `parentId` while forging a different
   * `parentAgentName`/`parentDepth`/depth-zero root claim to bypass that
   * parent's true per-parent FIFO/limits. Every `delegate()` call - root
   * or nested - must therefore resolve to one of exactly two legitimate
   * identities: the synthetic root, or a child this controller itself
   * currently tracks as live and not yet terminal.
   */
  private verifyParentIdentity(
    request: PiDelegationRequest,
  ): Result<void, string> {
    if (request.parentId === ROOT_NODE_ID) {
      if (request.parentDepth !== 0) return err("forged root depth");
      const rootAgentName = this.deps.rootAgentName?.();
      if (
        rootAgentName !== undefined &&
        request.parentAgentName !== rootAgentName
      ) {
        return err("forged root agent name");
      }
      return ok(undefined);
    }
    const parent = this.children.get(request.parentId);
    if (parent === undefined) return err("unknown parent reference");
    if (this.isTerminal(parent)) return err("parent is no longer live");
    if (parent.getAgentName() !== request.parentAgentName) {
      return err("forged parent agent name");
    }
    if (parent.getDepth() !== request.parentDepth) {
      return err("forged parent depth");
    }
    return ok(undefined);
  }

  private authorize(
    request: PiDelegationRequest,
  ): Result<
    DelegationAuthorizationDecision,
    DelegationAuthorizationError | DelegationLimitsError
  > {
    const limits = resolveEffectiveDelegationLimits(
      this.deps.config,
      request.parentAgentName,
    );
    if (limits.isErr()) return err(limits.error);
    return authorizeDelegation({
      limits: limits.value,
      directChildren: this.countDirectChildren(request.parentId),
      activeChildren: this.countActiveChildren(request.parentId),
      childDepth: request.parentDepth + 1,
      liveProcesses: this.countLiveProcesses(),
    });
  }

  private countDirectChildren(parentId: string): number {
    let count = 0;
    for (const child of this.children.values())
      if (child.getParentId() === parentId) count += 1;
    for (const queued of this.queue)
      if (queued.request.parentId === parentId) count += 1;
    return count;
  }

  private countActiveChildren(parentId: string): number {
    let count = 0;
    for (const child of this.children.values()) {
      if (child.getParentId() === parentId && !this.isTerminal(child))
        count += 1;
    }
    return count;
  }

  private countLiveProcesses(): number {
    let count = 0;
    for (const child of this.children.values())
      if (!this.isTerminal(child)) count += 1;
    return count;
  }

  private isTerminal(child: PiRpcChild): boolean {
    return child.isDisposed() || child.isSettled();
  }

  private enqueue(
    childId: string,
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        this.queue.push({ childId, request, resolve });
        this.notifyTreeChanged();
      }),
    );
  }

  private spawnNow(
    childId: string,
    request: PiDelegationRequest,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    const depth = request.parentDepth + 1;
    const child = new PiRpcChild(
      childId,
      request.parentId,
      this.deps.generationId,
      request.agentName,
      depth,
      {
        processPort: this.deps.processPort,
        randomPort: this.deps.randomPort,
        hmacPort: this.deps.hmacPort,
        timerPort: this.deps.timerPort,
        cancelGraceMs: this.deps.cancelGraceMs,
        baseEnv: this.deps.baseEnv,
        logger: this.deps.logger,
        command: this.deps.command,
        now: this.deps.now,
        onApprovalRequest: this.deps.onChildApprovalRequest,
        onDelegationRequest: (
          relayChildId,
          correlationId,
          body: PiDelegateRequestBody,
        ) =>
          this.handleChildDelegationRequest(relayChildId, correlationId, body),
      },
    );
    this.children.set(childId, child);
    this.notifyTreeChanged();
    this.ensureTreeRefreshTimer();
    const spawnInput = {
      childId,
      parentId: request.parentId,
      generationId: this.deps.generationId,
      agentName: request.agentName,
      depth,
      cwd: request.cwd,
      env: request.env,
      task: request.task,
    };
    return child
      .spawnAndHandshake(spawnInput)
      .andThen(() => child.runTask(spawnInput, request.bootstrap))
      .map((settlement) => {
        // The child itself already killed its own ephemeral process and
        // erased its secret as part of settling successfully; `dispose()`
        // here is the explicit, idempotent, controller-owned confirmation
        // that this slot is fully freed before any queued request is ever
        // promoted into it.
        child.dispose();
        this.promoteQueued();
        this.notifyTreeChanged();
        this.maybeStopTreeRefreshTimer();
        return settlement;
      })
      .orElse((failure) => {
        // Same guarantee on every failure path: the child's own terminal
        // failure handling already killed its process/erased its secret;
        // `dispose()` is the explicit confirmation before promotion.
        child.dispose();
        this.promoteQueued();
        this.notifyTreeChanged();
        this.maybeStopTreeRefreshTimer();
        return errAsync(failure);
      });
  }

  /**
   * Handles a live child's own relayed delegation request (Spec 33
   * §10-11): nested/descendant delegation is never an independent,
   * untracked budget - it is authorized and spawned through this exact
   * same {@link delegate} method, under the requesting child's own
   * identity/depth, against the same global tree/process budget as every
   * other delegation. Every outcome - invalid body, ineligible target,
   * capacity denial, or settlement - always sends exactly one correlated
   * `delegate-response` back to the requesting child; it never spawns
   * silently without a reply.
   */
  private handleChildDelegationRequest(
    childId: string,
    correlationId: string,
    body: PiDelegateRequestBody,
  ): void {
    const requester = this.children.get(childId);
    if (requester === undefined) return;
    const target = this.deps.resolveDelegationTarget?.(
      requester.getAgentName(),
      body.agentName,
    );
    if (target === undefined || this.deps.buildBootstrap === undefined) {
      void requester.sendDelegationResponse(correlationId, {
        ok: false,
        error: "invalid-delegation-target",
      });
      return;
    }
    // Generated up front (Spec 33 §11.2 Task 9) so it can be embedded as the
    // bootstrap's own `correlationId`, and reused verbatim as this request's
    // `childId` - the child that eventually spawns cross-checks the two
    // against each other and rejects a mismatch.
    const nestedChildId = this.deps.idGenerator.next();
    const bootstrap = this.deps.buildBootstrap(target, nestedChildId, {
      parentAgentName: requester.getAgentName(),
      parentDepth: requester.getDepth(),
      cwd: requester.getCwd(),
    });
    void this.delegate({
      parentId: childId,
      parentDepth: requester.getDepth(),
      parentAgentName: requester.getAgentName(),
      agentName: body.agentName,
      task: body.task,
      cwd: requester.getCwd(),
      env: {},
      bootstrap,
      childId: nestedChildId,
    }).match(
      (settlement) => {
        void requester.sendDelegationResponse(correlationId, {
          ok: true,
          settlement,
        });
      },
      (failure) => {
        void requester.sendDelegationResponse(correlationId, {
          ok: false,
          error: failure.code,
        });
      },
    );
  }

  private notifyTreeChanged(): void {
    this.deps.onTreeChanged?.();
  }

  private ensureTreeRefreshTimer(): void {
    if (this.treeRefreshTimer !== undefined) return;
    if (this.deps.onTreeChanged === undefined) return;
    const timerPort = this.deps.timerPort;
    if (timerPort === undefined) return;
    const intervalMs =
      this.deps.treeRefreshIntervalMs ?? DEFAULT_TREE_REFRESH_INTERVAL_MS;
    const tick = (): void => {
      if (this.disposedAll) return;
      this.notifyTreeChanged();
      if (this.snapshotTree().length === 0) {
        this.treeRefreshTimer = undefined;
        return;
      }
      this.treeRefreshTimer = timerPort.schedule(tick, intervalMs);
    };
    this.treeRefreshTimer = timerPort.schedule(tick, intervalMs);
  }

  private maybeStopTreeRefreshTimer(): void {
    if (this.snapshotTree().length > 0) return;
    this.treeRefreshTimer?.cancel();
    this.treeRefreshTimer = undefined;
  }

  /** Scans the queue front-to-back and promotes the first entry whose authorization now succeeds. Repeats until no progress. */
  private promoteQueued(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        if (entry === undefined) continue;
        const decision = this.authorize(entry.request);
        if (decision.isErr() || decision.value.outcome !== "authorized")
          continue;
        this.queue.splice(i, 1);
        void this.spawnNow(entry.childId, entry.request).match(
          (settlement) => entry.resolve(ok(settlement)),
          (failure) => entry.resolve(err(failure)),
        );
        progressed = true;
        break;
      }
    }
  }

  /** Cancels a node and every descendant, removing any not-yet-spawned queued requests under that subtree. */
  cancelSubtree(
    nodeId: string,
  ): ResultAsync<void, readonly PiAdapterFailure[]> {
    if (this.disposedAll) return ResultAsync.fromSafePromise(Promise.resolve());
    const ids = subtreeIds(this.snapshotNodesForSubtreeLookup(), nodeId);
    const idSet = new Set(ids);
    this.dropQueuedUnder(idSet);
    const cancellations = ids
      .map((id) => this.children.get(id))
      .filter((child): child is PiRpcChild => child !== undefined)
      .map((child) => child.cancel());
    return ResultAsync.combineWithAllErrors(cancellations).map(() => {
      this.notifyTreeChanged();
      this.maybeStopTreeRefreshTimer();
      return undefined;
    });
  }

  private dropQueuedUnder(idSet: ReadonlySet<string>): void {
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const entry = this.queue[i];
      if (entry === undefined) continue;
      if (!idSet.has(entry.request.parentId) && !idSet.has(entry.childId))
        continue;
      this.queue.splice(i, 1);
      entry.resolve(
        err(
          makeChildAbortFailedFailure(
            entry.childId,
            "queued request cancelled",
          ),
        ),
      );
    }
  }

  /**
   * Builds the node map `subtreeIds` walks for cancellation (Spec 33
   * §11.5). MUST include not-yet-spawned queued requests, not just live
   * children: a queued descendant's own `parentId` may itself be another
   * queued (not-yet-live) request, never present in `this.children` -
   * omitting queued nodes here would make depth-2+ queued chains under a
   * cancelled subtree invisible to the BFS traversal and leave them
   * un-cancelled, spawning later under a since-cancelled ancestor. Uses
   * the exact same live+queued node set, in the exact same deterministic
   * order, as {@link snapshotTree} so tree state and cancellation always
   * agree on what the tree currently contains.
   */
  private snapshotNodesForSubtreeLookup(): ReadonlyMap<
    string,
    PiChildTreeNode
  > {
    const map = new Map<string, PiChildTreeNode>();
    for (const node of this.snapshotTree()) map.set(node.id, node);
    return map;
  }

  /**
   * Bounded inspectable tree state for all children in this generation
   * (Spec 33 §11.5), including not-yet-spawned queued requests (shown with
   * status `"queued"`) so a caller-side FIFO backlog is never invisible.
   * Excludes the synthetic root node.
   */
  snapshotTree(): readonly PiChildTreeNode[] {
    const live = Array.from(this.children.values(), (child) =>
      child.snapshot(),
    );
    const now = this.deps.now?.() ?? Date.now();
    const queued: PiChildTreeNode[] = this.queue.map((entry) => ({
      id: entry.childId,
      parentId: entry.request.parentId,
      name: entry.request.agentName,
      status: "queued",
      currentTurn: 0,
      currentTool: undefined,
      startedAtMs: now,
      elapsedMs: 0,
      usage: EMPTY_USAGE_AGGREGATE,
      latestOutput: "",
    }));
    return [...live, ...queued];
  }

  /** Cumulative usage across every child in this generation's tree (Spec 33 §11.5/§19.4), live and terminal alike. */
  snapshotCumulativeUsage(): PiChildTreeNode["usage"] {
    let total = EMPTY_USAGE_AGGREGATE;
    for (const child of this.children.values()) {
      total = addUsage(total, child.snapshot().usage);
    }
    return total;
  }

  /** Delivers the parent's answer to one of a live child's own relayed approval requests. */
  respondToApproval(
    childId: string,
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    if (this.disposedAll) {
      return errAsync(
        makeUiBridgeFailedFailure(childId, "controller disposed"),
      );
    }
    const child = this.children.get(childId);
    if (child === undefined) {
      return errAsync(makeUiBridgeFailedFailure(childId, "unknown-child"));
    }
    return child.sendApprovalResponse(correlationId, body);
  }

  /** Idempotent whole-tree teardown: cancels every live child, drains the queue, clears every secret. Safe to call more than once. */
  disposeAll(): void {
    if (this.disposedAll) return;
    this.disposedAll = true;
    for (const entry of this.queue.splice(0)) {
      entry.resolve(
        err(makeChildAbortFailedFailure(entry.childId, "controller shut down")),
      );
    }
    for (const child of this.children.values()) child.dispose();
    this.treeRefreshTimer?.cancel();
    this.treeRefreshTimer = undefined;
    this.notifyTreeChanged();
  }
}

export type { DelegationAuthorizationError, DelegationLimitsError };
