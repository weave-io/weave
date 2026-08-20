import type { TimerHandle, TimerPort } from "./child-timer.js";
import type { PiAdapterFailure } from "./errors.js";

/**
 * The absolute wall-clock cap on a single child's lifetime (Pi adapter
 * contract). It is deliberately *not* the renewable settlement inactivity
 * budget: a child that keeps producing parser-approved activity renews the
 * inactivity budget forever, so without this cap a periodic tool or an
 * unbounded retry loop can occupy the parent without end.
 *
 * The failure is terminal and fails closed - the caller force-kills the
 * process - but it is retryable and never destroys the child's thread or
 * native session, so the run can be explicitly recovered.
 */
export function makeChildRuntimeExceededFailure(
  childId: string,
  budgetMs: number,
): PiAdapterFailure {
  return {
    code: "ChildRuntimeExceeded",
    phase: "child",
    scope: { kind: "child", id: childId },
    impact: "operation-stopped",
    retryable: true,
    recovery: "retry",
    safeMessage:
      "The delegated child exceeded its absolute runtime budget and was stopped.",
    correlation: { budgetMs },
  };
}

/**
 * One-shot wall-clock budget for a child. Armed once at the spawn boundary and
 * never rearmed: `start` after the first call is a no-op, so no activity path
 * can accidentally extend it. `clear` is idempotent and is called from the
 * child's single terminal cleanup step, which keeps the timer from outliving
 * any settlement, failure, cancellation, or disposal path.
 */
export class ChildRuntimeBudget {
  private timer: TimerHandle | undefined;
  private armed = false;

  constructor(
    private readonly timerPort: TimerPort,
    private readonly budgetMs: number,
  ) {}

  /** Arms the budget. Only the first call schedules anything. */
  start(onExpire: () => void): void {
    if (this.armed) return;
    this.armed = true;
    let expiredBeforeHandleAssignment = false;
    const timer = this.timerPort.schedule(() => {
      if (this.timer === undefined) {
        expiredBeforeHandleAssignment = true;
      } else {
        this.timer = undefined;
      }
      onExpire();
    }, this.budgetMs);
    if (expiredBeforeHandleAssignment) {
      timer.cancel();
      return;
    }
    this.timer = timer;
  }

  clear(): void {
    this.timer?.cancel();
    this.timer = undefined;
  }

  getBudgetMs(): number {
    return this.budgetMs;
  }
}
