import type { TimerHandle, TimerPort } from "./child-timer.js";

/**
 * Bounded window a private child keeps an abort/error settlement unpublished
 * while it waits for *structural* compaction evidence
 * (`session_before_compact`/`session_compact`).
 *
 * A third-party compaction extension (for example
 * `@ogulcancelik/pi-codex-compaction`) forces a threshold compaction by
 * calling `ctx.abort()` from `turn_end` and then driving `ctx.compact()` from
 * its own `agent_settled` handler. Pi's `ExtensionRunner` awaits every
 * extension handler sequentially in load order, so Weave can neither know
 * whether it runs before or after that extension nor block the chain waiting
 * for it - blocking would prevent a later-ordered `ctx.compact()` from ever
 * being called.
 *
 * The grace therefore has to cover `AgentSession.compact()`'s own prologue
 * (`await abort()`, summarization auth resolution, compaction preparation)
 * before `session_before_compact` is emitted, while staying short enough that
 * an ordinary failure is still reported promptly.
 */
export const DEFAULT_COMPACTION_EVIDENCE_GRACE_MS = 5_000;

/**
 * Bounded window between observed compaction evidence and the resumed run's
 * `turn_start`. It covers the remote compaction request plus the continuation
 * prompt, and nothing more: once the child resumes, the ordinary settlement
 * path owns the outcome again.
 *
 * It is deliberately far below the default settlement inactivity budget
 * (`DEFAULT_SETTLEMENT_TIMEOUT_MS`, one hour) so a child that compacts and
 * then goes silent reports its own sanitized terminal reason instead of being
 * force-killed by the parent with a generic missing-settlement failure. No
 * state in this gate is unbounded, so no lease can be held indefinitely.
 */
export const DEFAULT_COMPACTION_RESUME_TIMEOUT_MS = 10 * 60 * 1_000;

/** The already-sanitized terminal verdict captured when the abort was observed. */
export interface DeferredChildFailure {
  readonly reason: string;
}

/** Why an abort/error settlement was not published immediately. */
export type AbortSettlementDecision =
  | { readonly kind: "defer" }
  | {
      readonly kind: "suppress";
      readonly why: "deferred" | "compacting" | "closed" | "resumed";
    };

/** Whether a non-abort settlement may be reported now. */
export type SettlementAdmission =
  | { readonly kind: "admit" }
  | { readonly kind: "suppress" };

type GateState =
  | { readonly kind: "open" }
  | {
      /**
       * Structural compaction evidence arrived while no failure was
       * captured - the handler order where the compaction extension is
       * loaded before Weave, so its `ctx.compact()` has already emitted
       * `session_before_compact` by the time Weave's own `agent_settled`
       * handler runs. The evidence is remembered for one bounded window and
       * for nothing longer.
       */
      readonly kind: "evidenced";
      /** A resumed run already started inside the same evidence window. */
      readonly resumed: boolean;
      readonly timer: TimerHandle;
    }
  | {
      readonly kind: "deferred";
      readonly failure: DeferredChildFailure;
      readonly timer: TimerHandle;
    }
  | {
      readonly kind: "compacting";
      readonly failure: DeferredChildFailure;
      readonly timer: TimerHandle;
    }
  | { readonly kind: "closed" };

export interface PiChildAbortSettlementGateOptions {
  readonly timerPort: TimerPort;
  /** Publishes the captured terminal failure. Called at most once. */
  readonly onExpire: (failure: DeferredChildFailure) => void;
  readonly evidenceGraceMs?: number;
  readonly resumeTimeoutMs?: number;
}

/**
 * A five-state, fully bounded gate that separates a compaction-intent local
 * abort from a genuine terminal failure using host lifecycle events only -
 * never error prose, never a third-party extension's private state.
 *
 * ```
 *   session_before_compact / session_compact
 *   open ──────────────────────────────────▶ evidenced ──(evidence window expires)──▶ open
 *     │                                          │
 *     │                                          └─ abort/error agent_settled ─┐
 *     │ abort/error agent_settled                                              │
 *     ▼                                                                        │
 *   deferred ──(grace expires OR unrelated turn_start)──▶ closed (publish)     │
 *     │                                                                        │
 *     └─ session_before_compact / session_compact ──▶ compacting ◀─────────────┘
 *                                                        │  │
 *                                                        │  └─(resume timeout)─▶ closed (publish)
 *                                                        │
 *                                                        └─ turn_start (resumed) ──▶ open
 *
 *   any state ── non-abort agent_settled ──▶ closed (admit the ordinary path)
 * ```
 *
 * A captured failure is discarded ONLY when structural compaction evidence was
 * recorded for it - either before the abort (`evidenced`) or after it
 * (`compacting`). A `turn_start` with no such evidence is an unrelated turn: it
 * proves the compaction that would have justified the abort never started
 * before the child moved on, so the captured failure is published at once and
 * the gate closes. A provider or local abort can therefore never be converted
 * into a later success, not even by compaction evidence that arrives after the
 * unrelated turn already began.
 *
 * Every non-`open` state holds exactly one live timer, so the child can never
 * sit deferred forever and no state is unbounded.
 */
export class PiChildAbortSettlementGate {
  private state: GateState = { kind: "open" };
  private readonly timerPort: TimerPort;
  private readonly onExpire: (failure: DeferredChildFailure) => void;
  private readonly evidenceGraceMs: number;
  private readonly resumeTimeoutMs: number;

  constructor(options: PiChildAbortSettlementGateOptions) {
    this.timerPort = options.timerPort;
    this.onExpire = options.onExpire;
    this.evidenceGraceMs =
      options.evidenceGraceMs ?? DEFAULT_COMPACTION_EVIDENCE_GRACE_MS;
    this.resumeTimeoutMs =
      options.resumeTimeoutMs ?? DEFAULT_COMPACTION_RESUME_TIMEOUT_MS;
  }

  /**
   * Records an `agent_settled` whose last assistant `stopReason` was
   * `"error"` or `"aborted"`. Returns synchronously and never blocks the
   * host's handler chain.
   */
  observeAbortSettlement(
    failure: DeferredChildFailure,
  ): AbortSettlementDecision {
    if (this.state.kind === "deferred") {
      return { kind: "suppress", why: "deferred" };
    }
    if (this.state.kind === "compacting") {
      return { kind: "suppress", why: "compacting" };
    }
    if (this.state.kind === "closed") {
      return { kind: "suppress", why: "closed" };
    }
    if (this.state.kind === "evidenced") {
      const { resumed, timer } = this.state;
      timer.cancel();
      if (resumed) {
        // Compaction completed AND its resumed run already started before
        // this settlement was observed. The verdict belongs to the aborted
        // pre-compaction turn, and the run now in flight owns the next
        // outcome, so nothing is captured and nothing is armed.
        this.state = { kind: "open" };
        return { kind: "suppress", why: "resumed" };
      }
      this.state = {
        kind: "compacting",
        failure,
        timer: this.timerPort.schedule(
          () => this.publish(),
          this.resumeTimeoutMs,
        ),
      };
      return { kind: "defer" };
    }
    this.state = {
      kind: "deferred",
      failure,
      timer: this.timerPort.schedule(
        () => this.publish(),
        this.evidenceGraceMs,
      ),
    };
    return { kind: "defer" };
  }

  /**
   * Records structural compaction evidence (`session_before_compact` or
   * `session_compact`).
   *
   * Pi awaits extension handlers sequentially in load order, so this evidence
   * can arrive either after Weave captured the abort (the `deferred` state) or
   * before Weave's own `agent_settled` handler ever ran (the `open` state,
   * when the compaction extension is loaded first and drives `ctx.compact()`
   * from its own handler). Both orders are recorded; neither blocks.
   */
  observeCompactionLifecycle(): void {
    if (this.state.kind === "closed") return;
    // A second lifecycle event of the same compaction keeps the first bounded
    // window rather than extending it.
    if (this.state.kind === "evidenced" || this.state.kind === "compacting") {
      return;
    }
    if (this.state.kind === "open") {
      this.state = {
        kind: "evidenced",
        resumed: false,
        timer: this.timerPort.schedule(
          () => this.expireEvidence(),
          this.evidenceGraceMs,
        ),
      };
      return;
    }
    const { failure } = this.state;
    this.state.timer.cancel();
    this.state = {
      kind: "compacting",
      failure,
      timer: this.timerPort.schedule(
        () => this.publish(),
        this.resumeTimeoutMs,
      ),
    };
  }

  /**
   * Records a new `turn_start`.
   *
   * A turn that begins after compaction evidence is the resumed run the
   * compaction extension asked for, so the captured failure is discarded and
   * the ordinary settlement path owns the next outcome.
   *
   * A turn that begins while a failure is deferred with NO compaction evidence
   * is an unrelated turn. Pi drives `ctx.compact()`'s prologue before any new
   * turn starts, so a compaction that would explain the abort would already
   * have emitted `session_before_compact`. Leaving the failure merely deferred
   * here would let lifecycle evidence belonging to that later, unrelated turn
   * adopt the stale verdict and resume it into a success. The captured failure
   * is published immediately instead and the gate closes for good.
   */
  observeTurnStart(): void {
    if (this.state.kind === "deferred") {
      this.publish();
      return;
    }
    if (this.state.kind === "compacting") {
      this.state.timer.cancel();
      this.state = { kind: "open" };
      return;
    }
    if (this.state.kind === "evidenced" && !this.state.resumed) {
      // The resumed run is already in flight. Its own bounded evidence window
      // still owns the timer, so nothing new is armed here.
      this.state = { ...this.state, resumed: true };
    }
  }

  /**
   * Asks whether a non-abort `agent_settled` may be reported now.
   *
   * A settlement that follows compaction evidence is the resumed run's own
   * outcome and is admitted: that is the whole point of the gate. A settlement
   * that arrives while a failure is deferred with NO evidence belongs to some
   * later, unrelated run, and admitting it would convert an observed provider
   * or local abort into a success. The deferred failure is published instead
   * and the newer settlement is suppressed, so the terminal outcome stays the
   * first one the child actually reported.
   */
  admitSettlement(): SettlementAdmission {
    if (this.state.kind === "closed") return { kind: "suppress" };
    if (this.state.kind === "deferred") {
      this.publish();
      return { kind: "suppress" };
    }
    if (this.state.kind !== "open") {
      this.state.timer.cancel();
    }
    this.state = { kind: "closed" };
    return { kind: "admit" };
  }

  /** Publishes any deferred failure immediately (session shutdown). */
  flush(): void {
    this.publish();
  }

  /**
   * Drops any armed timer without publishing and closes the gate for good.
   *
   * Teardown paths only (session shutdown, cancellation). Once disposed, no
   * later timer, evidence event, or abort settlement can publish anything.
   */
  dispose(): void {
    if (this.state.kind !== "open" && this.state.kind !== "closed") {
      this.state.timer.cancel();
    }
    this.state = { kind: "closed" };
  }

  /** The bounded compaction-evidence window closed with no abort observed. */
  private expireEvidence(): void {
    if (this.state.kind !== "evidenced") return;
    this.state.timer.cancel();
    this.state = { kind: "open" };
  }

  private publish(): void {
    if (this.state.kind !== "deferred" && this.state.kind !== "compacting") {
      return;
    }
    const { failure, timer } = this.state;
    timer.cancel();
    this.state = { kind: "closed" };
    this.onExpire(failure);
  }
}
