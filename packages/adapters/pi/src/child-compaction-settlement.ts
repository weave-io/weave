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

/**
 * Structural identity of the run a verdict or a lifecycle event belongs to.
 *
 * `turn` is the child's monotonic turn index, advanced by the host's own
 * `turn_start`. `assistantMessageId` is Pi's id for the assistant message the
 * fact was read from (`message_end`), when the host stated one.
 *
 * The gate compares epochs and never reads error prose. A pre-compaction abort
 * and the resumed run's own failure are indistinguishable by text; they are
 * always distinguishable by the turn they were captured in.
 */
export interface ChildTurnEpoch {
  readonly turn: number;
  readonly assistantMessageId: string | undefined;
}

/**
 * Do two epochs name the same run?
 *
 * The turn index must match exactly. The assistant message id refines the
 * comparison only when BOTH sides carry one: a host that never named an id
 * leaves the turn as the only authority, and inventing a mismatch there would
 * publish a failure the compaction had already explained.
 */
const sameEpoch = (left: ChildTurnEpoch, right: ChildTurnEpoch): boolean => {
  if (left.turn !== right.turn) return false;
  if (
    left.assistantMessageId === undefined ||
    right.assistantMessageId === undefined
  ) {
    return true;
  }
  return left.assistantMessageId === right.assistantMessageId;
};

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
      /** The run the compaction was observed for. */
      readonly epoch: ChildTurnEpoch;
      readonly timer: TimerHandle;
    }
  | {
      readonly kind: "deferred";
      readonly failure: DeferredChildFailure;
      readonly epoch: ChildTurnEpoch;
      readonly timer: TimerHandle;
    }
  | {
      readonly kind: "compacting";
      readonly failure: DeferredChildFailure;
      readonly epoch: ChildTurnEpoch;
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
 * recorded for THE SAME RUN - either before the abort (`evidenced`) or after it
 * (`compacting`). "The same run" is a structural comparison of the turn index
 * and the assistant message id the verdict was read from, never a reading of
 * the failure's prose: an abort captured in the compacted turn is the
 * compaction's own abort, while an abort captured in the RESUMED turn is that
 * run's genuine failure and is published like any other.
 *
 * A `turn_start` with no such evidence is an unrelated turn: it
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
  /**
   * The one epoch whose verdict was already discarded as a compaction's own
   * pre-compaction abort. Pi can re-enter `agent_settled` for the same turn,
   * and the stale `stopReason` it reads is still the discarded one, so a
   * repeat of that verdict must be discarded again rather than captured as a
   * fresh failure. Exactly one epoch is remembered, so nothing grows.
   */
  private discardedEpoch: ChildTurnEpoch | undefined;
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
    epoch: ChildTurnEpoch,
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
    if (
      this.discardedEpoch !== undefined &&
      sameEpoch(epoch, this.discardedEpoch)
    ) {
      // A repeat of a verdict the compaction already explained.
      return { kind: "suppress", why: "resumed" };
    }
    if (this.state.kind === "evidenced") {
      const evidence = this.state;
      if (sameEpoch(epoch, evidence.epoch)) {
        evidence.timer.cancel();
        if (evidence.resumed) {
          // Compaction completed AND its resumed run already started before
          // this settlement was observed. The verdict was captured in the
          // compacted turn, so it belongs to the aborted pre-compaction run,
          // and the run now in flight owns the next outcome: nothing is
          // captured and nothing is armed.
          this.state = { kind: "open" };
          this.discardedEpoch = epoch;
          return { kind: "suppress", why: "resumed" };
        }
        this.state = {
          kind: "compacting",
          failure,
          epoch,
          timer: this.timerPort.schedule(
            () => this.publish(),
            this.resumeTimeoutMs,
          ),
        };
        return { kind: "defer" };
      }
      // A verdict from a different run than the compaction was observed for -
      // in practice the resumed run's OWN error or abort. The compaction
      // explains nothing about it, so the evidence window is dropped and the
      // verdict is captured like any ordinary failure.
      evidence.timer.cancel();
    }
    this.state = {
      kind: "deferred",
      failure,
      epoch,
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
  observeCompactionLifecycle(epoch: ChildTurnEpoch): void {
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
        epoch,
        timer: this.timerPort.schedule(
          () => this.expireEvidence(),
          this.evidenceGraceMs,
        ),
      };
      return;
    }
    const { failure, epoch: failureEpoch } = this.state;
    if (!sameEpoch(epoch, failureEpoch)) {
      // Evidence for a different run cannot adopt this verdict. Fail closed:
      // the captured failure is published now.
      this.publish();
      return;
    }
    this.state.timer.cancel();
    this.state = {
      kind: "compacting",
      failure,
      epoch: failureEpoch,
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
      // The captured verdict is discarded here as the compaction's own
      // pre-compaction abort. Pi can re-enter `agent_settled` for that same
      // turn - the stale `stopReason` it reads is still the discarded one -
      // so the epoch is remembered exactly as the evidence-first path
      // remembers it. Without this, the abort-first order would capture the
      // very verdict it just discarded and publish it as the resumed run's
      // failure. A genuine failure of the resumed run carries a NEW epoch and
      // is still captured and published.
      this.discardedEpoch = this.state.epoch;
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
