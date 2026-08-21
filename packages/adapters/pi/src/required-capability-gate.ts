/**
 * Required-capability gate (Spec 33 §16).
 *
 * One required capability — `delegated-specialist-execution` — models whether
 * this generation may run a delegated child at all. Its readiness is proven by
 * the real Pi session/process host surfaces and the adapter-owned session
 * root, so without it the adapter cannot prove where a persistent session
 * mutation would land. Every mutating adapter route must therefore fail
 * **before** it reaches a delegation controller, session service, filesystem,
 * cache, execution lease, or child process.
 *
 * This module owns only the top-level boundary decision. It answers one
 * question — "may this generation perform a persistent session mutation?" —
 * from the generation's own health report. It performs no I/O, reads no
 * environment variable, and has no override: a capability gap can only be
 * cleared by a host whose real session and process surfaces probe ready.
 *
 * Lower-level host, store, and RPC guards live with their owning modules.
 */
import {
  type AdapterHealthReport,
  type CapabilityId,
  REQUIRED_CAPABILITIES,
} from "@weaveio/weave-engine";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import {
  makeRequiredCapabilityUnavailableFailure,
  type PiAdapterFailure,
} from "./errors.js";

/**
 * The required capability every persistent session mutation depends on.
 *
 * The adapter observes it through the real Pi host surface probes and the
 * adapter-owned session root, never from static knowledge alone.
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
const CAPABILITY_GAP_REASON_OBJECT_SCHEMA = z.custom<object>(
  (value) => value !== null && Object(value) === value,
);
const CAPABILITY_GAP_REASON_INPUT_SCHEMA = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.bigint(),
  z.symbol(),
  z.null(),
  z.undefined(),
  CAPABILITY_GAP_REASON_OBJECT_SCHEMA,
]);
const SAFE_CAPABILITY_GAP_REASON_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(MAX_REASON_LENGTH)
  .regex(SAFE_REASON_PATTERN);
type PiCapabilityGapReasonInput = z.input<
  typeof CAPABILITY_GAP_REASON_INPUT_SCHEMA
>;

/**
 * Keep only short, printable, obviously non-sensitive reasons.
 *
 * Probe details are already sanitized by the capability prober, but this gate
 * is what renders into `/weave:health` and `status`, so it re-checks rather
 * than trusting an upstream contract. Anything unexpected degrades to a
 * constant instead of leaking a path or prompt fragment.
 */
export function sanitizeCapabilityGapReason(
  raw: PiCapabilityGapReasonInput,
): string {
  const parsed = SAFE_CAPABILITY_GAP_REASON_SCHEMA.safeParse(raw);
  return parsed.success ? parsed.data : UNKNOWN_CAPABILITY_GAP_REASON;
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

/**
 * The closed set of readiness reasons that mean native session storage itself
 * is unproven. Only these block a persistent session mutation; an ordinary
 * health-only gap (a missing plan, an unloaded config) leaves idempotent
 * cleanup available exactly as before.
 */
const SESSION_STORAGE_UNPROVEN_REASONS: ReadonlySet<string> = new Set([
  "pi-session-api-unavailable",
  "pi-session-root-unavailable",
  "pi-session-root-unsafe",
  "pi-process-unavailable",
  // Fail-closed reasons minted by this module when no generation or gate
  // exists at all.
  "no-active-generation",
  "capability-read-failed",
  "capability-gate-unwired",
]);

/** Find the session-mutation capability gap, if the generation has one. */
export function findSessionMutationGap(
  gaps: readonly PiRequiredCapabilityGap[],
): PiRequiredCapabilityGap | undefined {
  return gaps.find(
    (gap) =>
      gap.capabilityId === SESSION_MUTATION_REQUIRED_CAPABILITY &&
      SESSION_STORAGE_UNPROVEN_REASONS.has(gap.reason),
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
      if (gap === undefined) return ok(void 0);
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
    evaluate: (): Result<void, PiAdapterFailure> => ok(void 0),
  });
}
