import { Result, ResultAsync } from "neverthrow";
import type {
  PiLiveReasoningObserver,
  PiLiveReasoningUpdate,
} from "./child-live-reasoning-types.js";
import {
  type ChildUiEventDiagnosticsSink,
  recordChildUiEventFailure,
} from "./child-ui-event-diagnostics.js";

export type PiLiveReasoningDiagnosticsProvider = () =>
  | ChildUiEventDiagnosticsSink
  | undefined;

function recordFanoutFailure(
  diagnostics: PiLiveReasoningDiagnosticsProvider,
): void {
  recordChildUiEventFailure(diagnostics(), "fanout", "callback-failed");
}

function isResult(value: unknown): value is Result<unknown, unknown> {
  return Result.fromThrowable(
    () =>
      typeof value === "object" &&
      value !== null &&
      "isErr" in value &&
      typeof (value as { readonly isErr?: unknown }).isErr === "function",
    () => false,
  )().unwrapOr(false);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Result.fromThrowable(
    () =>
      typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as { readonly then?: unknown }).then === "function",
    () => false,
  )().unwrapOr(false);
}

/**
 * Invokes a UI observer without allowing synchronous or asynchronous observer
 * failures to cross the projector seam. Result-like observer values remain
 * UI-only and are never turned into session events.
 */
export function notifyPiLiveReasoningObserver(
  observer: PiLiveReasoningObserver | undefined,
  update: PiLiveReasoningUpdate,
  diagnostics: PiLiveReasoningDiagnosticsProvider,
): void {
  if (observer === undefined) return;
  const invoked = Result.fromThrowable(
    () => observer(update),
    () => undefined,
  )();
  if (invoked.isErr()) {
    recordFanoutFailure(diagnostics);
    return;
  }
  const result = invoked.value;
  const isAsyncResult = Result.fromThrowable(
    () => result instanceof ResultAsync,
    () => false,
  )().unwrapOr(false);
  if (isAsyncResult) {
    const asyncResult = result as ResultAsync<unknown, unknown>;
    void asyncResult.match(
      () => undefined,
      () => recordFanoutFailure(diagnostics),
    );
    return;
  }
  if (isResult(result)) {
    const failed = Result.fromThrowable(
      () => result.isErr(),
      () => true,
    )().unwrapOr(true);
    if (failed) recordFanoutFailure(diagnostics);
    return;
  }
  if (isPromiseLike(result)) {
    const pending = Result.fromThrowable(
      () => ResultAsync.fromPromise(result, () => undefined),
      () => undefined,
    )();
    if (pending.isErr()) {
      recordFanoutFailure(diagnostics);
      return;
    }
    void pending.value.match(
      (value) => {
        if (!isResult(value)) return;
        const failed = Result.fromThrowable(
          () => value.isErr(),
          () => true,
        )().unwrapOr(true);
        if (failed) recordFanoutFailure(diagnostics);
      },
      () => recordFanoutFailure(diagnostics),
    );
  }
}

/** Invalidates only the process-memory row listeners for the live projection. */
export function invalidatePiLiveReasoningObservers(
  observers: ReadonlySet<() => void>,
  diagnostics: PiLiveReasoningDiagnosticsProvider,
): void {
  for (const invalidate of observers) {
    Result.fromThrowable(
      () => invalidate(),
      () => undefined,
    )().match(
      () => undefined,
      () => recordFanoutFailure(diagnostics),
    );
  }
}
