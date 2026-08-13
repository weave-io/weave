/** Injected timer port for handshake/reply/settlement inactivity timeouts (Pi adapter contract). Production uses only `globalThis.setTimeout`. */
export interface TimerHandle {
  cancel(): void;
}

export interface TimerPort {
  schedule(callback: () => void, delayMs: number): TimerHandle;
}

export class SystemTimerPort implements TimerPort {
  schedule(callback: () => void, delayMs: number): TimerHandle {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  }
}

/** Default budgets for the private child protocol (Pi adapter contract). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
export const DEFAULT_REPLY_TIMEOUT_MS = 60_000;
/** Maximum silence while awaiting settlement; parser-approved child activity renews this budget. */
export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 60 * 60 * 1_000;
/**
 * Absolute wall-clock lifetime of a single child, measured from the moment the
 * process is spawned. Unlike {@link DEFAULT_SETTLEMENT_TIMEOUT_MS} this budget
 * is never renewed by activity: a child that keeps emitting parser-approved
 * events forever (a periodic tool, an unbounded retry loop) is still bounded by
 * it, so a delegated run can never occupy the parent indefinitely.
 */
export const DEFAULT_CHILD_RUNTIME_BUDGET_MS = 6 * 60 * 60 * 1_000;
/**
 * Bounded window the parent keeps open after an authenticated `settled`
 * envelope so final parser-approved session events already in flight are
 * drained before the child result contract is classified (Pi adapter contract
 * §10). Without it, an out-of-order terminal `message_end` would produce a
 * false `ChildResponseMissing`.
 */
export const DEFAULT_RESPONSE_DRAIN_MS = 250;
/** Bounded grace period cancellation waits for an authenticated `cancelled` ack or process exit before force-killing. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;
