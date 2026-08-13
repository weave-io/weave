/**
 * Child-side private control runtime (Pi adapter contract): the code that
 * runs *inside* a `pi --mode rpc --no-session` process spawned by a
 * parent's `PiDelegationController`. It never trusts its own presence in
 * "rpc" mode alone - it looks for its own bootstrap secret via the
 * injected environment port (never argv/prompt), erases the env value the
 * moment it is read, and only then proves possession by sending a signed
 * `handshake` envelope directly to its own stdout (never through
 * `steer`/`follow_up`). Every reply after that point is itself an
 * authenticated envelope; nothing here trusts an unauthenticated control
 * line, and any authentication/replay/protocol violation disposes this
 * runtime immediately rather than merely logging and continuing.
 */
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  ResultAsync,
} from "neverthrow";
import {
  type PiBootstrapAckBody,
  type PiDelegateRequestBody,
  type PiDelegateResponseBody,
  type PiTransferResultBody,
  parseControlBody,
} from "./child-control-bodies.js";
import { projectDiagnosticText } from "./child-diagnostic-projection.js";
import {
  generateNonceHex,
  type HmacPort,
  hexToBytes,
  type RandomPort,
} from "./child-crypto.js";
import {
  WEAVE_CHILD_ID_ENV,
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
import { SystemTimerPort, type TimerPort } from "./child-timer.js";
import { encodeTransferChunks } from "./child-transfer.js";
import { encodeDelegateRequestChunks } from "./delegate-request-chunking.js";
import {
  makeChildInteractionUnavailableFailure,
  makeChildOrphanReadOnlyFailure,
  makeThreadNotFoundFailure,
  PI_TRANSPORT_LIMITS,
} from "./errors.js";
import type { JsonValue } from "./strict-json.js";
import type { PiAdapterLogger, PiEnvPort } from "./types.js";

export type PiChildRuntimeError = {
  readonly type:
    | "EnvelopeSignFailed"
    | "CorrelatedRequestTimedOut"
    | "TransferTimedOut"
    | "TransferRejected";
  readonly reason: string;
};

export interface PiChildOutputTransfer {
  readonly transferId: string;
  readonly byteLength: number;
}

export type PiChildOutputError = {
  readonly type: "ChildOutputWriteFailed";
  readonly reason: string;
};

/** How long a child waits for a correlated delegation reply. */
const CHILD_CORRELATED_TIMEOUT_MS = 300_000;

export interface PiChildOutputPort {
  /** Writes one already-LF-terminated line directly to this process's own stdout. */
  writeLine(bytes: Uint8Array): ResultAsync<void, PiChildOutputError>;
}

export interface PiChildRuntimeDeps {
  readonly envPort: PiEnvPort;
  readonly randomPort: RandomPort;
  readonly hmacPort: HmacPort;
  readonly outputPort: PiChildOutputPort;
  readonly logger: PiAdapterLogger;
  readonly timerPort?: TimerPort;
}

export interface PiChildBootstrapHandlers {
  /**
   * Applies the parent's bootstrap payload. Caller-supplied so this module
   * never invents descriptor/model/tool activation. May return a promise -
   * {@link PiChildRuntime.admitControlLine} awaits it before its own
   * returned promise settles, so callers (and tests) that await
   * `admitControlLine(...)` observe every bootstrap side effect actually
   * applied, never just "dispatched".
   */
  onBootstrap(body: JsonValue): void | Promise<void>;
  onCancel(): void | Promise<void>;
}

export type PiChildStartOutcome =
  | { readonly kind: "not-a-child" }
  | { readonly kind: "activated"; readonly childId: string }
  | { readonly kind: "handshake-failed"; readonly reason: string };

/**
 * One child process's own private-control state. Not itself a
 * `pi.on(...)` wiring layer - callers route raw stdin-derived JSON lines
 * for the hidden control command into `admitControlLine` and route
 * their own settlement moment (e.g. `agent_settled`) into
 * `reportSettled`.
 */
export class PiChildRuntime {
  private secretBytes: Uint8Array | undefined;
  private authState: PiChildAuthState | undefined;
  private childId = "";
  private generationId = "";
  private disposed = false;
  private correlationCounter = 0;
  private outputTransferCounter = 0;
  /** Enforces "bootstrap exactly once" independent of any caller behavior. */
  private bootstrapAdmitted = false;
  /** Enforces "cancellation exactly once" independent of any caller behavior. */
  private cancelAdmitted = false;
  /** Enforces "settlement exactly once" independent of any caller behavior. */
  private settledReported = false;
  /** Prevents concurrent terminal reports while allowing a failed report to retry. */
  private settledReportInFlight = false;
  /** Serializes allocation, signing, and output so failed sequences can be reused safely. */
  private outgoingSendTail: Promise<void> = Promise.resolve();
  /** Pending correlated delegation requests initiated by this child. */
  private readonly pendingCorrelated = new Map<
    string,
    {
      resolve: (body: JsonValue) => void;
      reject: (error: PiChildRuntimeError) => void;
    }
  >();
  private pendingOutputTransfer:
    | {
        readonly transferId: string;
        resolve: (body: PiTransferResultBody) => void;
        reject: (error: PiChildRuntimeError) => void;
      }
    | undefined;
  private readonly timerPort: TimerPort;

  constructor(private readonly deps: PiChildRuntimeDeps) {
    this.timerPort = deps.timerPort ?? new SystemTimerPort();
  }

  isActivated(): boolean {
    return this.secretBytes !== undefined && this.authState !== undefined;
  }

  /**
   * True once a `cancel` control envelope has been admitted (Task 9 finding
   * 2). Callers must consult this before reporting an `agent_settled`
   * outcome as `"completed"`: `reportSettled` and `reportCancelled` guard
   * against being called twice each on their own, but they do not know
   * about each other, so a stray `agent_settled` observed after cancellation
   * was already admitted must never race a `"completed"` settlement past
   * the `"cancelled"` one that already went out.
   */
  isCancelled(): boolean {
    return this.cancelAdmitted;
  }

  getChildId(): string {
    return this.childId;
  }

  /** Reads and immediately erases the bootstrap secret, then sends the signed handshake. `not-a-child` when no secret is present. */
  start(): ResultAsync<PiChildStartOutcome, PiChildRuntimeError> {
    const secretHex = this.deps.envPort.read(WEAVE_CHILD_SECRET_ENV);
    if (secretHex === undefined) return okAsync({ kind: "not-a-child" });
    this.deps.envPort.deleteValue(WEAVE_CHILD_SECRET_ENV);
    this.childId = this.deps.envPort.read(WEAVE_CHILD_ID_ENV) ?? "";
    this.generationId =
      this.deps.envPort.read(WEAVE_CONTROLLER_GENERATION_ENV) ?? "";
    const secretBytes = hexToBytes(secretHex);
    if (
      secretBytes === undefined ||
      this.childId === "" ||
      this.generationId === ""
    ) {
      // Whatever key material was actually decoded from a malformed
      // environment must never linger in memory just because the rest of
      // the bootstrap turned out to be unusable.
      secretBytes?.fill(0);
      return okAsync({
        kind: "handshake-failed",
        reason: "malformed bootstrap environment",
      });
    }
    this.secretBytes = secretBytes;
    // On the child's own side, envelopes it receives travel parent-to-child
    // (the reverse of PiRpcChild's parent-side default), so the expected
    // incoming direction must be passed explicitly.
    this.authState = new PiChildAuthState(
      this.childId,
      this.generationId,
      "parent-to-child",
    );
    return this.sendControl("handshake", this.childId, {})
      .map(
        (): PiChildStartOutcome => ({
          kind: "activated",
          childId: this.childId,
        }),
      )
      .orElse((failure) => {
        // The handshake itself failed to sign or reach stdout: this child
        // can never prove possession of its secret to its parent, so it
        // must never keep holding that secret (or any auth state) live.
        this.dispose();
        return errAsync(failure);
      });
  }

  /**
   * Verifies and admits one control-line JSON value. Fails closed
   * (disposes) on anything that isn't a legitimately-authenticated,
   * well-formed, single-delivery control message.
   *
   * Returns a promise that settles only once verification *and* (for
   * `bootstrap`/`cancel`) the caller-supplied handler's own async work
   * have both completed - never merely once the handler was invoked.
   * Callers that need a deterministic completion signal (e.g. a hidden
   * command handler that must not resolve until bootstrap is actually
   * applied) must await this returned promise rather than reacting to a
   * side channel or an arbitrary timer.
   */
  async admitControlLine(
    json: JsonValue,
    handlers: PiChildBootstrapHandlers,
  ): Promise<void> {
    if (this.disposed) return;
    const secretBytes = this.secretBytes;
    const authState = this.authState;
    if (secretBytes === undefined || authState === undefined) return;
    if (!looksLikeControlEnvelope(json)) return;
    await verifyEnvelope(json, secretBytes, this.deps.hmacPort).match(
      (envelope) => this.admitVerifiedEnvelope(envelope, authState, handlers),
      (envelopeError) => {
        this.deps.logger.warn(
          { childId: this.childId, reason: envelopeError.type },
          "private control envelope failed verification; stopping child runtime",
        );
        this.dispose();
      },
    );
  }

  private async admitVerifiedEnvelope(
    envelope: PiControlEnvelope,
    authState: PiChildAuthState,
    handlers: PiChildBootstrapHandlers,
  ): Promise<void> {
    const admitted = authState.admitIncoming(envelope);
    if (admitted.isErr()) {
      this.deps.logger.warn(
        { childId: this.childId, reason: admitted.error.type },
        "rejected private control envelope (auth/replay/sequence); stopping child runtime",
      );
      this.dispose();
      return;
    }
    if (envelope.kind === "bootstrap") {
      await this.admitBootstrap(envelope.body, handlers);
      return;
    }
    if (envelope.kind === "cancel") {
      await this.admitCancel(envelope.body, handlers);
      return;
    }
    if (envelope.kind === "delegate-response") {
      this.admitCorrelatedReply(envelope.correlationId, envelope.body);
      return;
    }
    if (envelope.kind === "transfer-result") {
      this.admitOutputTransferResult(envelope.correlationId, envelope.body);
      return;
    }
    // Every other kind (`handshake`, `bootstrap-ack`, `settled`, `cancelled`,
    // `error`, `delegate-request`) is child-to-parent-only;
    // a parent ever sending one of these back is always a protocol violation,
    // never a message this side should legitimately see.
    this.deps.logger.warn(
      { childId: this.childId, kind: envelope.kind },
      "rejected illegal incoming control kind; stopping child runtime",
    );
    this.dispose();
  }

  private async admitBootstrap(
    body: JsonValue,
    handlers: PiChildBootstrapHandlers,
  ): Promise<void> {
    if (this.bootstrapAdmitted) {
      this.deps.logger.warn(
        { childId: this.childId },
        "rejected duplicate bootstrap; stopping child runtime",
      );
      this.dispose();
      return;
    }
    const parsed = parseControlBody("bootstrap", body);
    if (!parsed.ok) {
      this.deps.logger.warn(
        { childId: this.childId, issueCount: parsed.issueCount },
        "rejected malformed bootstrap body; stopping child runtime",
      );
      this.dispose();
      return;
    }
    this.bootstrapAdmitted = true;
    await handlers.onBootstrap(body);
  }

  private async admitCancel(
    body: JsonValue,
    handlers: PiChildBootstrapHandlers,
  ): Promise<void> {
    if (this.cancelAdmitted) {
      this.deps.logger.warn(
        { childId: this.childId },
        "rejected duplicate cancel; stopping child runtime",
      );
      this.dispose();
      return;
    }
    const parsed = parseControlBody("cancel", body);
    if (!parsed.ok) {
      this.deps.logger.warn(
        { childId: this.childId, issueCount: parsed.issueCount },
        "rejected malformed cancel body; stopping child runtime",
      );
      this.dispose();
      return;
    }
    this.cancelAdmitted = true;
    await handlers.onCancel();
  }

  private admitCorrelatedReply(correlationId: string, body: JsonValue): void {
    const kind = "delegate-response";
    const parsed = parseControlBody(kind, body);
    if (!parsed.ok) {
      this.deps.logger.warn(
        { childId: this.childId, kind, issueCount: parsed.issueCount },
        "rejected malformed correlated reply body; stopping child runtime",
      );
      this.dispose();
      return;
    }
    const pending = this.pendingCorrelated.get(correlationId);
    if (pending === undefined) {
      // Authenticated, well-sequenced, well-formed, but unmatched: already
      // resolved (duplicate), already timed out (late), or simply never
      // ours. This alone does not indicate a compromised transport (the
      // envelope already passed sequence/nonce/auth checks), so it is
      // dropped rather than treated as fatal.
      this.deps.logger.warn(
        { childId: this.childId, kind, correlationId },
        "dropped unmatched correlated reply (duplicate, late, or already resolved)",
      );
      return;
    }
    this.pendingCorrelated.delete(correlationId);
    // Resolve with the validated body, never the raw input.
    pending.resolve(parsed.value);
  }

  private admitOutputTransferResult(
    correlationId: string,
    body: JsonValue,
  ): void {
    const parsed = parseControlBody("transfer-result", body);
    if (!parsed.ok || parsed.value.channel !== "output") {
      this.deps.logger.warn(
        { childId: this.childId },
        "rejected malformed output transfer result; stopping child runtime",
      );
      this.dispose();
      return;
    }
    const pending = this.pendingOutputTransfer;
    if (
      pending === undefined ||
      pending.transferId !== parsed.value.transferId ||
      correlationId !== parsed.value.transferId
    ) {
      this.deps.logger.warn(
        { childId: this.childId, correlationId },
        "dropped unmatched output transfer result",
      );
      return;
    }
    if (parsed.value.status === "nack") {
      pending.reject({
        type: "TransferRejected",
        reason: parsed.value.reason,
      });
      return;
    }
    pending.resolve(parsed.value);
  }

  reportSettled(
    outcome: "completed" | "failed",
    detail: {
      assistantOutput?: string;
      completionCandidate?: string;
      completionCandidateTransferred?: boolean;
      outputTransferId?: string;
      outputByteLength?: number;
      interventionCount?: number;
      reason?: string;
    },
  ): ResultAsync<void, PiChildRuntimeError> {
    if (this.settledReported || this.settledReportInFlight) {
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: "settlement-already-reported",
      });
    }
    this.settledReportInFlight = true;
    const body: JsonValue = {
      outcome,
      ...(detail.assistantOutput !== undefined
        ? { assistantOutput: detail.assistantOutput }
        : {}),
      ...(detail.completionCandidate !== undefined
        ? { completionCandidate: detail.completionCandidate }
        : {}),
      ...(detail.completionCandidateTransferred === true
        ? { completionCandidateTransferred: true }
        : {}),
      ...(detail.outputTransferId !== undefined
        ? { outputTransferId: detail.outputTransferId }
        : {}),
      ...(detail.outputByteLength !== undefined
        ? { outputByteLength: detail.outputByteLength }
        : {}),
      ...(detail.interventionCount !== undefined
        ? { interventionCount: detail.interventionCount }
        : {}),
      ...(detail.reason !== undefined
        ? { reason: projectDiagnosticText(detail.reason) }
        : {}),
    };
    return this.sendControl("settled", this.childId, body)
      .map(() => {
        this.settledReportInFlight = false;
        this.settledReported = true;
        return undefined;
      })
      .mapErr((failure) => {
        this.settledReportInFlight = false;
        return failure;
      });
  }

  reportCancelled(): ResultAsync<void, PiChildRuntimeError> {
    return this.sendControl("cancelled", this.childId, {}).map(() => undefined);
  }

  /** Proves to the parent that bootstrap completed before task work starts. */
  reportBootstrapAck(
    body: PiBootstrapAckBody,
  ): ResultAsync<void, PiChildRuntimeError> {
    return this.sendControl("bootstrap-ack", this.childId, body).map(
      () => undefined,
    );
  }

  reportTransferResult(
    body: PiTransferResultBody,
  ): ResultAsync<void, PiChildRuntimeError> {
    return this.sendControl("transfer-result", body.transferId, body).map(
      () => undefined,
    );
  }

  transferOutput(
    output: string,
  ): ResultAsync<PiChildOutputTransfer, PiChildRuntimeError> {
    return this.transferOutputAttempt(output, 0);
  }

  private transferOutputAttempt(
    output: string,
    attempt: number,
  ): ResultAsync<PiChildOutputTransfer, PiChildRuntimeError> {
    this.outputTransferCounter += 1;
    const transferId = `${this.childId}:output:${this.outputTransferCounter}:${generateNonceHex(this.deps.randomPort)}`;
    const chunks = encodeTransferChunks(output, transferId);
    if (chunks.isErr()) {
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: chunks.error.type,
      });
    }

    let resolveWait!: (
      result: Result<PiTransferResultBody, PiChildRuntimeError>,
    ) => void;
    const wait = new ResultAsync<PiTransferResultBody, PiChildRuntimeError>(
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
    );
    const timer = this.timerPort.schedule(() => {
      if (this.pendingOutputTransfer?.transferId !== transferId) return;
      this.pendingOutputTransfer = undefined;
      resolveWait(
        err({ type: "TransferTimedOut", reason: "output-transfer-timeout" }),
      );
    }, PI_TRANSPORT_LIMITS.transferAckTimeoutMs);
    this.pendingOutputTransfer = {
      transferId,
      resolve: (body) => {
        timer.cancel();
        this.pendingOutputTransfer = undefined;
        resolveWait(ok(body));
      },
      reject: (failure) => {
        timer.cancel();
        this.pendingOutputTransfer = undefined;
        resolveWait(err(failure));
      },
    };

    let send: ResultAsync<void, PiChildRuntimeError> = okAsync(undefined);
    for (const chunk of chunks.value) {
      send = send.andThen(() =>
        this.sendControl("transfer-chunk", transferId, {
          channel: "output",
          transferId,
          index: chunk.index,
          total: chunk.total,
          data: chunk.data,
        }),
      );
    }
    return send
      .orElse((failure) => {
        if (this.pendingOutputTransfer?.transferId === transferId) {
          this.pendingOutputTransfer.reject(failure);
        }
        return errAsync(failure);
      })
      .andThen(() => wait)
      .map(() => ({
        transferId,
        byteLength: new TextEncoder().encode(output).byteLength,
      }))
      .orElse((failure) => {
        if (attempt < PI_TRANSPORT_LIMITS.transferMaxRetries) {
          return this.transferOutputAttempt(output, attempt + 1);
        }
        return errAsync(failure);
      });
  }

  /**
   * Relays this child's own request to delegate further work through its
   * authenticated parent/root coordinator (Pi adapter contract). Nested
   * delegation is never a second, independent, untracked budget: the
   * parent authorizes it under this exact child's identity/depth against
   * the same global tree/process budget as every other delegation.
   */
  requestDelegation(
    body: JsonValue,
  ): ResultAsync<PiDelegateResponseBody, PiChildRuntimeError> {
    const parsed = parseControlBody("delegate-request", body);
    if (!parsed.ok)
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: "delegate-request-body-invalid",
      });
    return this.sendCorrelatedRequest<PiDelegateResponseBody>(parsed.value);
  }

  /** Sends a bounded, correlated delegation request as authenticated chunks. */
  private sendCorrelatedRequest<T extends JsonValue>(
    body: PiDelegateRequestBody,
  ): ResultAsync<T, PiChildRuntimeError> {
    const correlationId = `${this.childId}-delegate-${this.correlationCounter}`;
    this.correlationCounter += 1;
    let resolveWait!: (result: Result<T, PiChildRuntimeError>) => void;
    const wait = new ResultAsync<T, PiChildRuntimeError>(
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
    );
    // Install the pending correlation - and its timeout - *before*
    // attempting to send anything, so a reply that beats our own send's
    // completion back can never be dropped as "unmatched".
    const timer = this.timerPort.schedule(() => {
      this.pendingCorrelated.delete(correlationId);
      resolveWait(
        err({
          type: "CorrelatedRequestTimedOut",
          reason: "no reply from parent",
        }),
      );
    }, CHILD_CORRELATED_TIMEOUT_MS);
    this.pendingCorrelated.set(correlationId, {
      resolve: (responseBody) => {
        timer.cancel();
        resolveWait(ok(responseBody as T));
      },
      reject: (error) => {
        timer.cancel();
        resolveWait(err(error));
      },
    });
    const chunks = encodeDelegateRequestChunks(
      body.task,
      `${this.childId}:${correlationId}`,
      body.agentName,
    );
    if (chunks.isErr()) {
      timer.cancel();
      this.pendingCorrelated.delete(correlationId);
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: chunks.error.type,
      });
    }
    let send: ResultAsync<void, PiChildRuntimeError> = okAsync(undefined);
    for (const chunk of chunks.value) {
      send = send.andThen(() =>
        this.sendControl("delegate-request-chunk", correlationId, chunk),
      );
    }
    return send
      .andThen(() => wait)
      .orElse((failure) => {
        // The send itself never made it out: nothing will ever answer
        // this correlation, so don't leave its timer/entry dangling.
        if (this.pendingCorrelated.has(correlationId)) {
          timer.cancel();
          this.pendingCorrelated.delete(correlationId);
        }
        return errAsync(failure);
      });
  }

  private sendControl(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiChildRuntimeError> {
    let resolveResult!: (result: Result<void, PiChildRuntimeError>) => void;
    const result = new ResultAsync<void, PiChildRuntimeError>(
      new Promise((resolve) => {
        resolveResult = resolve;
      }),
    );
    const operation = this.outgoingSendTail.then(async () => {
      resolveResult(await this.sendControlNow(kind, correlationId, body));
    });
    this.outgoingSendTail = operation.then(
      () => undefined,
      (error: unknown) => {
        resolveResult(
          err({
            type: "EnvelopeSignFailed",
            reason:
              error instanceof Error ? error.message : "control send failed",
          }),
        );
      },
    );
    return result;
  }

  private sendControlNow(
    kind: PiControlKind,
    correlationId: string,
    body: JsonValue,
  ): ResultAsync<void, PiChildRuntimeError> {
    const secretBytes = this.secretBytes;
    const authState = this.authState;
    if (secretBytes === undefined || authState === undefined) {
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: "runtime not activated",
      });
    }
    const sequence = authState.allocateOutgoingSequence();
    return signEnvelope(
      {
        childId: this.childId,
        generationId: this.generationId,
        direction: "child-to-parent",
        sequence,
        nonce: generateNonceHex(this.deps.randomPort),
        correlationId,
        kind,
        body,
      },
      secretBytes,
      this.deps.hmacPort,
    )
      .mapErr(
        (envelopeError): PiChildRuntimeError => ({
          type: "EnvelopeSignFailed",
          reason: envelopeError.type,
        }),
      )
      .andThen((envelope) =>
        this.deps.outputPort
          .writeLine(new TextEncoder().encode(`${JSON.stringify(envelope)}\n`))
          .mapErr(
            (outputError): PiChildRuntimeError => ({
              type: "EnvelopeSignFailed",
              reason: outputError.type,
            }),
          ),
      )
      .orElse((failure) => {
        authState.releaseOutgoingSequence(sequence);
        return errAsync(failure);
      });
  }

  /** Idempotent terminal cleanup: zeroes the secret. Safe to call more than once, including before activation ever completed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingCorrelated.values()) {
      pending.reject({
        type: "CorrelatedRequestTimedOut",
        reason: "disposed",
      });
    }
    this.pendingCorrelated.clear();
    const pendingOutputTransfer = this.pendingOutputTransfer;
    this.pendingOutputTransfer = undefined;
    pendingOutputTransfer?.reject({
      type: "TransferTimedOut",
      reason: "disposed",
    });
    this.secretBytes?.fill(0);
    this.secretBytes = undefined;
    this.authState?.dispose();
    this.authState = undefined;
  }
}

/**
 * Parent-side access states for an existing child after its origin parent
 * may have been deleted or replaced. Classification is pure: it never
 * deletes, tombstones, or mutates child storage.
 */
export type PiChildAccessState =
  | "owned"
  | "read-only-orphan"
  | "unavailable"
  | "origin-mismatch";

/** Operations gated by {@link authorizeChildAccess}. */
export type PiChildAccessOperation =
  | "read"
  | "history"
  | "doctor"
  | "steer"
  | "follow-up"
  | "retry"
  | "continue"
  | "delete";

const READ_ONLY_CHILD_ACCESS_OPERATIONS: ReadonlySet<PiChildAccessOperation> =
  new Set(["read", "history", "doctor"]);

export type PiChildAccessDenial =
  | ReturnType<typeof makeChildOrphanReadOnlyFailure>
  | ReturnType<typeof makeThreadNotFoundFailure>
  | ReturnType<typeof makeChildInteractionUnavailableFailure>;

/**
 * Classifies whether a child is still owned by the live parent, is a
 * read-only orphan (child exists but origin parent is gone), is an
 * origin-mismatched branch copy, or is simply unavailable. Never deletes.
 */
export function classifyChildAccess(input: {
  readonly childExists: boolean;
  readonly originParentSessionId: string | undefined;
  readonly liveParentSessionId: string | undefined;
}): PiChildAccessState {
  if (!input.childExists) return "unavailable";
  if (
    input.originParentSessionId === undefined ||
    input.originParentSessionId.length === 0
  ) {
    return "read-only-orphan";
  }
  if (
    input.liveParentSessionId === undefined ||
    input.liveParentSessionId !== input.originParentSessionId
  ) {
    return "origin-mismatch";
  }
  return "owned";
}

/**
 * Authorizes one child operation against a classified access state.
 * Read/history/doctor remain available for owned, read-only-orphan, and
 * origin-mismatch children. Mutations require `owned`.
 */
export function authorizeChildAccess(
  childId: string,
  state: PiChildAccessState,
  operation: PiChildAccessOperation,
): Result<void, PiChildAccessDenial> {
  if (state === "owned") return ok(undefined);
  if (state === "unavailable") {
    return err(makeChildInteractionUnavailableFailure(childId));
  }
  if (READ_ONLY_CHILD_ACCESS_OPERATIONS.has(operation)) {
    return ok(undefined);
  }
  if (state === "origin-mismatch") {
    return err(makeThreadNotFoundFailure(childId, "origin-mismatch"));
  }
  return err(makeChildOrphanReadOnlyFailure(childId));
}
