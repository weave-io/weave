/**
 * Required-capability gate for persistent session mutation routes.
 *
 * Session mutation readiness follows the Pi-native path/session contract:
 * `delegated-specialist-execution` is available only when real Pi session API,
 * session root, and process surfaces are ready. Without that readiness the
 * adapter stays health-only before spawn, so mutating routes fail before they
 * reach a delegation controller, session service, filesystem, cache, execution
 * lease, or child process.
 *
 * This module owns only the top-level boundary decision from the generation's
 * health report. It performs no I/O, reads no environment variable, and has no
 * override.
 */
import {
  type AdapterHealthReport,
  type CapabilityId,
  REQUIRED_CAPABILITIES,
} from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";
import {
  makeRequiredCapabilityUnavailableFailure,
  type PiAdapterFailure,
} from "./errors.js";

/**
 * The required capability every persistent session mutation depends on.
 *
 * Observed through effective readiness for delegated specialist execution.
 */
export const SESSION_MUTATION_REQUIRED_CAPABILITY: CapabilityId =
  "delegated-specialist-execution";

/** Operator-facing reason used when the health report carries no detail. */
export const UNKNOWN_CAPABILITY_GAP_REASON = "capability-unavailable";

/** One required capability that is not effective for a generation. */
export interface PiRequiredCapabilityGap {
  readonly capabilityId: CapabilityId;
  /** Sanitized, path-free and prompt-free probe detail. */
  readonly reason: string;
}

const MAX_REASON_LENGTH = 120;
const SAFE_REASON_PATTERN = /^[A-Za-z0-9:_,.\- ]+$/;

/**
 * Keep only short, printable, obviously non-sensitive reasons.
 *
 * Probe details are already sanitized by the capability prober, but this gate
 * is what renders into `/weave:health` and `status`, so it re-checks rather
 * than trusting an upstream contract. Anything unexpected degrades to a
 * constant instead of leaking a path or prompt fragment.
 */
export function sanitizeCapabilityGapReason(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN_CAPABILITY_GAP_REASON;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REASON_LENGTH)
    return UNKNOWN_CAPABILITY_GAP_REASON;
  if (!SAFE_REASON_PATTERN.test(trimmed)) return UNKNOWN_CAPABILITY_GAP_REASON;
  return trimmed;
}

const REQUIRED_SET: ReadonlySet<CapabilityId> = new Set(REQUIRED_CAPABILITIES);

/**
 * Collect every required capability whose effective readiness is not usable.
 *
 * Effective readiness is the probe-lowered readiness the engine computed for
 * the generation, so a host that fails a probe is reported here even when the
 * adapter declared the capability native.
 */
export function collectRequiredCapabilityGaps(
  report: AdapterHealthReport,
): readonly PiRequiredCapabilityGap[] {
  const gaps: PiRequiredCapabilityGap[] = [];
  for (const entry of report.effectiveCapabilities) {
    if (!REQUIRED_SET.has(entry.id)) continue;
    if (
      entry.effectiveReadiness !== "degraded" &&
      entry.effectiveReadiness !== "unsupported"
    )
      continue;
    gaps.push({
      capabilityId: entry.id,
      reason: sanitizeCapabilityGapReason(entry.probeDetails),
    });
  }
  return Object.freeze(gaps);
}

/** Find the session-mutation capability gap, if the generation has one. */
export function findSessionMutationGap(
  gaps: readonly PiRequiredCapabilityGap[],
): PiRequiredCapabilityGap | undefined {
  return gaps.find(
    (gap) => gap.capabilityId === SESSION_MUTATION_REQUIRED_CAPABILITY,
  );
}

/**
 * The gate a mutating route calls before it touches any downstream service.
 *
 * `ok` means the route may proceed. `err` carries the typed
 * `RequiredCapabilityUnavailable` failure the route returns verbatim.
 */
export interface PiSessionMutationGate {
  evaluate(): Result<void, PiAdapterFailure>;
}

/**
 * Build a gate over a live gap reader.
 *
 * The reader is called per evaluation so a gate captured at wiring time still
 * reflects the current controller generation.
 */
export function createSessionMutationGate(
  readGaps: () => readonly PiRequiredCapabilityGap[],
): PiSessionMutationGate {
  return Object.freeze({
    evaluate(): Result<void, PiAdapterFailure> {
      let gaps: readonly PiRequiredCapabilityGap[];
      try {
        gaps = readGaps();
      } catch {
        // A reader that throws is treated as a gap: fail closed.
        return err(
          makeRequiredCapabilityUnavailableFailure(
            SESSION_MUTATION_REQUIRED_CAPABILITY,
            "capability-read-failed",
          ),
        );
      }
      const gap = findSessionMutationGap(gaps);
      if (gap === undefined) return ok(undefined);
      return err(
        makeRequiredCapabilityUnavailableFailure(gap.capabilityId, gap.reason),
      );
    },
  });
}

/**
 * A gate that always blocks, for call sites that have no generation at all.
 *
 * "No generation" is not proof that the host is descriptor-safe, so the
 * fail-closed answer is unavailable rather than available.
 */
export function createBlockedSessionMutationGate(
  reason = "no-active-generation",
): PiSessionMutationGate {
  const sanitized = sanitizeCapabilityGapReason(reason);
  return Object.freeze({
    evaluate: (): Result<void, PiAdapterFailure> =>
      err(
        makeRequiredCapabilityUnavailableFailure(
          SESSION_MUTATION_REQUIRED_CAPABILITY,
          sanitized,
        ),
      ),
  });
}

/**
 * Evaluate an optional gate at a call site that may not have been wired.
 *
 * A missing gate is a wiring gap, not a proof of capability, so it fails
 * closed with the same typed failure as a real capability gap.
 */
export function requireSessionMutationCapability(
  gate: PiSessionMutationGate | undefined,
): Result<void, PiAdapterFailure> {
  if (gate === undefined)
    return err(
      makeRequiredCapabilityUnavailableFailure(
        SESSION_MUTATION_REQUIRED_CAPABILITY,
        "capability-gate-unwired",
      ),
    );
  return gate.evaluate();
}

/**
 * A gate that always allows. Only test doubles and hypothetical
 * descriptor-safe hosts reach this: production always derives the gate from a
 * real health report.
 */
export function createOpenSessionMutationGate(): PiSessionMutationGate {
  return Object.freeze({
    evaluate: (): Result<void, PiAdapterFailure> => ok(undefined),
  });
}
