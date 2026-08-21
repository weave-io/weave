import type {
  CapabilityId,
  CapabilityProbeResult,
} from "@weaveio/weave-engine";
import { ALL_CAPABILITY_IDS } from "@weaveio/weave-engine";
import { Result } from "neverthrow";
import { z } from "zod";
import type { PiChildSessionReadinessReason } from "./child-session-storage-authority.js";
import { isOwnSourceInfo, WEAVE_COMMAND_NAMES } from "./commands.js";
import {
  PI_HOST_SURFACE_IDS,
  type PiHostSurfaceId,
} from "./host-compatibility-matrix.js";
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

/**
 * This generation's real spawn-authority verdict, produced by the single
 * generation-scoped session authority every launch path consumes (Spec 33
 * §5.6). Probing reads the same object the launch paths hold, so readiness
 * and launch can no longer disagree.
 */
export type PiDelegationAuthorityReadiness =
  | { readonly status: "ready" }
  | {
      readonly status: "unavailable";
      readonly reason: PiDelegationReadinessReason;
    };

/** Input a capability prober needs; assembled after mode/host/trust are known. */
export interface PiPreflightContext {
  readonly mode: PiMode;
  readonly trust: PiTrustState;
  readonly commands: readonly PiCommandInfo[];
  readonly candidatePlan?: PiCandidatePlanContext;
  readonly hostSurface?: PiHostSurfaceReport;
  /**
   * This generation's spawn-authority verdict. An absent verdict is treated
   * as unavailable, never as "assume ready": `delegated-specialist-execution`
   * must never claim readiness a spawn would refuse.
   */
  readonly delegationAuthority?: PiDelegationAuthorityReadiness;
}

/**
 * Required host surfaces that carry Pi's native session API. A gap in any of
 * them means the adapter cannot mint or reopen a child session.
 */
const SESSION_HOST_SURFACES: ReadonlySet<PiHostSurfaceId> = new Set([
  "session-restore",
  "rpc-persistent-session",
  "rpc-append-entry",
  "rpc-session-tree-read",
  "custom-session-directory",
]);

/** Bounded probe detail when the host advertises the post-recovery hook. */
export const AGENT_RECOVERY_EXHAUSTED_PRESENT =
  "agent-recovery-exhausted-present" as const;
/** Bounded probe detail when the host does not advertise the hook. */
export const AGENT_RECOVERY_EXHAUSTED_UNSUPPORTED =
  "agent-recovery-exhausted-unsupported" as const;

const AGENT_RECOVERY_EXHAUSTED_KEY = "agent_recovery_exhausted";

const PI_FEATURE_PROBE_OBJECT_SCHEMA = z.custom<object>((value) =>
  Result.fromThrowable(
    () =>
      value !== null &&
      Object(value) === value &&
      !Array.isArray(value) &&
      !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);
const PI_FEATURE_PROBE_INPUT_SCHEMA = z.union([
  PI_FEATURE_PROBE_OBJECT_SCHEMA,
  z.string(),
  z.number(),
  z.boolean(),
  z.bigint(),
  z.symbol(),
  z.null(),
  z.undefined(),
]);
type PiFeatureProbeInput = z.input<typeof PI_FEATURE_PROBE_INPUT_SCHEMA>;
type PiFeatureProbeObject = z.output<typeof PI_FEATURE_PROBE_OBJECT_SCHEMA>;

export type AgentRecoveryExhaustedProbeError = {
  readonly type: "FeatureProbeThrew";
};

/**
 * True only when `pi.features.agent_recovery_exhausted` is an own enumerable
 * data property equal to `true`. Never compares VERSION or any other string.
 * Throwing accessors, proxies, absence, and non-true values are unsupported.
 */
export function probeAgentRecoveryExhaustedFeature(
  host: PiFeatureProbeInput,
): Result<boolean, AgentRecoveryExhaustedProbeError> {
  return Result.fromThrowable(
    (): boolean => {
      const parsedHost = PI_FEATURE_PROBE_OBJECT_SCHEMA.safeParse(host);
      return parsedHost.success
        ? readAgentRecoveryExhaustedFlag(parsedHost.data)
        : false;
    },
    (): AgentRecoveryExhaustedProbeError => ({ type: "FeatureProbeThrew" }),
  )();
}

function readAgentRecoveryExhaustedFlag(host: PiFeatureProbeObject): boolean {
  const featuresDescriptor = Object.getOwnPropertyDescriptor(host, "features");
  if (featuresDescriptor === undefined || !("value" in featuresDescriptor))
    return false;
  const parsedFeatures = PI_FEATURE_PROBE_OBJECT_SCHEMA.safeParse(
    featuresDescriptor.value,
  );
  if (!parsedFeatures.success) return false;
  const flagDescriptor = Object.getOwnPropertyDescriptor(
    parsedFeatures.data,
    AGENT_RECOVERY_EXHAUSTED_KEY,
  );
  if (flagDescriptor === undefined || !("value" in flagDescriptor))
    return false;
  if (flagDescriptor.enumerable !== true) return false;
  return flagDescriptor.value === true;
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

/**
 * The closed, path-free set of reasons delegation readiness may report
 * (Spec 33 path-session design §5.6). Raw host messages, causes, paths, and
 * method names never reach an operator surface, so every host-surface gap is
 * mapped onto exactly one of these constants.
 */
export type PiDelegationReadinessReason = PiChildSessionReadinessReason;

/**
 * Which closed reason each required host surface maps to. Total over
 * `PiHostSurfaceId`: a surface that is not about session storage is a
 * process/protocol surface, so its gap means the child process surface is
 * unusable.
 */
const HOST_SURFACE_READINESS_REASONS: ReadonlyMap<
  PiHostSurfaceId,
  PiDelegationReadinessReason
> = new Map(
  PI_HOST_SURFACE_IDS.map((surfaceId) => [
    surfaceId,
    SESSION_HOST_SURFACES.has(surfaceId)
      ? ("pi-session-api-unavailable" as const)
      : ("pi-process-unavailable" as const),
  ]),
);

/**
 * Reduces every required host-surface gap to one closed readiness reason.
 * Session-API gaps outrank process gaps because a host that cannot mint a
 * session cannot run a durable child at all.
 */
export function describeDelegationReadinessGap(
  requiredGaps: readonly PiHostSurfaceId[],
): PiDelegationReadinessReason {
  for (const surfaceId of PI_HOST_SURFACE_IDS) {
    if (!requiredGaps.includes(surfaceId)) continue;
    const reason = HOST_SURFACE_READINESS_REASONS.get(surfaceId);
    if (reason === "pi-session-api-unavailable") return reason;
  }
  return "pi-process-unavailable";
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
      ? "all-commands-exclusively-owned"
      : "all-commands-present-local-provenance-disabled",
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
    // Only `required-for-delegation` surface gaps block delegation and enter
    // health-only mode (Spec 33 §16). An `overlay-only` gap never reaches
    // `requiredGaps`; it is reported through the host surface report's
    // `overlayFallbackGaps` and selects the existing custom-editor child
    // inspection fallback instead. A `feature-only` gap is likewise absent
    // from engine capability IDs: hook readiness stays on the host-surface
    // report and never lowers an engine probe.
    if (
      context.hostSurface !== undefined &&
      context.hostSurface.requiredGaps.length > 0 &&
      id === "delegated-specialist-execution"
    ) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: describeDelegationReadinessGap(
          context.hostSurface.requiredGaps,
        ),
      };
    }
    // The spawn authority is a real, generation-scoped fact, so a generation
    // whose session API, session root, or process surface is missing reports
    // delegation as unavailable even when the candidate plan is perfect.
    //
    // An *absent* verdict is treated the same way. "No authority was wired"
    // must never read as "assume a spawn would work": readiness has to imply
    // that a usable spawn authority exists. The one exception is withheld
    // project trust, whose narrow documented `ok` means only that
    // project-path access was correctly withheld and which already forces
    // health-only mode, so it can never promote the adapter to ready.
    if (
      id === "delegated-specialist-execution" &&
      context.delegationAuthority?.status !== "ready" &&
      !(
        context.trust === "withheld" &&
        PROJECT_PATH_DEPENDENT_CAPABILITIES.includes(id)
      )
    ) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details:
          context.delegationAuthority?.reason ?? "pi-session-api-unavailable",
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

const KNOWN_CAPABILITY_IDS: ReadonlySet<string> = new Set(ALL_CAPABILITY_IDS);

/** Bound on a sanitized probe `details` string (Pi adapter contract: no raw payloads in diagnostics). */
const MAX_SAFE_DETAILS_LENGTH = 200;
/** Printable ASCII only — matches the plain-punctuation, no-secrets diagnostics contract. */
const SAFE_DETAILS_PATTERN = /^[\x20-\x7E]*$/;

interface ParsedProbeStringField {
  readonly kind: "valid" | "invalid";
  readonly value?: string;
}

const PROBE_STRING_FIELD_SCHEMA = z
  .unknown()
  .transform((value): ParsedProbeStringField => {
    const parsed = z.string().safeParse(value);
    return parsed.success
      ? { kind: "valid", value: parsed.data }
      : { kind: "invalid" };
  });
const SAFE_DETAILS_FIELD_SCHEMA = z
  .unknown()
  .transform((value): ParsedProbeStringField => {
    const parsed = z
      .string()
      .max(MAX_SAFE_DETAILS_LENGTH)
      .regex(SAFE_DETAILS_PATTERN)
      .safeParse(value);
    return parsed.success
      ? { kind: "valid", value: parsed.data }
      : { kind: "invalid" };
  });
interface ParsedRawProbeCandidate {
  readonly capabilityId?: ParsedProbeStringField;
  readonly probeStatus?: ParsedProbeStringField;
  readonly details?: ParsedProbeStringField;
}

interface MutableParsedRawProbeCandidate {
  capabilityId?: ParsedProbeStringField;
  probeStatus?: ParsedProbeStringField;
  details?: ParsedProbeStringField;
}

const PROBE_OBSERVED_VALUE_SCHEMA = z.unknown();
type ProbeObservedValue = z.input<typeof PROBE_OBSERVED_VALUE_SCHEMA>;
interface ProbeCandidateObject {
  readonly probeCandidateObjectMarker?: never;
}
const PROBE_CANDIDATE_OBJECT_SCHEMA = z.custom<ProbeCandidateObject>((value) =>
  Result.fromThrowable(
    () =>
      value !== null &&
      Object(value) === value &&
      !Array.isArray(value) &&
      !(value instanceof Function),
    (): boolean => false,
  )().unwrapOr(false),
);

type ProbeCandidateDataRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: ProbeObservedValue };

function readProbeCandidateData(
  candidate: ProbeCandidateObject,
  key: string,
): ProbeCandidateDataRead {
  const descriptor = Result.fromThrowable(
    () => Object.getOwnPropertyDescriptor(candidate, key),
    (): PropertyDescriptor | undefined => undefined,
  )();
  if (descriptor.isErr()) return { kind: "invalid" };
  if (descriptor.value === undefined) return { kind: "missing" };
  if (!("value" in descriptor.value) || descriptor.value.enumerable !== true) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: descriptor.value.value };
}

function parseProbeStringField(
  value: ProbeObservedValue,
): ParsedProbeStringField {
  const parsed = PROBE_STRING_FIELD_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : { kind: "invalid" };
}

function parseProbeDetailsField(
  value: ProbeObservedValue,
): ParsedProbeStringField {
  const parsed = SAFE_DETAILS_FIELD_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : { kind: "invalid" };
}

function parseProbeCandidate(
  candidate: ProbeObservedValue,
): ParsedRawProbeCandidate | undefined {
  const parsedCandidate = PROBE_CANDIDATE_OBJECT_SCHEMA.safeParse(candidate);
  if (!parsedCandidate.success) return undefined;
  const capabilityId = readProbeCandidateData(
    parsedCandidate.data,
    "capabilityId",
  );
  const probeStatus = readProbeCandidateData(
    parsedCandidate.data,
    "probeStatus",
  );
  const details = readProbeCandidateData(parsedCandidate.data, "details");
  const parsed: MutableParsedRawProbeCandidate = {};
  if (capabilityId.kind === "invalid") {
    parsed.capabilityId = { kind: "invalid" };
  } else if (capabilityId.kind === "value") {
    parsed.capabilityId = parseProbeStringField(capabilityId.value);
  }
  if (probeStatus.kind === "invalid") {
    parsed.probeStatus = { kind: "invalid" };
  } else if (probeStatus.kind === "value") {
    parsed.probeStatus = parseProbeStringField(probeStatus.value);
  }
  if (details.kind === "invalid") {
    parsed.details = { kind: "invalid" };
  } else if (details.kind === "value") {
    parsed.details = parseProbeDetailsField(details.value);
  }
  return parsed;
}

function parseProbeStatus(
  value: string,
): CapabilityProbeResult["probeStatus"] | undefined {
  if (value === "ok") return "ok";
  if (value === "degraded") return "degraded";
  if (value === "unavailable") return "unavailable";
  return undefined;
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
  const byId = new Map<string, ParsedRawProbeCandidate[]>();
  for (const candidate of raw) {
    const parsedCandidate = parseProbeCandidate(candidate);
    if (parsedCandidate === undefined) continue;
    const candidateId = parsedCandidate.capabilityId;
    if (candidateId?.kind !== "valid" || candidateId.value === undefined)
      continue;
    if (!KNOWN_CAPABILITY_IDS.has(candidateId.value)) continue;
    const bucket = byId.get(candidateId.value) ?? [];
    bucket.push(parsedCandidate);
    byId.set(candidateId.value, bucket);
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
    const statusValue = single?.probeStatus;
    const status =
      statusValue?.kind === "valid" && statusValue.value !== undefined
        ? parseProbeStatus(statusValue.value)
        : undefined;
    if (status === undefined) {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-malformed-status",
      };
    }
    if (single?.details?.kind === "invalid") {
      return {
        capabilityId: id,
        probeStatus: "unavailable",
        details: "probe-unsafe-details",
      };
    }
    const sanitized: CapabilityProbeResult = {
      capabilityId: id,
      probeStatus: status,
    };
    const details = single?.details;
    if (details?.kind === "valid" && details.value !== undefined) {
      return { ...sanitized, details: details.value };
    }
    return sanitized;
  });
}
