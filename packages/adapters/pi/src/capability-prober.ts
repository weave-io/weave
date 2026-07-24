import type {
  CapabilityId,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { isOwnSourceInfo, WEAVE_COMMAND_NAMES } from "./commands.js";
import type { PiCommandInfo, PiMode, PiTrustState } from "./types.js";

/**
 * Capabilities whose "not yet implemented" probe would otherwise read a
 * project path. Per Spec 33 §7.3, while a project is untrusted these report
 * `ok` for the narrow fact that project access was correctly withheld, not
 * that the capability itself is supported.
 */
export const PROJECT_PATH_DEPENDENT_CAPABILITIES: readonly CapabilityId[] = [
  "config-materialization",
  "agent-materialization",
  "primary-agent-selection",
  "delegated-specialist-execution",
  "workflow-persistence",
  "workflow-step-dispatch",
  "plan-file-compatibility",
];

/** Input a capability prober needs; assembled after mode/host/trust are known. */
export interface PiPreflightContext {
  readonly mode: PiMode;
  readonly trust: PiTrustState;
  readonly commands: readonly PiCommandInfo[];
}

/** Adapter-owned seam so tests can substitute a fully-controlled probe set (Spec 33 §24). */
export interface PiCapabilityProbeSource {
  probe(context: PiPreflightContext): readonly CapabilityProbeResult[];
}

/**
 * Returns exactly one `unavailable` probe for every capability ID, with a
 * shared reason. Used when mode or host identity/version blocks preflight
 * before any other probe can safely run (Spec 33 §7.2 step 9).
 */
export function buildBlockedProbeSet(reason: string): CapabilityProbeResult[] {
  return ALL_CAPABILITY_IDS.map((capabilityId) => ({
    capabilityId,
    probeStatus: "unavailable" as const,
    details: reason,
  }));
}

/**
 * True when `entryName` is a Pi-assigned numeric collision suffix of
 * `baseName` (e.g. `"weave:health:2"` for base `"weave:health"`). Pi appends
 * `:N` to the whole registered name in load order when multiple extensions
 * register the same command name.
 */
function isSuffixedVariant(entryName: string, baseName: string): boolean {
  if (!entryName.startsWith(`${baseName}:`)) return false;
  const suffix = entryName.slice(baseName.length + 1);
  return suffix.length > 0 && /^\d+$/.test(suffix);
}

/**
 * Verifies exclusive ownership of every required `/weave:*` command (Spec 33
 * §7.1): each name must have exactly one unsuffixed invocation whose
 * `sourceInfo` proves it is ours, and no same-base numeric-suffixed entry
 * may exist at all (a suffix means some registration collided on this name,
 * even if we kept the bare slot).
 */
function evaluateCommandEntrypoints(
  commands: readonly PiCommandInfo[],
): CapabilityProbeResult {
  const problems: string[] = [];
  for (const name of WEAVE_COMMAND_NAMES) {
    const owned = commands.find(
      (command) => command.name === name && isOwnSourceInfo(command.sourceInfo),
    );
    if (owned === undefined) {
      problems.push(name);
      continue;
    }
    const collided = commands.some(
      (command) =>
        command.name !== name && isSuffixedVariant(command.name, name),
    );
    if (collided) problems.push(name);
  }
  if (problems.length > 0) {
    return {
      capabilityId: "command-entrypoints",
      probeStatus: "unavailable",
      details: `command-collision-or-missing:${problems.join(",")}`,
    };
  }
  return {
    capabilityId: "command-entrypoints",
    probeStatus: "ok",
    details: "all-nine-commands-exclusively-owned",
  };
}

/**
 * Production capability prober for this foundation task. Only
 * `command-entrypoints` and `token-usage-reporting` reflect real,
 * independently-verifiable facts today; every other capability honestly
 * reports `unavailable` (or, under trust-withheld, the narrow
 * `project-trust-withheld` `ok`) until the subsystem that backs it lands in
 * a later task. This never raises a declared ceiling - it only ever
 * preserves or lowers it, matching `lowerReadinessByProbe`.
 */
export class DefaultPiCapabilityProber implements PiCapabilityProbeSource {
  probe(context: PiPreflightContext): readonly CapabilityProbeResult[] {
    return ALL_CAPABILITY_IDS.map((id) => this.probeOne(id, context));
  }

  private probeOne(
    id: CapabilityId,
    context: PiPreflightContext,
  ): CapabilityProbeResult {
    if (id === "command-entrypoints") {
      return evaluateCommandEntrypoints(context.commands);
    }
    if (id === "token-usage-reporting") {
      return {
        capabilityId: id,
        probeStatus: "ok",
        details: "native-per-message-usage-fields",
      };
    }
    if (
      context.trust === "withheld" &&
      PROJECT_PATH_DEPENDENT_CAPABILITIES.includes(id)
    ) {
      return {
        capabilityId: id,
        probeStatus: "ok",
        details: "project-trust-withheld",
      };
    }
    return {
      capabilityId: id,
      probeStatus: "unavailable",
      details: "not-yet-implemented",
    };
  }
}

const VALID_PROBE_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "degraded",
  "unavailable",
]);
const KNOWN_CAPABILITY_IDS: ReadonlySet<string> = new Set(ALL_CAPABILITY_IDS);

/** Bound on a sanitized probe `details` string (Spec 33 §19.1: no raw payloads in diagnostics). */
const MAX_SAFE_DETAILS_LENGTH = 200;
/** Printable ASCII only — matches the plain-punctuation, no-secrets diagnostics contract. */
const SAFE_DETAILS_PATTERN = /^[\x20-\x7E]*$/;

function isSafeDetails(details: unknown): details is string | undefined {
  if (details === undefined) return true;
  if (typeof details !== "string") return false;
  if (details.length > MAX_SAFE_DETAILS_LENGTH) return false;
  return SAFE_DETAILS_PATTERN.test(details);
}

interface RawProbeCandidate {
  readonly capabilityId?: unknown;
  readonly probeStatus?: unknown;
  readonly details?: unknown;
}

/**
 * Normalizes a raw, potentially-anomalous probe array from an injected
 * prober into exactly one sanitized {@link CapabilityProbeResult} per
 * canonical capability ID (Spec 33 §21). A missing, duplicate,
 * contradictory, malformed-status, unknown-ID, or unsafe-detail entry for a
 * given ID is reduced to a single `unavailable` sanitized row for that ID.
 * This never raises readiness — it only ever preserves or lowers the
 * declared ceiling once `lowerReadinessByProbe` runs on the result.
 */
export function sanitizeCapabilityProbeResults(
  raw: readonly unknown[],
): CapabilityProbeResult[] {
  const byId = new Map<string, RawProbeCandidate[]>();
  for (const candidate of raw) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const entry = candidate as RawProbeCandidate;
    if (typeof entry.capabilityId !== "string") continue;
    if (!KNOWN_CAPABILITY_IDS.has(entry.capabilityId)) continue;
    const bucket = byId.get(entry.capabilityId) ?? [];
    bucket.push(entry);
    byId.set(entry.capabilityId, bucket);
  }

  return ALL_CAPABILITY_IDS.map((id): CapabilityProbeResult => {
    const bucket = byId.get(id);
    if (bucket === undefined || bucket.length === 0) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-missing",
      };
    }
    if (bucket.length > 1) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-anomalous",
      };
    }
    const [single] = bucket;
    if (
      single === undefined ||
      typeof single.probeStatus !== "string" ||
      !VALID_PROBE_STATUSES.has(single.probeStatus)
    ) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-malformed-status",
      };
    }
    if (!isSafeDetails(single.details)) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-unsafe-details",
      };
    }
    return {
      capabilityId: id,
      probeStatus: single.probeStatus as "ok" | "degraded" | "unavailable",
      ...(single.details !== undefined ? { details: single.details } : {}),
    };
  });
}
