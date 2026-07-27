/**
 * Owns one delegated child's full parent-side lifecycle (Pi adapter contract
 * §11.2-§11.5): spawns `pi --mode rpc --no-session` via the injected
 * process port, injects an independent 256-bit secret via environment
 * only, awaits the authenticated handshake before treating the child as
 * live, sends the bootstrap descriptor and task through legitimate `prompt`
 * RPC commands (never `steer`/`follow_up`), streams ordinary RPC events
 * into bounded tree telemetry and deduplicated usage projection, and
 * enforces authenticated cancellation/settlement with fail-closed timeouts
 * and idempotent cleanup.
 *
 * Every terminal outcome - success, protocol failure, authentication
 * failure, framing violation, timeout, or unexpected process exit - flows
 * through exactly one place, {@link PiRpcChild.failOutstanding} (for
 * failures) or the success paths that call
 * {@link PiRpcChild.terminateResources} directly, so the underlying
 * process is always killed and the secret always erased on every path,
 * while the final inspectable `status` (`"failed"` vs `"completed"` vs
 * `"cancelled"`) is preserved rather than clobbered by later cleanup.
 */
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import {
  type PiApprovalRequestBody,
  type PiBootstrapAckBody,
  type PiBootstrapBody,
  type PiDelegateRequestBody,
  parseControlBody,
} from "./child-control-bodies.js";
import {
  bytesToHex,
  type ErasableSecret,
  generateChildSecret,
  generateNonceHex,
  type HmacPort,
  type RandomPort,
} from "./child-crypto.js";
import {
  WEAVE_CHILD_AGENT_NAME_ENV,
  WEAVE_CHILD_DEPTH_ENV,
  WEAVE_CHILD_ID_ENV,
  WEAVE_CHILD_PARENT_ID_ENV,
  WEAVE_CHILD_SECRET_ENV,
  WEAVE_CONTROLLER_GENERATION_ENV,
} from "./child-env.js";
import {
  looksLikeControlEnvelope,
  PiChildAuthState,
  type PiControlEnvelope,
  type PiControlKind,
  signEnvelope,
  verifyEnvelope,
} from "./child-envelope.js";
import { PiLineFramer } from "./child-framing.js";
import type {
  PiChildProcessPort,
  PiSpawnedChildProcess,
} from "./child-process-port.js";
import {
  DEFAULT_CANCEL_GRACE_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REPLY_TIMEOUT_MS,
  DEFAULT_SETTLEMENT_TIMEOUT_MS,
  SystemTimerPort,
  type TimerPort,
} from "./child-timer.js";
import {
  addUsage,
  EMPTY_USAGE_AGGREGATE,
  extractAssistantTextDeltaPreview,
  type PiChildStatus,
  type PiChildTreeNode,
  type PiChildUsageAggregate,
  truncateLatestOutput,
} from "./child-tree.js";
import { MAX_TASK_INPUT_CHARS } from "./delegation-limits.js";
import {
  makeChildAbortFailedFailure,
  makeChildAuthenticationFailedFailure,
  makeChildEnvelopeMalformedFailure,
  makeChildEnvelopeReplayFailure,
  makeChildExitedUnexpectedlyFailure,
  makeChildHandshakeMissingFailure,
  makeChildReplyDuplicateFailure,
  makeChildReplyLateFailure,
  makeChildReplyMissingFailure,
  makeChildSettlementMissingFailure,
  makeChildSpawnFailedFailure,
  type PiAdapterFailure,
} from "./errors.js";
import type { JsonValue } from "./strict-json.js";
import type { PiAdapterLogger } from "./types.js";

export interface PiRpcChildDeps {
  readonly processPort: PiChildProcessPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly timerPort?: TimerPort;
  readonly logger: PiAdapterLogger;
  readonly command?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
  readonly settlementTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly now?: () => number;
  /**
   * A sanitized base environment (e.g. `PATH`/`HOME`) merged in *before*
   * `input.env` and the `WEAVE_CHILD_*` bootstrap variables, so the
   * spawned `pi` process can actually be located and run. Defaults to `{}`
   * (tests are unaffected); production wiring supplies a real sanitized
   * snapshot (see `sanitizedBaseEnv` in `child-env.ts`).
   */
  readonly baseEnv?: Readonly<Record<string, string>>;
  /**
   * Invoked when this child relays one of its own governed tool-call
   * approval prompts (Spec 33 §11.5/§12). The caller (the delegation
   * controller / compiled extension) must show it to the sole parent TUI
   * under the child's own identity and eventually call
   * {@link PiRpcChild.sendApprovalResponse} with the matching correlationId.
   */
  readonly onApprovalRequest?: (
    childId: string,
    correlationId: string,
    request: PiApprovalRequestBody,
  ) => void;
  /**
   * Invoked when this child relays a request to delegate further work of
   * its own (Pi adapter contract: nested/descendant delegation). The caller
   * (the delegation controller) must authorize it under this child's own
   * identity/depth against the SAME global tree/process budget as every
   * other delegation - never an independent, untracked budget - and
   * eventually call {@link PiRpcChild.sendDelegationResponse} with the
   * matching correlationId.
   */
  readonly onDelegationRequest?: (
    childId: string,
    correlationId: string,
    request: PiDelegateRequestBody,
  ) => void;
  /**
   * Invoked once per settled assistant message this child reports (Pi adapter contract
   * §19.4), immediately after the existing in-memory `usage` aggregate is
   * updated. Carries only bounded safe scalars (a stable message id and
   * optional non-negative token/cost counters) — never raw text. The
   * caller (delegation controller) is responsible for recording this as a
   * durable usage observation via the injected telemetry seam; a no-op
   * default here keeps every existing construction site unaffected.
   */
  readonly onAssistantUsageObserved?: (usage: {
    readonly id: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly cost?: number;
  }) => void;
}

export interface PiRpcChildSpawnInput {
  readonly childId: string;
  readonly parentId: string;
  readonly generationId: string;
  readonly agentName: string;
  readonly depth: number;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly task: string;
}

export type PiChildSettlement =
  | { readonly outcome: "completed"; readonly summary: string }
  | { readonly outcome: "failed"; readonly reason: string }
  | { readonly outcome: "cancelled" };

const DEFAULT_COMMAND = ["pi", "--mode", "rpc", "--no-session"] as const;

/** Parent-to-child kinds a well-behaved child never sends back to the parent; receiving one is always an unknown/illegal incoming kind. */
const ILLEGAL_INCOMING_KINDS: ReadonlySet<PiControlKind> = new Set([
  "bootstrap",
  "cancel",
  "approval-response",
  "delegate-response",
]);

export class PiRpcChild {
  private readonly childId: string;
  private readonly parentId: string;
  private readonly generationId: string;
  private readonly agentName: string;
  private readonly depth: number;
  private readonly processPort: PiChildProcessPort;
  private readonly randomPort: RandomPort;
  private readonly hmacPort: HmacPort;
  private readonly timerPort: TimerPort;
  private readonly logger: PiAdapterLogger;
  private readonly command: readonly string[];
  private readonly handshakeTimeoutMs: number;
  private readonly settlementTimeoutMs: number;
  private readonly now: () => number;
  private readonly onApprovalRequest:
    | ((
        childId: string,
        correlationId: string,
        request: PiApprovalRequestBody,
      ) => void)
    | undefined;
  private readonly onDelegationRequest:
    | ((
        childId: string,
        correlationId: string,
        request: PiDelegateRequestBody,
      ) => void)
    | undefined;
  private readonly onAssistantUsageObserved:
    | ((usage: {
        readonly id: string;
        readonly inputTokens?: number;
        readonly outputTokens?: number;
        readonly cacheReadTokens?: number;
        readonly cacheWriteTokens?: number;
        readonly cost?: number;
      }) => void)
    | undefined;
  private cwd = "";

  private secret: ErasableSecret | undefined;
  private authState: PiChildAuthState | undefined;
  private process: PiSpawnedChildProcess | undefined;
  private readonly framer = new PiLineFramer();
  private disposed = false;
  private startedAtMs = 0;

  private status: PiChildStatus = "queued";
  private currentTurn = 0;
  private currentTool: string | undefined;
  private usage: PiChildUsageAggregate = EMPTY_USAGE_AGGREGATE;
  private latestOutput = "";
  private readonly seenUsageMessageIds = new Set<string>();

  private handshakeResolvers:
    | { resolve: () => void; reject: (failure: PiAdapterFailure) => void }
    | undefined;
  private bootstrapAckResolvers:
    | {
        resolve: (body: PiBootstrapAckBody) => void;
        reject: (failure: PiAdapterFailure) => void;
      }
    | undefined;
  private settlementResolvers:
    | {
        resolve: (settlement: PiChildSettlement) => void;
        reject: (failure: PiAdapterFailure) => void;
      }
    | undefined;
  private cancelResolvers: { resolve: () => void } | undefined;
  private settled = false;
  private readonly replyTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly baseEnv: Readonly<Record<string, string>>;

  constructor(
    childId: string,
    parentId: string,
    generationId: string,
    agentName: string,
    depth: number,
    deps: PiRpcChildDeps,
  ) {
    this.childId = childId;
    this.parentId = parentId;
    this.generationId = generationId;
    this.agentName = agentName;
    this.depth = depth;
    this.processPort = deps.processPort;
    this.randomPort = deps.randomPort;
    this.hmacPort = deps.hmacPort;
    this.timerPort = deps.timerPort ?? new SystemTimerPort();
    this.logger = deps.logger;
    this.command = deps.command ?? DEFAULT_COMMAND;
    this.handshakeTimeoutMs =
      deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.settlementTimeoutMs =
      deps.settlementTimeoutMs ?? DEFAULT_SETTLEMENT_TIMEOUT_MS;
    this.replyTimeoutMs = deps.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
    this.cancelGraceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    this.baseEnv = deps.baseEnv ?? {};
    this.now = deps.now ?? (() => Date.now());
    this.onApprovalRequest = deps.onApprovalRequest;
    this.onDelegationRequest = deps.onDelegationRequest;
    this.onAssistantUsageObserved = deps.onAssistantUsageObserved;
  }

  getId(): string {
    return this.childId;
  }
  getParentId(): string {
    return this.parentId;
  }
  getAgentName(): string {
    return this.agentName;
  }
  getDepth(): number {
    return this.depth;
  }
  getCwd(): string {
    return this.cwd;
  }
  isSettled(): boolean {
    return this.settled;
  }
  isDisposed(): boolean {
    return this.disposed;
  }

  snapshot(): PiChildTreeNode {
    return {
      id: this.childId,
      parentId: this.parentId,
      name: this.agentName,
      status: this.status,
      currentTurn: this.currentTurn,
      currentTool: this.currentTool,
      startedAtMs: this.startedAtMs,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
      usage: this.usage,
      latestOutput: this.latestOutput,
    };
  }

  /** Spawns the process, injects the secret via environment only, and awaits the authenticated handshake before returning. */
  spawnAndHandshake(
    input: PiRpcChildSpawnInput,
  ): ResultAsync<void, PiAdapterFailure> {
    this.startedAtMs = this.now();
    this.status = "spawning";
    this.cwd = input.cwd;
    this.secret = generateChildSecret(this.randomPort);
    this.authState = new PiChildAuthState(this.childId, this.generationId);
    const secretBytes = this.secret.peek();
    if (secretBytes === undefined) {
      const failure = makeChildSpawnFailedFailure(
        this.childId,
        "secret unavailable",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    const env: Record<string, string> = {
      ...this.baseEnv,
      ...input.env,
      [WEAVE_CHILD_SECRET_ENV]: bytesToHex(secretBytes),
      [WEAVE_CHILD_ID_ENV]: this.childId,
      [WEAVE_CHILD_PARENT_ID_ENV]: this.parentId,
      [WEAVE_CONTROLLER_GENERATION_ENV]: this.generationId,
      [WEAVE_CHILD_AGENT_NAME_ENV]: this.agentName,
      [WEAVE_CHILD_DEPTH_ENV]: String(this.depth),
    };
    return this.processPort
      .spawn({ command: this.command, env, cwd: input.cwd })
      .mapErr((spawnError) =>
        makeChildSpawnFailedFailure(this.childId, spawnError.reason),
      )
      .andThen((spawned) => {
        this.process = spawned;
        this.status = "handshaking";
        // Install the resolver *before* wiring the transport, so any
        // authenticated handshake dispatched the instant the listener is
        // attached (or, in principle, buffered/replayed by the port)
        // always finds a live waiter rather than racing it (Pi adapter contract
        // fail-closed authentication - a lost handshake must never look
        // like an unauthenticated child).
        const handshakeWait = this.awaitHandshake();
        this.wireStdout(spawned);
        this.wireExit(spawned);
        return handshakeWait;
      })
      .orElse((failure) => {
        // Every terminal failure - spawn, framing, or a handshake that
        // never arrives - must stop/kill the process and erase the secret,
        // never merely reject the current waiter and leak the rest.
        this.failOutstanding(failure);
        return errAsync(failure);
      });
  }

  private wireStdout(spawned: PiSpawnedChildProcess): void {
    spawned.stdout.onData((chunk) => {
      const result = this.framer.push(chunk);
      if (result.isErr()) {
        this.logger.warn(
          { childId: this.childId, framingError: result.error.type },
          "private child transport framing violation; stopping child",
        );
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(this.childId, result.error.type),
        );
        return;
      }
      for (const frame of result.value) this.handleLine(frame.json);
    });
    spawned.stdout.onEnd(() => this.handleProcessExit(null));
    spawned.stdout.onError(() => this.handleProcessExit(null));
  }

  /** Observes the process's own real exit code (Pi adapter contract) rather than relying solely on the stdout stream ending. */
  private wireExit(spawned: PiSpawnedChildProcess): void {
    spawned.exited.then(
      (exitCode) => this.handleProcessExit(exitCode),
      () => this.handleProcessExit(null),
    );
  }

  private handleProcessExit(exitCode: number | null): void {
    if (this.disposed || this.settled) return;
    if (this.status === "cancelling") {
      // Exit during a cancellation in progress is the expected outcome,
      // not an unexpected-exit failure - complete the cancellation
      // immediately (resolving both the bounded cancel wait and this
      // child's own settlement as `cancelled`, as required by the Pi adapter contract) rather than
      // force-waiting out the grace period.
      this.completeCancellation();
      return;
    }
    this.failOutstanding(
      makeChildExitedUnexpectedlyFailure(this.childId, exitCode),
    );
  }

  private handleLine(json: JsonValue): void {
    if (looksLikeControlEnvelope(json)) {
      this.handleControlLine(json);
      return;
    }
    this.handleOrdinaryEvent(json);
  }

  private handleControlLine(json: JsonValue): void {
    if (this.disposed) return;
    const secretBytes = this.secret?.peek();
    const authState = this.authState;
    if (secretBytes === undefined || authState === undefined) {
      // Never silently ignore an incoming control line just because our
      // own activation state is missing - fail closed rather than leave
      // the caller waiting on a resolver that can now never be satisfied.
      this.failOutstanding(
        makeChildAuthenticationFailedFailure(this.childId, "not-activated"),
      );
      return;
    }
    void verifyEnvelope(json, secretBytes, this.hmacPort).match(
      (envelope) => this.admitControlEnvelope(envelope, authState),
      (envelopeError) => {
        this.logger.warn(
          { childId: this.childId, reason: envelopeError.type },
          "private control envelope failed verification",
        );
        this.failOutstanding(
          makeChildAuthenticationFailedFailure(
            this.childId,
            envelopeError.type,
          ),
        );
      },
    );
  }

  private admitControlEnvelope(
    envelope: PiControlEnvelope,
    authState: PiChildAuthState,
  ): void {
    const admitted = authState.admitIncoming(envelope);
    if (admitted.isErr()) {
      const failure =
        admitted.error.type === "NonceReplay"
          ? makeChildEnvelopeReplayFailure(this.childId)
          : makeChildEnvelopeMalformedFailure(
              this.childId,
              admitted.error.type,
            );
      this.failOutstanding(failure);
      return;
    }
    this.dispatchControlKind(envelope);
  }

  /**
   * Enforces the child's strict protocol state machine (Pi adapter contract):
   * `handshake` only while awaiting it, `bootstrap-ack` only while a
   * bootstrap is outstanding, `settled` only once bootstrap has been
   * confirmed applied, `cancelled` only while a cancellation is in
   * flight, `approval-request`/`delegate-request` only once running. Any
   * message arriving out of this order - duplicated, premature, late, or
   * of an unknown/illegal kind - fails closed instead of being silently
   * accepted or merely observed.
   */
  private dispatchControlKind(envelope: PiControlEnvelope): void {
    if (envelope.kind === "handshake") {
      if (this.status !== "handshaking") {
        // The only way to observe a second `handshake` is a duplicate or a
        // late arrival after the child's lifecycle already advanced past
        // it - never a genuinely new/different kind of protocol error.
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const resolvers = this.handshakeResolvers;
      this.handshakeResolvers = undefined;
      resolvers?.resolve();
      return;
    }
    if (envelope.kind === "bootstrap-ack") {
      if (
        this.status !== "bootstrapping" ||
        this.bootstrapAckResolvers === undefined
      ) {
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const parsedAck = parseControlBody("bootstrap-ack", envelope.body);
      if (!parsedAck.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(this.childId, "bootstrap-ack-body"),
        );
        return;
      }
      this.status = "running";
      const resolvers = this.bootstrapAckResolvers;
      this.bootstrapAckResolvers = undefined;
      resolvers.resolve(parsedAck.value);
      return;
    }
    if (envelope.kind === "settled") {
      if (this.status === "cancelling") {
        // Legitimate race, never a protocol violation (Pi adapter contract): the
        // raw RPC `abort` command this parent writes right after the
        // authenticated `cancel` envelope (see `cancel()`) can end the
        // child's current turn before the queued hidden-command prompt
        // carrying that `cancel` envelope is even dispatched by the exact
        // host, so the child's own extension reports an ordinary
        // `settled` envelope for the aborted turn before it ever admits
        // the cancel and reports `cancelled` itself. Cancelling an
        // ordinary helper always yields a structured cancelled result to
        // its parent regardless of which control kind this race lets the
        // child report first - still validate the body shape (defense in
        // depth) before treating it as the cancellation's own outcome.
        const parsed = parseControlBody("settled", envelope.body);
        if (!parsed.ok) {
          this.failOutstanding(
            makeChildEnvelopeMalformedFailure(
              this.childId,
              "settled-body-invalid",
            ),
          );
          return;
        }
        this.completeCancellation();
        return;
      }
      if (!this.settled && this.status !== "running") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "premature-settlement",
          ),
        );
        return;
      }
      this.completeSettlement(envelope);
      return;
    }
    if (envelope.kind === "cancelled") {
      if (this.status !== "cancelling") {
        this.failOutstanding(makeChildReplyLateFailure(this.childId));
        return;
      }
      const parsed = parseControlBody("cancelled", envelope.body);
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "cancelled-body-invalid",
          ),
        );
        return;
      }
      this.completeCancellation();
      return;
    }
    if (envelope.kind === "error") {
      const parsed = parseControlBody("error", envelope.body);
      const reason = parsed.ok ? parsed.value.reason : "child reported error";
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(this.childId, reason),
      );
      return;
    }
    if (envelope.kind === "approval-request") {
      if (this.status !== "running") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "unexpected-approval-request",
          ),
        );
        return;
      }
      const parsed = parseControlBody("approval-request", envelope.body);
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "approval-request-body-invalid",
          ),
        );
        return;
      }
      this.onApprovalRequest?.(
        this.childId,
        envelope.correlationId,
        parsed.value,
      );
      return;
    }
    if (envelope.kind === "delegate-request") {
      if (this.status !== "running") {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "unexpected-delegate-request",
          ),
        );
        return;
      }
      const parsed = parseControlBody("delegate-request", envelope.body);
      if (!parsed.ok) {
        this.failOutstanding(
          makeChildEnvelopeMalformedFailure(
            this.childId,
            "delegate-request-body-invalid",
          ),
        );
        return;
      }
      this.onDelegationRequest?.(
        this.childId,
        envelope.correlationId,
        parsed.value,
      );
      return;
    }
    // `envelope.kind` is one of the closed `PiControlKind` enum, but the
    // remaining values (`bootstrap`, `cancel`, `approval-response`,
    // `delegate-response`) are parent-to-child-only kinds a well-behaved
    // child never sends back to us. Receiving one here is always an
    // unknown/illegal incoming kind and must fail closed rather than be
    // silently ignored.
    if (ILLEGAL_INCOMING_KINDS.has(envelope.kind)) {
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(
          this.childId,
          "unexpected-incoming-kind",
        ),
      );
    }
  }

  /** Answers one of this child's own relayed approval requests, correlated by id. */
  sendApprovalResponse(
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.sendControl("approval-response", correlationId, body);
  }

  /** Answers one of this child's own relayed delegation requests, correlated by id (Pi adapter contract). */
  sendDelegationResponse(
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    return this.sendControl("delegate-response", correlationId, body);
  }

  /**
   * The single terminal-cancellation path (Pi adapter contract): resolves this
   * child's own outstanding settlement wait (`runTask()`/`awaitSettlement`)
   * with a structured `{ outcome: "cancelled" }` result - never an error -
   * and resolves the bounded `cancel()` wait too, before terminating
   * resources. Reachable from every legitimate way a requested
   * cancellation can actually conclude: an authenticated `cancelled` ack,
   * a racing `settled` report for the aborted turn, the process exiting
   * mid-cancellation, or the bounded grace period elapsing with no reply
   * at all. Idempotent via the same `settled` guard as normal settlement.
   */
  private completeCancellation(): void {
    if (this.settled) return;
    this.settled = true;
    this.status = "cancelled";
    const settlementResolvers = this.settlementResolvers;
    this.settlementResolvers = undefined;
    if (settlementResolvers !== undefined) {
      // A task was genuinely dispatched and running - Pi adapter contract
      // requires cancelling an ordinary helper to resolve as a structured
      // cancelled result, never an error.
      settlementResolvers.resolve({ outcome: "cancelled" });
    } else {
      // Cancelled before the child ever reached a running task (still
      // handshaking or awaiting its bootstrap-ack) - there is no
      // in-flight task to report a structured cancelled *settlement* for,
      // so the caller's own spawn/handshake/bootstrap wait must still
      // fail closed rather than hang forever with nothing to resolve it.
      const failure = makeChildAbortFailedFailure(
        this.childId,
        "cancelled-before-running",
      );
      const handshakeResolvers = this.handshakeResolvers;
      this.handshakeResolvers = undefined;
      handshakeResolvers?.reject(failure);
      const bootstrapAckResolvers = this.bootstrapAckResolvers;
      this.bootstrapAckResolvers = undefined;
      bootstrapAckResolvers?.reject(failure);
    }
    const cancelResolvers = this.cancelResolvers;
    this.cancelResolvers = undefined;
    cancelResolvers?.resolve();
    this.terminateResources();
  }

  private completeSettlement(envelope: PiControlEnvelope): void {
    if (this.settled) {
      this.failOutstanding(makeChildReplyDuplicateFailure(this.childId));
      return;
    }
    const parsed = parseControlBody("settled", envelope.body);
    if (!parsed.ok) {
      this.failOutstanding(
        makeChildEnvelopeMalformedFailure(this.childId, "settled-body-invalid"),
      );
      return;
    }
    this.settled = true;
    this.status = "completed";
    const settlement: PiChildSettlement =
      parsed.value.outcome === "failed"
        ? { outcome: "failed", reason: parsed.value.reason ?? "unknown" }
        : {
            outcome: "completed",
            summary: truncateLatestOutput(parsed.value.summary ?? ""),
          };
    const resolvers = this.settlementResolvers;
    this.settlementResolvers = undefined;
    resolvers?.resolve(settlement);
    // A settled child is done for good - kill the now-ephemeral process
    // and erase its secret immediately rather than leaving it running
    // until some later, unrelated cleanup call happens to arrive.
    this.terminateResources();
  }

  private handleOrdinaryEvent(json: JsonValue): void {
    if (typeof json !== "object" || json === null || Array.isArray(json))
      return;
    const record = json as Record<string, JsonValue>;
    const type = record.type;
    if (type === "turn_start") {
      this.currentTurn += 1;
      // Latest output is transient under the Pi adapter contract: a new turn starts a
      // fresh transient buffer rather than carrying the previous turn's
      // trailing text forward forever.
      this.latestOutput = "";
      return;
    }
    if (type === "tool_execution_start") {
      const toolName = record.toolName;
      if (typeof toolName === "string") this.currentTool = toolName;
      return;
    }
    if (type === "tool_execution_end") {
      this.currentTool = undefined;
      return;
    }
    if (type === "message_update") {
      const preview = extractAssistantTextDeltaPreview(record);
      if (preview !== undefined) {
        // Accumulate streamed deltas into the current transient buffer
        // rather than replacing it with only the very last delta -
        // `truncateLatestOutput` keeps the combined buffer bounded to
        // <=4KiB of valid UTF-8 at a code-point boundary.
        this.latestOutput = truncateLatestOutput(this.latestOutput + preview);
      }
      return;
    }
    if (type === "message_end" || type === "agent_settled") {
      this.projectUsageFromMessage(record);
    }
  }

  private projectUsageFromMessage(record: Record<string, JsonValue>): void {
    const message = record.message;
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    )
      return;
    const messageRecord = message as Record<string, JsonValue>;
    if (messageRecord.role !== "assistant") return;
    const idCandidate = messageRecord.id ?? messageRecord.responseId;
    if (typeof idCandidate !== "string" || idCandidate.length === 0) return;
    const id = idCandidate;
    if (this.seenUsageMessageIds.has(id)) return;
    const usageValue = messageRecord.usage;
    if (
      typeof usageValue !== "object" ||
      usageValue === null ||
      Array.isArray(usageValue)
    )
      return;
    const usageRecord = usageValue as Record<string, JsonValue>;
    this.seenUsageMessageIds.add(id);
    const projected = {
      inputTokens: safeNumberField(usageRecord, "input"),
      outputTokens: safeNumberField(usageRecord, "output"),
      cacheReadTokens: safeNumberField(usageRecord, "cacheRead"),
      cacheWriteTokens: safeNumberField(usageRecord, "cacheWrite"),
      cost: extractCostTotal(usageRecord),
    };
    this.usage = addUsage(this.usage, projected);
    this.onAssistantUsageObserved?.({ id, ...projected });
  }

  private awaitHandshake(): ResultAsync<void, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          this.failOutstanding(makeChildHandshakeMissingFailure(this.childId));
        }, this.handshakeTimeoutMs);
        this.handshakeResolvers = {
          resolve: () => {
            timer.cancel();
            resolve(ok(undefined));
          },
          reject: (failure) => {
            timer.cancel();
            resolve(err(failure));
          },
        };
      }),
    );
  }

  private sendControl(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiAdapterFailure> {
    const secretBytes = this.secret?.peek();
    const authState = this.authState;
    if (
      secretBytes === undefined ||
      authState === undefined ||
      this.process === undefined
    ) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "secret unavailable",
        ),
      );
    }
    const sequence = authState.allocateOutgoingSequence();
    return signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "parent-to-child",
        sequence,
        nonce: generateNonceHex(this.randomPort),
        correlationId,
        kind,
        body,
      },
      secretBytes,
      this.hmacPort,
    )
      .mapErr(
        (envelopeError): PiAdapterFailure =>
          makeChildEnvelopeMalformedFailure(this.childId, envelopeError.type),
      )
      .andThen((envelope) => this.deliverControlEnvelope(envelope));
  }

  private deliverControlEnvelope(
    envelope: PiControlEnvelope,
  ): ResultAsync<void, PiAdapterFailure> {
    const process = this.process;
    if (process === undefined) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "process unavailable",
        ),
      );
    }
    const commandLine = `${JSON.stringify({
      type: "prompt",
      message: `/weave:__control__ ${JSON.stringify(envelope)}`,
    })}\n`;
    const writeResult = process.writeStdin(
      new TextEncoder().encode(commandLine),
    );
    if (writeResult.isErr()) {
      return errAsync(
        makeChildSpawnFailedFailure(this.childId, writeResult.error.reason),
      );
    }
    return new ResultAsync(Promise.resolve(ok(undefined)));
  }

  /**
   * Sends the bootstrap descriptor and waits for the child's authenticated
   * `bootstrap-ack` (proving it actually applied the descriptor/model/tool
   * policy) before sending any task work, then awaits authenticated
   * settlement. Never sends work on the strength of the bootstrap send
   * alone. Both waits are installed *before* the corresponding send, so a
   * synchronous/fast reply can never race ahead of the resolver meant to
   * catch it (Pi adapter contract).
   */
  runTask(
    input: PiRpcChildSpawnInput,
    bootstrap: JsonValue,
  ): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    if (input.task.length < 1 || input.task.length > MAX_TASK_INPUT_CHARS) {
      const failure = makeChildEnvelopeMalformedFailure(
        this.childId,
        "task-too-large",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    // Re-parses what this parent itself is about to send, so the ack
    // validation below has a trustworthy expectation to compare against
    // rather than trusting the caller-supplied `bootstrap` value blindly
    // (Pi adapter contract).
    const expectedBootstrap = parseControlBody("bootstrap", bootstrap);
    if (!expectedBootstrap.ok) {
      const failure = makeChildEnvelopeMalformedFailure(
        this.childId,
        "bootstrap-body-invalid",
      );
      this.failOutstanding(failure);
      return errAsync(failure);
    }
    this.status = "bootstrapping";
    const bootstrapAckWait = this.awaitBootstrapAck();
    return this.sendControl("bootstrap", input.childId, bootstrap)
      .andThen(() => bootstrapAckWait)
      .andThen((ack) => this.validateBootstrapAck(expectedBootstrap.value, ack))
      .andThen(() => {
        const settlementWait = this.awaitSettlement();
        return this.sendTaskPrompt(input.task).andThen(() => settlementWait);
      })
      .orElse((failure) => {
        this.failOutstanding(failure);
        return errAsync(failure);
      });
  }

  /**
   * The authenticated ack alone is not enough: this parent must also
   * confirm the child actually applied *the exact* active-tool set and
   * model identity it was told to (Spec 33 §11.2 Task 9). Any mismatch -
   * an extra/missing tool name or a different model identity than what
   * this parent sent/expected - fails closed rather than silently
   * proceeding to send task work to a child that may not be running with
   * the intended capabilities.
   */
  private validateBootstrapAck(
    expected: PiBootstrapBody,
    ack: PiBootstrapAckBody,
  ): ResultAsync<void, PiAdapterFailure> {
    const expectedTools = new Set(expected.activeTools);
    const ackTools = new Set(ack.activeTools);
    const toolsMatch =
      expectedTools.size === ackTools.size &&
      [...expectedTools].every((name) => ackTools.has(name));
    if (!toolsMatch) {
      return errAsync(
        makeChildAuthenticationFailedFailure(
          this.childId,
          "bootstrap-ack-active-tools-mismatch",
        ),
      );
    }
    // Only enforced when this parent itself resolved a concrete model
    // identity (root-level delegation): the child must apply and echo
    // back exactly that identity, no substitutions. When this parent sent
    // no `resolvedModel` (nested/relayed delegation), the child resolved
    // against its own authenticated catalog and its ack is informational
    // only - Pi adapter contract graceful degradation applies, so no match is
    // required here.
    if (expected.resolvedModel !== undefined) {
      const modelMatches =
        ack.resolvedModel !== undefined &&
        expected.resolvedModel.provider === ack.resolvedModel.provider &&
        expected.resolvedModel.id === ack.resolvedModel.id;
      if (!modelMatches) {
        return errAsync(
          makeChildAuthenticationFailedFailure(
            this.childId,
            "bootstrap-ack-model-mismatch",
          ),
        );
      }
    }
    return okAsync(undefined);
  }

  private awaitBootstrapAck(): ResultAsync<
    PiBootstrapAckBody,
    PiAdapterFailure
  > {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          this.failOutstanding(makeChildReplyMissingFailure(this.childId));
        }, this.replyTimeoutMs);
        this.bootstrapAckResolvers = {
          resolve: (body) => {
            timer.cancel();
            resolve(ok(body));
          },
          reject: (failure) => {
            timer.cancel();
            resolve(err(failure));
          },
        };
      }),
    );
  }

  private sendTaskPrompt(task: string): ResultAsync<void, PiAdapterFailure> {
    if (task.length < 1 || task.length > MAX_TASK_INPUT_CHARS) {
      return errAsync(
        makeChildEnvelopeMalformedFailure(this.childId, "task-too-large"),
      );
    }
    const process = this.process;
    if (process === undefined) {
      return errAsync(
        makeChildSpawnFailedFailure(this.childId, "process unavailable"),
      );
    }
    const line = `${JSON.stringify({ type: "prompt", message: task })}\n`;
    const writeResult = process.writeStdin(new TextEncoder().encode(line));
    if (writeResult.isErr()) {
      return errAsync(
        makeChildSpawnFailedFailure(this.childId, writeResult.error.reason),
      );
    }
    return new ResultAsync(Promise.resolve(ok(undefined)));
  }

  private awaitSettlement(): ResultAsync<PiChildSettlement, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          this.failOutstanding(makeChildSettlementMissingFailure(this.childId));
        }, this.settlementTimeoutMs);
        this.settlementResolvers = {
          resolve: (settlement) => {
            timer.cancel();
            resolve(ok(settlement));
          },
          reject: (failure) => {
            timer.cancel();
            resolve(err(failure));
          },
        };
      }),
    );
  }

  /**
   * The single terminal-failure path: rejects every outstanding waiter
   * with `failure`, then kills the process and erases the secret. Safe to
   * call more than once (idempotent via the same `disposed` guard as
   * `dispose`) and preserves the `"failed"` status against later
   * cleanup calls, so the child's final snapshot stays inspectable.
   */
  private failOutstanding(failure: PiAdapterFailure): void {
    if (this.disposed) return;
    this.status = "failed";
    this.rejectOutstanding(failure);
    this.terminateResources();
  }

  private rejectOutstanding(failure: PiAdapterFailure): void {
    const handshakeResolvers = this.handshakeResolvers;
    this.handshakeResolvers = undefined;
    handshakeResolvers?.reject(failure);
    const bootstrapAckResolvers = this.bootstrapAckResolvers;
    this.bootstrapAckResolvers = undefined;
    bootstrapAckResolvers?.reject(failure);
    const settlementResolvers = this.settlementResolvers;
    this.settlementResolvers = undefined;
    settlementResolvers?.reject(failure);
    const cancelResolvers = this.cancelResolvers;
    this.cancelResolvers = undefined;
    cancelResolvers?.resolve();
  }

  /**
   * The single terminal cleanup step (Pi adapter contract): force-kills
   * the process (if any) and erases the secret/auth state. Idempotent;
   * never touches `status`. Always uses {@link PiSpawnedChildProcess.forceKill}
   * rather than the cooperative default `kill()` - this is the *only*
   * place any child process is ever terminated, and a non-cooperative or
   * stopped (`SIGSTOP`'d) child must not be able to survive it (the exact
   * bug a plain default-signal `kill()` here previously allowed: a
   * stopped child left `T+` in `ps` well past the bounded cancellation
   * grace, never actually reaped).
   */
  private terminateResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.process?.forceKill();
    this.secret?.dispose();
    this.secret = undefined;
    this.authState?.dispose();
    this.authState = undefined;
  }

  /**
   * Cancels this child: sends the authenticated `cancel` envelope *before*
   * the ordinary RPC `abort` command (Pi adapter contract), then waits boundedly
   * for either an authenticated `cancelled` ack or process exit, and only
   * then force-kills if neither arrived in time. Guarantees termination of
   * the underlying process on every path - authenticated notice delivered
   * or not.
   */
  cancel(): ResultAsync<void, PiAdapterFailure> {
    if (this.disposed || this.settled)
      return new ResultAsync(Promise.resolve(ok(undefined)));
    this.status = "cancelling";
    return this.sendControl("cancel", this.childId, {
      reason: "cancelled-by-parent",
    })
      .orElse((failure) => {
        this.logger.warn(
          { childId: this.childId, code: failure.code },
          "authenticated cancel notice failed to deliver; proceeding to raw abort and bounded force-kill",
        );
        return new ResultAsync(Promise.resolve(ok(undefined)));
      })
      .andThen(() => {
        const process = this.process;
        if (process !== undefined) {
          const abortWrite = process.writeStdin(
            new TextEncoder().encode(`${JSON.stringify({ type: "abort" })}\n`),
          );
          if (abortWrite.isErr()) {
            this.logger.warn(
              { childId: this.childId, code: abortWrite.error.type },
              "raw abort command failed to write; proceeding to bounded force-kill regardless",
            );
          }
        }
        return this.waitBoundedThenForceKill();
      });
  }

  private waitBoundedThenForceKill(): ResultAsync<void, PiAdapterFailure> {
    return new ResultAsync(
      new Promise((resolve) => {
        const timer = this.timerPort.schedule(() => {
          // Neither an authenticated `cancelled`/`settled` reply nor a
          // process exit arrived in time - force-kill, but this is still a
          // legitimate, requested cancellation (Pi adapter contract), so it must
          // still resolve as a structured cancelled result, never as an
          // abort-failed error.
          this.cancelResolvers = undefined;
          this.completeCancellation();
          resolve(ok(undefined));
        }, this.cancelGraceMs);
        this.cancelResolvers = {
          // `completeCancellation()` (the only caller of this resolver, from
          // `dispatchControlKind`'s `cancelled`/raced-`settled` handling or
          // `handleProcessExit`) has already finalized status/settlement and
          // terminated resources by the time this runs - just clear the
          // timer and settle this bounded wait.
          resolve: () => {
            timer.cancel();
            resolve(ok(undefined));
          },
        };
      }),
    );
  }

  /** Idempotent terminal cleanup: kills the process if still alive and zeroes the secret. Safe to call more than once. Never overwrites a status already made terminal by `failOutstanding`/settlement. */
  dispose(): void {
    if (this.disposed) return;
    if (this.status !== "completed" && this.status !== "failed") {
      this.status = "cancelled";
    }
    // Any caller still awaiting handshake/bootstrap-ack/settlement must
    // never hang forever past a terminal disposal - reject with a closed
    // abort failure instead.
    this.rejectOutstanding(
      makeChildAbortFailedFailure(this.childId, "disposed"),
    );
    this.terminateResources();
  }
}

function safeNumberField(
  record: Record<string, JsonValue>,
  field: string,
): number {
  const candidate = record[field];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return 0;
  // Usage figures must never regress the running aggregate via a
  // negative/malformed value reported by the child.
  return Math.max(0, candidate);
}

function extractCostTotal(usageRecord: Record<string, JsonValue>): number {
  const cost = usageRecord.cost;
  if (typeof cost !== "object" || cost === null || Array.isArray(cost))
    return 0;
  const total = (cost as Record<string, JsonValue>).total;
  if (typeof total !== "number" || !Number.isFinite(total)) return 0;
  return Math.max(0, total);
}

export { DEFAULT_REPLY_TIMEOUT_MS };
