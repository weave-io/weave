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
      readonly why: "deferred" | "compacting" | "closed";
    };

/** Whether a non-abort settlement may be reported now. */
export type SettlementAdmission =
  | { readonly kind: "admit" }
  | { readonly kind: "suppress" };

type GateState =
  | { readonly kind: "open" }
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
 * A four-state, fully bounded gate that separates a compaction-intent local
 * abort from a genuine terminal failure using host lifecycle events only -
 * never error prose, never a third-party extension's private state.
 *
 * ```
 *                 abort/error agent_settled
 *   open ─────────────────────────────────────▶ deferred ──(grace expires)──▶ closed (publish)
 *     ▲                                            │  │
 *     │                                            │  └─ session_before_compact / session_compact
 *     │                                            │        │
 *     │           turn_start (resumed)             │        ▼
 *     └────────────────────────────────────────────┴─── compacting ──(resume timeout)──▶ closed (publish)
 *                                                            │
 *                                                            └─ turn_start (resumed) ──▶ open
 *
 *   any state ── non-abort agent_settled ──▶ closed (admit the ordinary path)
 * ```
 *
 * Every non-`open` state that holds a captured failure also holds exactly one
 * live timer, so the child can never sit deferred forever.
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
   * `session_compact`). Only meaningful while a settlement is deferred.
   */
  observeCompactionLifecycle(): void {
    if (this.state.kind === "open" || this.state.kind === "closed") return;
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
   * Records a new `turn_start`. A turn that begins after a deferred abort is
   * the resumed run, so the captured failure is discarded and the ordinary
   * settlement path owns the next outcome.
   */
  observeTurnStart(): void {
    if (this.state.kind !== "deferred" && this.state.kind !== "compacting") {
      return;
    }
    this.state.timer.cancel();
    this.state = { kind: "open" };
  }

  /**
   * Asks whether a non-abort `agent_settled` may be reported now. A genuine
   * settlement always wins over a deferred failure, so no settlement is lost.
   */
  admitSettlement(): SettlementAdmission {
    if (this.state.kind === "closed") return { kind: "suppress" };
    if (this.state.kind === "deferred" || this.state.kind === "compacting") {
      this.state.timer.cancel();
    }
    this.state = { kind: "closed" };
    return { kind: "admit" };
  }

  /** Publishes any deferred failure immediately (session shutdown). */
  flush(): void {
    this.publish();
  }

  /** Drops any armed timer without publishing. Used only on teardown paths. */
  dispose(): void {
    if (this.state.kind === "deferred" || this.state.kind === "compacting") {
      this.state.timer.cancel();
    }
    this.state = { kind: "closed" };
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
