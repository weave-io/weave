// ---------------------------------------------------------------------------
// Saturating live-proof counters
// ---------------------------------------------------------------------------

export const MAX_LIVE_PROOF_COUNTER = 1_000_000;

/** Saturate one non-negative counter at the report's hard counter bound. */
export function saturatingIncrement(value: number, amount = 1): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(amount) ||
    amount < 0
  ) {
    return MAX_LIVE_PROOF_COUNTER;
  }
  if (value >= MAX_LIVE_PROOF_COUNTER) return MAX_LIVE_PROOF_COUNTER;
  if (amount >= MAX_LIVE_PROOF_COUNTER - value) return MAX_LIVE_PROOF_COUNTER;
  return value + amount;
}

export const saturatingAdd = saturatingIncrement;
export const incrementSaturatedCounter = saturatingIncrement;
