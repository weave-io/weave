/**
 * Bounded child telemetry projection (plan Task 5) and terminal-error
 * retention (plan Task 12).
 *
 * Sits between `child-overlay-types` and `child-overlay-controller` in the
 * overlay layer order: it holds only pure derivations over already-validated
 * facts (a parsed usage report, a sanitized provider-error projection, and a
 * validated child descriptor) and never touches controller state, the harness,
 * or the filesystem.
 *
 * The exact Pi 0.83 field mapping this consumes is documented on
 * `parsePiChildUsageReport` in `child-session-events.ts`; the pi-ai 0.84.1
 * terminal-error shape is documented in `child-provider-error.ts`.
 */

import {
  CHILD_OVERLAY_TELEMETRY_BOUNDS,
  type ChildOverlayChild,
  type ChildOverlayEntry,
  type ChildOverlayTelemetry,
} from "./child-overlay-types.js";
import {
  type PiChildProviderError,
  parsePiChildProviderError,
  redactProviderErrorFromEvent,
} from "./child-provider-error.js";
import {
  type PiChildSessionEvent,
  type PiChildUsageReport,
  parsePiChildUsageReport,
} from "./child-session-events.js";

/**
 * Newest replayed usage report inside a bounded entry window.
 *
 * Historical telemetry may come only from usage events replayed inside the
 * loaded window; nothing is read from outside it and nothing is estimated.
 */
export function latestUsageInWindow(
  entries: readonly ChildOverlayEntry[],
): PiChildUsageReport | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const steps = entries[index]?.replay;
    if (steps === undefined) continue;
    for (let step = steps.length - 1; step >= 0; step -= 1) {
      const candidate = steps[step];
      if (candidate === undefined || candidate.kind !== "event") continue;
      const parsed = parsePiChildUsageReport(candidate.event);
      if (parsed.isOk()) return parsed.value;
    }
  }
  return undefined;
}

/**
 * Newest terminal provider error inside the loaded entry window.
 *
 * Historical errors exist only where the loaded window replays them, and the
 * newest terminal message in that window wins: a later successful terminal
 * message (`ProviderErrorCleared`) stops the scan with no error, exactly as
 * the live path replaces a stale error. Nothing outside the window is read.
 */
export function latestWindowError(
  entries: readonly ChildOverlayEntry[],
): PiChildProviderError | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const steps = entries[index]?.replay;
    if (steps === undefined) continue;
    for (let step = steps.length - 1; step >= 0; step -= 1) {
      const candidate = steps[step];
      if (candidate === undefined || candidate.kind !== "event") continue;
      const parsed = parsePiChildProviderError(candidate.event);
      if (parsed.isOk()) return parsed.value;
      if (parsed.error.type === "ProviderErrorCleared") return undefined;
    }
  }
  return undefined;
}

/**
 * Latest terminal provider error after one live event, and the event with the
 * raw provider text removed.
 *
 * Two rules travel together because they must not diverge: the overlay stores
 * parsed events, so the redacted event is the only one that may reach a reduce,
 * and the retained error is whatever that same event authoritatively says.
 * Latest wins and replaces; an authoritative terminal success clears a stale
 * error; anything unauthoritative leaves the previous value untouched.
 */
export function applyProviderErrorEvent(
  previous: PiChildProviderError | undefined,
  event: PiChildSessionEvent,
): {
  readonly event: PiChildSessionEvent;
  readonly providerError: PiChildProviderError | undefined;
} {
  const redacted = redactProviderErrorFromEvent(event);
  const parsed = parsePiChildProviderError(redacted);
  if (parsed.isOk()) {
    return { event: redacted, providerError: parsed.value };
  }
  return {
    event: redacted,
    providerError:
      parsed.error.type === "ProviderErrorCleared" ? undefined : previous,
  };
}

const boundedModelLabel = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > CHILD_OVERLAY_TELEMETRY_BOUNDS.maxModelLength
    ? undefined
    : trimmed;
};

/**
 * Provider prefix of an unambiguous qualified model identifier.
 *
 * Only `provider/model` with exactly one separator and non-empty, bounded
 * sides yields a provider. Bare names, multi-segment paths, and empty sides
 * stay ambiguous, so the provider is absent rather than guessed.
 */
function providerFromModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const parts = model.split("/");
  if (parts.length !== 2) return undefined;
  const [provider, name] = parts;
  if (provider === undefined || name === undefined) return undefined;
  if (provider.length === 0 || name.length === 0) return undefined;
  if (provider.length > CHILD_OVERLAY_TELEMETRY_BOUNDS.maxModelLength) {
    return undefined;
  }
  return provider;
}

/**
 * Project the retained usage report into the bounded view telemetry.
 *
 * The model falls back to the newest run divider's model label, which is an
 * already-validated descriptor fact. Percent is computed only when the host
 * reported both operands and the window is positive; the host-reported percent
 * is never trusted and no limit is inferred from a model name.
 */
export function deriveChildOverlayTelemetry(
  usage: PiChildUsageReport | undefined,
  child: ChildOverlayChild,
): ChildOverlayTelemetry | undefined {
  const descriptorModel = boundedModelLabel(
    child.runs[child.runs.length - 1]?.model,
  );
  const model = boundedModelLabel(usage?.model) ?? descriptorModel;
  const contextTokens = usage?.contextTokens;
  const contextWindow = usage?.contextWindow;
  const contextPercent =
    contextTokens !== undefined &&
    contextWindow !== undefined &&
    contextWindow > 0
      ? Math.min(100, Math.round((contextTokens / contextWindow) * 100))
      : undefined;

  const telemetry: ChildOverlayTelemetry = {
    provider: providerFromModel(model),
    model,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    reasoningTokens: usage?.reasoningTokens,
    totalTokens: usage?.totalTokens,
    contextTokens,
    contextWindow,
    contextPercent,
  };
  return Object.values(telemetry).some((value) => value !== undefined)
    ? telemetry
    : undefined;
}
