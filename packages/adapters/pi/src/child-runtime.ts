/**
 * Child-side private control runtime (Spec 33 §11.2-§11.3): the code that
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
  type PiApprovalResponseBody,
  type PiBootstrapAckBody,
  type PiDelegateResponseBody,
  parseControlBody,
} from "./child-control-bodies.js";
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
import type { JsonValue } from "./strict-json.js";
import type { PiAdapterLogger, PiEnvPort } from "./types.js";

export type PiChildRuntimeError = {
  readonly type: "EnvelopeSignFailed" | "ApprovalTimedOut";
  readonly reason: string;
};

export type PiChildOutputError = {
  readonly type: "ChildOutputWriteFailed";
  readonly reason: string;
};

/**
 * How long a child waits for its own `approval-request` to be answered by
 * the parent. Comfortably longer than the parent's own
 * `APPROVAL_UI_TIMEOUT_MS` (270s) so a real, in-flight parent-TUI dialog is
 * never cut short from the child's side of the round trip.
 */
const CHILD_APPROVAL_TIMEOUT_MS = 300_000;

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
 * for the hidden control command into {@link admitControlLine} and route
 * their own settlement moment (e.g. `agent_settled`) into
 * {@link reportSettled}.
 */
export class PiChildRuntime {
  private secretBytes: Uint8Array | undefined;
  private authState: PiChildAuthState | undefined;
  private childId = "";
  private generationId = "";
  private disposed = false;
  private correlationCounter = 0;
  /** Enforces "bootstrap exactly once" independent of any caller behavior. */
  private bootstrapAdmitted = false;
  /** Enforces "cancellation exactly once" independent of any caller behavior. */
  private cancelAdmitted = false;
  /** Enforces "settlement exactly once" independent of any caller behavior. */
  private settledReported = false;
  /**
   * Pending correlated request/reply round-trips this child itself
   * initiated - both `approval-request`/`approval-response` (Spec 33
   * §12) and `delegate-request`/`delegate-response` (Spec 33 §10-11)
   * share this exact same bounded, single-use, correlation-keyed pattern.
   */
  private readonly pendingCorrelated = new Map<
    string,
    {
      resolve: (body: JsonValue) => void;
      reject: (error: PiChildRuntimeError) => void;
    }
  >();
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
    if (
      envelope.kind === "approval-response" ||
      envelope.kind === "delegate-response"
    ) {
      this.admitCorrelatedReply(
        envelope.kind,
        envelope.correlationId,
        envelope.body,
      );
      return;
    }
    // Every other kind (`handshake`, `bootstrap-ack`, `settled`, `cancelled`,
    // `error`, `approval-request`, `delegate-request`) is child-to-parent-only;
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

  private admitCorrelatedReply(
    kind: "approval-response" | "delegate-response",
    correlationId: string,
    body: JsonValue,
  ): void {
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
    // Resolve with the already-validated typed body, never the raw one -
    // every caller of `requestApproval`/`requestDelegation` gets back a
    // value it can use directly, with no further cast at the call site.
    pending.resolve(parsed.value);
  }

  reportSettled(
    outcome: "completed" | "failed",
    detail: { summary?: string; reason?: string },
  ): ResultAsync<void, PiChildRuntimeError> {
    if (this.settledReported) {
      return errAsync({
        type: "EnvelopeSignFailed",
        reason: "settlement-already-reported",
      });
    }
    this.settledReported = true;
    const body: JsonValue = {
      outcome,
      ...(detail.summary !== undefined ? { summary: detail.summary } : {}),
      ...(detail.reason !== undefined ? { reason: detail.reason } : {}),
    };
    return this.sendControl("settled", this.childId, body).map(() => undefined);
  }

  reportCancelled(): ResultAsync<void, PiChildRuntimeError> {
    return this.sendControl("cancelled", this.childId, {}).map(() => undefined);
  }

  /**
   * Proves to the parent that the bootstrap descriptor/model/tool policy
   * were actually applied - `body` carries the exact active-tool set
   * `pi.getActiveTools()` reported and the concrete model identity that
   * ended up active, both verified by the caller before this is ever sent
   * (Spec 33 §11.2 Task 9, §11.3/§11.5). The parent never sends task work
   * on the strength of the bootstrap send alone - it waits for this ack,
   * and now cross-checks its body too.
   */
  reportBootstrapAck(
    body: PiBootstrapAckBody,
  ): ResultAsync<void, PiChildRuntimeError> {
    return this.sendControl("bootstrap-ack", this.childId, body).map(
      () => undefined,
    );
  }

  /**
   * Relays one of this child's own governed tool-call approval prompts to
   * the sole parent TUI (Spec 33 §11.5/§12) and awaits the correlated
   * reply. Bounded by {@link CHILD_APPROVAL_TIMEOUT_MS} so a lost/duplicate
   * reply can never hang the child's own tool-call turn forever.
   */
  requestApproval(
    body: JsonValue,
  ): ResultAsync<PiApprovalResponseBody, PiChildRuntimeError> {
    return this.sendCorrelatedRequest<PiApprovalResponseBody>(
      "approval-request",
      "approval",
      body,
    );
  }

  /**
   * Relays this child's own request to delegate further work through its
   * authenticated parent/root coordinator (Spec 33 §10-11). Nested
   * delegation is never a second, independent, untracked budget: the
   * parent authorizes it under this exact child's identity/depth against
   * the same global tree/process budget as every other delegation.
   */
  requestDelegation(
    body: JsonValue,
  ): ResultAsync<PiDelegateResponseBody, PiChildRuntimeError> {
    return this.sendCorrelatedRequest<PiDelegateResponseBody>(
      "delegate-request",
      "delegate",
      body,
    );
  }

  /**
   * Shared correlated request/reply infrastructure for both approval and
   * delegation round-trips. `T` is always exactly the validated body type
   * {@link admitCorrelatedReply} already produced via `parseControlBody`
   * before ever calling `resolve` - this is the one contained internal
   * cast that lets every actual caller (`requestApproval`/
   * `requestDelegation`, and everything downstream of them) receive a
   * properly typed value with no cast of its own.
   */
  private sendCorrelatedRequest<T extends JsonValue>(
    kind: "approval-request" | "delegate-request",
    correlationPrefix: string,
    body: JsonValue,
  ): ResultAsync<T, PiChildRuntimeError> {
    const correlationId = `${this.childId}-${correlationPrefix}-${this.correlationCounter}`;
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
        err({ type: "ApprovalTimedOut", reason: "no reply from parent" }),
      );
    }, CHILD_APPROVAL_TIMEOUT_MS);
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
    return this.sendControl(kind, correlationId, body)
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
      );
  }

  /** Idempotent terminal cleanup: zeroes the secret. Safe to call more than once, including before activation ever completed. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of this.pendingCorrelated.values()) {
      pending.reject({ type: "ApprovalTimedOut", reason: "disposed" });
    }
    this.pendingCorrelated.clear();
    this.secretBytes?.fill(0);
    this.secretBytes = undefined;
    this.authState?.dispose();
    this.authState = undefined;
  }
}
