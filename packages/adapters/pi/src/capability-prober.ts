import type {
  CapabilityId,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { isOwnSourceInfo, WEAVE_COMMAND_NAMES } from "./commands.js";
import type { PiHostSurfaceReport } from "./host-inventory.js";
import type { PiCommandInfo, PiMode, PiTrustState } from "./types.js";

/**
 * Capabilities whose "not yet implemented" probe would otherwise read a
 * project path. Per Pi adapter contract, while a project is untrusted these report
 * `ok` for the narrow fact that project access was correctly withheld, not
 * that the capability itself is supported.
 */
export const PROJECT_PATH_DEPENDENT_CAPABILITIES: readonly CapabilityId[] = [
  "config-materialization",
  "agent-materialization",
  "primary-agent-selection",
  "delegated-specialist-execution",
];

/**
 * Real, candidate-plan-derived facts for the four Pi adapter contract
 * capabilities (config activation, materialization, primary selection,
 * prompt composition), computed once during preflight (Pi adapter contract) and
 * threaded into probing so these capabilities reflect the actual outcome
 * instead of a placeholder. Absent (`undefined`) only when preflight is
 * blocked before config activation could safely run (Pi adapter contract,
 * "wrong mode/host/version -\> health-only").
 */
export interface PiCandidatePlanContext {
  readonly configLoaded: boolean;
  readonly materializationErrorCount: number;
  readonly primaryDescriptorFound: boolean;
  readonly primaryModelDryResolved: boolean;
  /** True only when the candidate plan includes the `weave_delegate` tool. */
  readonly delegationToolPlanned?: boolean;
  /** True only when the trusted Runtime Store path passed containment checks. */
  readonly eventLoggingPlanned?: boolean;
  /**
   * Real, read-only no-follow containment proof for `.weave/runtime` under
   * the project root (Pi adapter contract): `true` only when that path either
   * resolves safely inside the project root or does not exist yet - never
   * merely because config loaded. Missing/undefined is treated the same as
   * `false` (unproven) by every caller.
   */
  readonly runtimeDirectoryContained?: boolean;
  /** Same proof as `runtimeDirectoryContained`, for `.weave/plans`. */
  readonly plansDirectoryContained?: boolean;
}

/** Input a capability prober needs; assembled after mode/host/trust are known. */
export interface PiPreflightContext {
  readonly mode: PiMode;
  readonly trust: PiTrustState;
  readonly commands: readonly PiCommandInfo[];
  readonly candidatePlan?: PiCandidatePlanContext;
  readonly hostSurface?: PiHostSurfaceReport;
}

const CANDIDATE_PLAN_CAPABILITIES: ReadonlySet<CapabilityId> = new Set([
  "config-materialization",
  "agent-materialization",
  "primary-agent-selection",
  "delegated-specialist-execution",
  "prompt-composition",
  "workflow-persistence",
  "workflow-step-dispatch",
  "plan-file-compatibility",
  "event-logging",
]);

/**
 * Evaluates the four candidate-plan-aware capabilities against real
 * materialization/primary-selection facts (Pi adapter contract). Never
 * raises a declared ceiling - only reports what actually happened.
 */
function evaluateCandidatePlanCapability(
  id: CapabilityId,
  plan: PiCandidatePlanContext,
): CapabilityProbeResult {
  if (id === "config-materialization") {
    return plan.configLoaded
      ? { capabilityId: id, probeStatus: "ok", details: "config-loaded" }
      : {
          capabilityId: id,
          probeStatus: "unavailable",
          details: "config-load-failed",
        };
  }
  if (id === "agent-materialization") {
    if (!plan.configLoaded) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "config-not-loaded",
      };
    }
    // `materializeAgents` never fails wholesale (Pi adapter contract): a failing
    // descriptor is isolated and reported in `plan.errors`, but unrelated
    // valid descriptors (Loom included) still materialize. A per-descriptor
    // error is therefore reported here as detail, never as a degradation of
    // this required, global capability (Pi adapter contract "partial descriptor
    // failures -> keep unrelated valid descriptors").
    return {
      capabilityId: id,
      probeStatus: "ok",
      details:
        plan.materializationErrorCount > 0
          ? `materialized (${plan.materializationErrorCount} isolated descriptor error(s))`
          : "materialized",
    };
  }
  if (id === "primary-agent-selection") {
    if (!plan.configLoaded) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "config-not-loaded",
      };
    }
    if (!plan.primaryDescriptorFound) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "no-eligible-primary",
      };
    }
    // An unresolved model intent degrades that descriptor's *model* health
    // (Pi adapter contract: retain the current authenticated Pi model, expose
    // descriptor model degradation) - it does not make the primary
    // unselectable. A valid, eligible primary remains selectable/usable
    // under model fallback, so this required capability stays `ok`.
    return {
      capabilityId: id,
      probeStatus: "ok",
      details: plan.primaryModelDryResolved
        ? "primary-selectable"
        : "primary-selectable-model-fallback",
    };
  }
  if (id === "delegated-specialist-execution") {
    if (!plan.configLoaded || !plan.primaryDescriptorFound) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "no-delegation-primary",
      };
    }
    if (plan.delegationToolPlanned !== true) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "delegation-tool-not-planned",
      };
    }
    return {
      capabilityId: id,
      probeStatus: "ok",
      details: "authenticated-delegation-tool-planned",
    };
  }
  if (id === "prompt-composition") {
    if (!plan.configLoaded || !plan.primaryDescriptorFound) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "no-composed-prompt-available",
      };
    }
    return {
      capabilityId: id,
      probeStatus: "ok",
      details: "composed-prompt-available",
    };
  }
  if (id === "event-logging") {
    if (!plan.configLoaded) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "config-not-loaded",
      };
    }
    if (plan.eventLoggingPlanned !== true) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "event-log-prerequisites-unproven",
      };
    }
    return {
      capabilityId: id,
      probeStatus: "ok",
      details: "runtime-journal-and-log-sink-planned",
    };
  }
  // `workflow-persistence`/`workflow-step-dispatch`: `configLoaded` alone
  // only proves config parsed - it says nothing about whether the Runtime
  // Store's own directory is actually reachable. This capability is `ok`
  // only when config loaded *and* a real, read-only no-follow containment
  // proof of `.weave/runtime` succeeded (Pi adapter contract). It still never
  // opens the store itself - a real open/migration failure at
  // `session_start` degrades the *session's* workflow surface separately
  // (see `renderHealthMessage`'s runtime-store line) - but it no longer
  // claims readiness from `configLoaded` alone, and under withheld trust
  // (where `plan` is never constructed) this capability now correctly
  // falls through to the default `unavailable` branch instead of claiming
  // a narrow project-trust-withheld `ok`.
  if (id === "workflow-persistence" || id === "workflow-step-dispatch") {
    if (!plan.configLoaded) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "config-not-loaded",
      };
    }
    if (plan.runtimeDirectoryContained !== true) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "runtime-directory-containment-unproven",
      };
    }
    return {
      capabilityId: id,
      probeStatus: "ok",
      details: "runtime-store-and-dispatch-wiring-available",
    };
  }
  // plan-file-compatibility: `createPiPlanStateProvider` binds the
  // concrete `BunFilesystemPlanStateProvider` (Pi adapter contract), but that is
  // only a real, provable structural fact once `.weave/plans` itself has
  // also passed the same real containment proof - `configLoaded` alone is
  // not concrete evidence (Pi adapter contract).
  if (!plan.configLoaded) {
    return {
      capabilityId: id,
      probeStatus: "unavailable",
      details: "config-not-loaded",
    };
  }
  if (plan.plansDirectoryContained !== true) {
    return {
      capabilityId: id,
      probeStatus: "unavailable",
      details: "plans-directory-containment-unproven",
    };
  }
  return {
    capabilityId: id,
    probeStatus: "ok",
    details: "plan-state-provider-available",
  };
}

/** Adapter-owned seam so tests can substitute a fully-controlled probe set (Pi adapter contract). */
export interface PiCapabilityProbeSource {
  probe(context: PiPreflightContext): readonly CapabilityProbeResult[];
}

export const WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE_ENV =
  "WEAVE_PI_UNSAFE_DISABLE_COMMAND_PROVENANCE";

export interface DefaultPiCapabilityProberOptions {
  readonly enforceCommandProvenance?: boolean;
}

/**
 * Returns exactly one `unavailable` probe for every capability ID, with a
 * shared reason. Used when mode or host identity/version blocks preflight
 * before any other probe can safely run (Pi adapter contract).
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
 * Verifies exclusive ownership of every required `/weave:*` command (Pi adapter contract
 *): each name must have exactly one unsuffixed invocation whose
 * `sourceInfo` proves it is ours, and no same-base numeric-suffixed entry
 * may exist at all (a suffix means some registration collided on this name,
 * even if we kept the bare slot).
 */
function evaluateCommandEntrypoints(
  commands: readonly PiCommandInfo[],
  enforceCommandProvenance: boolean,
): CapabilityProbeResult {
  const problems: string[] = [];
  for (const name of WEAVE_COMMAND_NAMES) {
    const owned = commands.find(
      (command) =>
        command.name === name &&
        (!enforceCommandProvenance || isOwnSourceInfo(command.sourceInfo)),
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
    details: enforceCommandProvenance
      ? "all-twelve-commands-exclusively-owned"
      : "all-twelve-commands-present-local-provenance-disabled",
  };
}

/**
 * Production capability prober. Native host facts come from the command and
 * usage surfaces; adapter-emulated facts come from the sealed candidate plan.
 * Capabilities without a concrete, read-only proof remain unavailable. This
 * never raises a declared ceiling - it only preserves or lowers it, matching
 * `lowerReadinessByProbe`.
 */
export class DefaultPiCapabilityProber implements PiCapabilityProbeSource {
  private readonly enforceCommandProvenance: boolean;

  constructor(options: DefaultPiCapabilityProberOptions = {}) {
    this.enforceCommandProvenance = options.enforceCommandProvenance ?? true;
  }

  probe(context: PiPreflightContext): readonly CapabilityProbeResult[] {
    return ALL_CAPABILITY_IDS.map((id) => this.probeOne(id, context));
  }

  private probeOne(
    id: CapabilityId,
    context: PiPreflightContext,
  ): CapabilityProbeResult {
    if (
      context.hostSurface !== undefined &&
      context.hostSurface.requiredGaps.length > 0 &&
      id === "delegated-specialist-execution"
    ) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: `host-surface-gap:${context.hostSurface.requiredGaps.join(",")}`,
      };
    }
    if (id === "command-entrypoints") {
      return evaluateCommandEntrypoints(
        context.commands,
        this.enforceCommandProvenance,
      );
    }
    if (id === "token-usage-reporting") {
      return {
        capabilityId: id,
        probeStatus: "ok",
        details: "native-per-message-usage-fields",
      };
    }
    if (id === "tool-policy-mapping") {
      return {
        capabilityId: id,
        probeStatus: "ok",
        details: "pi-native-tool-control",
      };
    }
    if (
      context.candidatePlan !== undefined &&
      CANDIDATE_PLAN_CAPABILITIES.has(id)
    ) {
      return evaluateCandidatePlanCapability(id, context.candidatePlan);
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

/** Bound on a sanitized probe `details` string (Pi adapter contract: no raw payloads in diagnostics). */
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
 * prober into exactly one sanitized `CapabilityProbeResult` per
 * canonical capability ID (Pi adapter contract). A missing, duplicate,
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
