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

import { Result } from "neverthrow";
import {
  CHILD_OVERLAY_TELEMETRY_BOUNDS,
  type ChildOverlayChild,
  type ChildOverlayEntry,
  type ChildOverlayIdentity,
  type ChildOverlayPlanContext,
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

// ---------------------------------------------------------------------------
// Terminal error evidence (tri-state)
// ---------------------------------------------------------------------------

/**
 * What the newest authoritative terminal assistant message says about failure.
 *
 * The distinction between `cleared` and `no-evidence` is the whole point.
 * "Absent error" is two different facts:
 *
 * - `cleared`: a terminal message was observed and it succeeded. The child is
 *   known not to be in a failed state, and an *older* error discovered later —
 *   by paging backwards through history — must not resurrect it.
 * - `no-evidence`: no authoritative terminal message has been observed at all.
 *   An older error discovered later is the newest thing known, so it applies.
 *
 * Collapsing both to `undefined` is what let a prepended older page put a
 * stale error back on a child whose latest turn had already succeeded.
 */
export type ChildTerminalErrorEvidence =
  | { readonly kind: "error"; readonly error: PiChildProviderError }
  | { readonly kind: "cleared" }
  | { readonly kind: "no-evidence" };

/** No authoritative terminal message has been observed. */
export const NO_TERMINAL_ERROR_EVIDENCE: ChildTerminalErrorEvidence = {
  kind: "no-evidence",
};

/** The newest terminal message succeeded. */
export const CLEARED_TERMINAL_ERROR_EVIDENCE: ChildTerminalErrorEvidence = {
  kind: "cleared",
};

/**
 * The error a view may expose, or `undefined`. Callers see one optional error
 * and never the tri-state itself, so `cleared` and `no-evidence` stay internal
 * bookkeeping rather than surface API.
 */
export const terminalErrorOf = (
  evidence: ChildTerminalErrorEvidence,
): PiChildProviderError | undefined =>
  evidence.kind === "error" ? evidence.error : undefined;

/**
 * Terminal evidence carried by one already-parsed event.
 *
 * `undefined` means the event is not an authoritative terminal assistant
 * message — a non-terminal event, a non-assistant message, or a malformed or
 * hostile one. Unauthoritative input never becomes evidence, so it can neither
 * set nor clear a retained error.
 */
function eventEvidence(
  event: PiChildSessionEvent,
): ChildTerminalErrorEvidence | undefined {
  const parsed = parsePiChildProviderError(event);
  if (parsed.isOk()) return { kind: "error", error: parsed.value };
  return parsed.error.type === "ProviderErrorCleared"
    ? CLEARED_TERMINAL_ERROR_EVIDENCE
    : undefined;
}

/**
 * Newest terminal evidence inside a bounded entry window.
 *
 * The scan walks entries newest-first and stops at the first authoritative
 * terminal message, which is by construction the newest one in the window. A
 * window whose newest terminal message succeeded yields `cleared`, not
 * `no-evidence`: the window proves a success happened, and that proof is what
 * stops an older error from being adopted later.
 *
 * Malformed, hostile, and non-terminal steps are skipped rather than treated
 * as evidence, so they cannot restore stale data. Nothing outside the window is
 * read.
 */
export function latestWindowErrorEvidence(
  entries: readonly ChildOverlayEntry[],
): ChildTerminalErrorEvidence {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const steps = entries[index]?.replay;
    if (steps === undefined) continue;
    for (let step = steps.length - 1; step >= 0; step -= 1) {
      const candidate = steps[step];
      if (candidate === undefined || candidate.kind !== "event") continue;
      const evidence = eventEvidence(candidate.event);
      if (evidence !== undefined) return evidence;
    }
  }
  return NO_TERMINAL_ERROR_EVIDENCE;
}

/**
 * Newest terminal provider error inside the loaded entry window, or
 * `undefined` when the window carries no error.
 *
 * Retained as the narrow read-only view over
 * {@link latestWindowErrorEvidence} for callers that only need the error and
 * cannot act on the `cleared` / `no-evidence` distinction.
 */
export function latestWindowError(
  entries: readonly ChildOverlayEntry[],
): PiChildProviderError | undefined {
  return terminalErrorOf(latestWindowErrorEvidence(entries));
}

/**
 * Adopt newer terminal evidence over older retained evidence.
 *
 * Newer authoritative evidence always wins, in both directions: a newer error
 * replaces an older error or a `cleared`, and a newer success clears a retained
 * error. `no-evidence` from the newer side proves nothing and therefore changes
 * nothing.
 */
export const adoptNewerEvidence = (
  previous: ChildTerminalErrorEvidence,
  newer: ChildTerminalErrorEvidence,
): ChildTerminalErrorEvidence =>
  newer.kind === "no-evidence" ? previous : newer;

/**
 * Adopt older terminal evidence only where nothing newer is known.
 *
 * This is the prepend rule. Once *any* authoritative terminal message has been
 * observed — an error or a success — an older page cannot speak for the child's
 * latest state, so its evidence is discarded. That is what stops a backwards
 * page from resurrecting an error the child has already recovered from.
 */
export const adoptOlderEvidence = (
  previous: ChildTerminalErrorEvidence,
  older: ChildTerminalErrorEvidence,
): ChildTerminalErrorEvidence =>
  previous.kind === "no-evidence" ? older : previous;

/**
 * Terminal evidence a page of entries contributes, adopted in the direction
 * the page travels.
 *
 * `"newer"` is for a replacement or forward page: it is the authoritative
 * newest view, so its evidence supersedes, and a page with no terminal turn
 * proves nothing and changes nothing. `"older"` is for a backward page: it can
 * only fill an unknown state, so paging backwards past a success can never
 * resurrect the error that preceded it.
 */
export function pageEvidence(
  previous: ChildTerminalErrorEvidence,
  window: readonly ChildOverlayEntry[],
  direction: "older" | "newer",
): ChildTerminalErrorEvidence {
  const found = latestWindowErrorEvidence(window);
  return direction === "older"
    ? adoptOlderEvidence(previous, found)
    : adoptNewerEvidence(previous, found);
}

/**
 * The optional `terminalError` fragment a view spreads.
 *
 * Views expose one optional error and never the tri-state, so `cleared` and
 * `no-evidence` both contribute no property at all.
 */
export const terminalErrorView = (
  evidence: ChildTerminalErrorEvidence,
): { readonly terminalError?: PiChildProviderError } => {
  const terminalError = terminalErrorOf(evidence);
  return terminalError === undefined ? {} : { terminalError };
};

/**
 * Latest terminal evidence after one live event, and the event with the raw
 * provider payload removed.
 *
 * Two rules travel together because they must not diverge: the overlay stores
 * parsed events, so the redacted event is the only one that may reach a reduce,
 * and the retained evidence is whatever that same event authoritatively says.
 * A live event is always the newest fact, so it follows
 * {@link adoptNewerEvidence}.
 */
export function applyProviderErrorEvent(
  previous: ChildTerminalErrorEvidence,
  event: PiChildSessionEvent,
): {
  readonly event: PiChildSessionEvent;
  readonly evidence: ChildTerminalErrorEvidence;
} {
  const redacted = redactProviderErrorFromEvent(event);
  return {
    event: redacted,
    evidence: adoptNewerEvidence(
      previous,
      eventEvidence(redacted) ?? NO_TERMINAL_ERROR_EVIDENCE,
    ),
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
/**
 * Projects the descriptor's authoritative identity and operational facts.
 *
 * Pure and additive: it copies only what the descriptor already carries (the
 * source boundary already proved those facts came from live thread/tree state
 * or the child's own thread metadata) and returns `undefined` when the
 * descriptor named nothing. It never falls back to another child's model, the
 * parent's model, the configured default, or a parsed title.
 */
export function deriveChildOverlayIdentity(
  child: ChildOverlayChild,
): ChildOverlayIdentity | undefined {
  const identity: ChildOverlayIdentity = {
    agentName: child.agentName,
    parentAgentName: child.parentAgentName,
    role: child.role,
    model: child.model,
    reasoning: child.reasoning,
    assignment: child.assignment,
    turn: child.turn,
    queueDepth: child.queueDepth,
    elapsedMs: child.elapsedMs,
    usage: child.usage,
  };
  return Object.values(identity).some((value) => value !== undefined)
    ? identity
    : undefined;
}

/**
 * Reads the parent's already-resolved plan breadcrumb (header row 2), or
 * `undefined` when the parent tracks no active plan. Synchronous by design:
 * a repaint must never start a plan lookup of its own.
 */
export type ChildOverlayPlanContextPort = () =>
  | ChildOverlayPlanContext
  | undefined;

/**
 * Reads one breadcrumb port, isolating a throwing host: a failed ambient
 * lookup clears the breadcrumb and never the inspector around it.
 */
export function readChildOverlayPlanContext(
  port: ChildOverlayPlanContextPort | undefined,
): ChildOverlayPlanContext | undefined {
  if (port === undefined) return undefined;
  return Result.fromThrowable(port, () => undefined)().match(
    (context) => context,
    () => undefined,
  );
}

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
