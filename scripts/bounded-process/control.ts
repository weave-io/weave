import { Result } from "neverthrow";
import {
  type BoundedProcess,
  type BoundedProcessLimits,
  type BoundedProcessSignal,
  DEFAULT_BOUNDED_PROCESS_LIMITS,
} from "./contract.js";

export type BoundedWaitOutcome<T> =
  | { readonly kind: "resolved"; readonly value: T }
  | { readonly kind: "rejected" }
  | { readonly kind: "timeout" };

export function normalizedBoundedProcessLimits(
  supplied: Partial<BoundedProcessLimits> | undefined,
): BoundedProcessLimits {
  const defaults = DEFAULT_BOUNDED_PROCESS_LIMITS;
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  return {
    spawnMs: positive(supplied?.spawnMs, defaults.spawnMs),
    firstOutputMs: positive(supplied?.firstOutputMs, defaults.firstOutputMs),
    totalReadMs: positive(supplied?.totalReadMs, defaults.totalReadMs),
    gracefulTermMs: positive(supplied?.gracefulTermMs, defaults.gracefulTermMs),
    postKillMs: positive(supplied?.postKillMs, defaults.postKillMs),
    cleanupMs: positive(supplied?.cleanupMs, defaults.cleanupMs),
    maxCaptureBytes: positive(
      supplied?.maxCaptureBytes,
      defaults.maxCaptureBytes,
    ),
  };
}

/**
 * Observe a promise and an independent timer. The losing promise always has
 * a rejection handler, so a late host failure cannot become an unhandled
 * rejection after the process boundary has closed.
 */
export function observeBoundedPromise<T>(
  promiseLike: PromiseLike<T>,
  timeoutMs?: number,
): Promise<BoundedWaitOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: BoundedWaitOutcome<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(outcome);
    };

    const observed = Result.fromThrowable(
      () => Promise.resolve(promiseLike),
      () => undefined,
    )();
    if (observed.isErr()) {
      finish({ kind: "rejected" });
      return;
    }
    // Attach both settlement handlers before a nonpositive deadline can win.
    // The caller may return immediately, but the host promise still needs an
    // observer for any later fulfillment or rejection.
    observed.value.then(
      (value) => finish({ kind: "resolved", value }),
      () => finish({ kind: "rejected" }),
    );
    if (timeoutMs !== undefined) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        finish({ kind: "timeout" });
        return;
      }
      timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    }
  });
}

function processAlreadyExited(process: BoundedProcess): boolean {
  const inspected = Result.fromThrowable(
    () => process.exitCode !== null || process.signalCode !== null,
    () => false,
  )();
  return inspected.isOk() && inspected.value;
}

function signalProcess(
  process: BoundedProcess,
  signal: BoundedProcessSignal,
  timeoutMs: number,
): Promise<boolean> {
  const sent = Result.fromThrowable(
    () => process.kill(signal),
    () => undefined,
  )();
  if (sent.isErr()) return Promise.resolve(false);
  if (sent.value === undefined || sent.value === null) {
    return Promise.resolve(true);
  }
  const promise = Result.fromThrowable(
    () => Promise.resolve(sent.value),
    () => undefined,
  )();
  if (promise.isErr()) return Promise.resolve(false);
  return observeBoundedPromise(promise.value, timeoutMs).then(
    (outcome) => outcome.kind === "resolved",
    () => false,
  );
}

async function waitForBoundedProcessExit(
  process: BoundedProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (processAlreadyExited(process)) return true;
  const exited = Result.fromThrowable(
    () => process.exited,
    () => undefined,
  )();
  if (exited.isErr()) return false;
  const outcome = await observeBoundedPromise(exited.value, timeoutMs);
  return outcome.kind === "resolved";
}

/** TERM, then KILL, with an independent bounded wait for each phase. */
export async function terminateBoundedProcess(
  process: BoundedProcess,
  limits: BoundedProcessLimits,
): Promise<boolean> {
  if (await waitForBoundedProcessExit(process, 0)) return true;
  await signalProcess(process, "SIGTERM", limits.gracefulTermMs);
  if (await waitForBoundedProcessExit(process, limits.gracefulTermMs)) {
    return true;
  }
  await signalProcess(process, "SIGKILL", limits.postKillMs);
  return waitForBoundedProcessExit(process, limits.postKillMs);
}
