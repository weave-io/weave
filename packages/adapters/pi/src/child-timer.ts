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
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_REPLY_TIMEOUT_MS = 15_000;
/** Maximum silence while awaiting settlement; parser-approved child activity renews this budget. */
export const DEFAULT_SETTLEMENT_TIMEOUT_MS = 15 * 60 * 1000;
/** Bounded grace period cancellation waits for an authenticated `cancelled` ack or process exit before force-killing. */
export const DEFAULT_CANCEL_GRACE_MS = 5_000;
