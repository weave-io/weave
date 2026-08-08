/**
 * Adapter Capability Contract — shared engine module.
 *
 * Defines the harness-neutral vocabulary for adapter capability declarations,
 * readiness profile evaluation, runtime health reports, and renderer-ready
 * output structures.
 *
 * Engine helpers in this module are pure: they accept explicit adapter-supplied
 * inputs and return normalized results. They never scan harness directories,
 * query harness APIs, register concrete hooks, or mutate harness state.
 *
 * See: docs/reference/adapter-capabilities.md
 * See: docs/architecture/adapter-boundary.md
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// § 1 — Shared Capability Model
// ---------------------------------------------------------------------------

/**
 * The four readiness levels an adapter may declare for any capability.
 *
 * - `native`      — the harness implements the capability directly.
 * - `emulated`    — the adapter provides equivalent behavior via workarounds;
 *                   treated as satisfying required capabilities.
 * - `degraded`    — partial support only; behavior may be incomplete or
 *                   unreliable. Fails required capabilities.
 * - `unsupported` — the harness does not support this capability at all.
 *                   Fails required capabilities.
 */
export type CapabilityReadiness =
  | "native"
  | "emulated"
  | "degraded"
  | "unsupported";

export const CapabilityReadinessSchema = z.enum([
  "native",
  "emulated",
  "degraded",
  "unsupported",
]);

// ---------------------------------------------------------------------------
// § 1.1 — Capability IDs
// ---------------------------------------------------------------------------

/**
 * Stable identifiers for all 21 capabilities defined in the Core Readiness
 * Profile (13 required + 8 optional).
 *
 * Required capabilities (13):
 *   config-materialization, agent-materialization, primary-agent-selection,
 *   delegated-specialist-execution, prompt-composition, tool-policy-mapping,
 *   workflow-persistence, workflow-step-dispatch, plan-file-compatibility,
 *   command-entrypoints, event-logging, token-usage-reporting,
 *   descriptor-relative-native-session-io
 *
 * Optional capabilities (8):
 *   idle-continuation, compaction-recovery, context-window-monitor,
 *   analytics-dashboard, eval-integration, static-artifact-generation,
 *   multiple-active-workflows, model-thinking-activation
 *
 * ## Execution-entry capability model (execution lifecycle contract)
 *
 * `command-entrypoints` is the **canonical execution-entry capability**. It
 * models how an adapter exposes the explicit user-authorized trigger that
 * crosses the durable execution boundary (see ADR 0004). Adapters declare:
 *
 * - `native`      — the harness exposes literal commands (e.g. `/run-workflow`)
 *                   that the user invokes directly.
 * - `emulated`    — the harness lacks native commands but provides an
 *                   equivalent explicit delivery path (skill, script, UI
 *                   button, or helper) that the user must invoke deliberately.
 * - `degraded`    — an explicit start path exists but is incomplete or
 *                   inconsistent (e.g. only some workflows are reachable).
 * - `unsupported` — no reliable explicit start path exists in this harness.
 *
 * `workflow-step-dispatch` is **supporting execution context** — it models
 * the engine's ability to resolve and dispatch individual workflow steps once
 * execution has already started. It is NOT a second execution-entry
 * capability. Adapters must not treat `workflow-step-dispatch` readiness as
 * a substitute for `command-entrypoints` readiness when evaluating whether
 * the harness can initiate durable execution.
 *
 * See: docs/reference/execution-lifecycle.md
 * See: docs/adr/0004-workflow-first-execution-contract.md
 */
export type CapabilityId =
  // Required
  | "config-materialization"
  | "agent-materialization"
  | "primary-agent-selection"
  | "delegated-specialist-execution"
  | "prompt-composition"
  | "tool-policy-mapping"
  | "workflow-persistence"
  | "workflow-step-dispatch"
  | "plan-file-compatibility"
  | "command-entrypoints"
  | "event-logging"
  | "token-usage-reporting"
  | "descriptor-relative-native-session-io"
  // Optional
  | "idle-continuation"
  | "compaction-recovery"
  | "context-window-monitor"
  | "analytics-dashboard"
  | "eval-integration"
  | "static-artifact-generation"
  | "multiple-active-workflows"
  | "model-thinking-activation";

export const CapabilityIdSchema = z.enum([
  // Required
  "config-materialization",
  "agent-materialization",
  "primary-agent-selection",
  "delegated-specialist-execution",
  "prompt-composition",
  "tool-policy-mapping",
  "workflow-persistence",
  "workflow-step-dispatch",
  "plan-file-compatibility",
  "command-entrypoints",
  "event-logging",
  "token-usage-reporting",
  "descriptor-relative-native-session-io",
  // Optional
  "idle-continuation",
  "compaction-recovery",
  "context-window-monitor",
  "analytics-dashboard",
  "eval-integration",
  "static-artifact-generation",
  "multiple-active-workflows",
  "model-thinking-activation",
]);

// ---------------------------------------------------------------------------
// § 1.2 — Capability Entry
// ---------------------------------------------------------------------------

/**
 * A single capability declaration supplied by an adapter.
 *
 * Tool-policy capability (`tool-policy-mapping`) describes how the adapter
 * maps Weave's `ToolPolicy` (from `@weaveio/weave-core`) into harness-specific
 * permission models. The `ToolPolicy` type itself is not duplicated here —
 * adapters reference `@weaveio/weave-core` for the allow/deny/ask enum values.
 *
 * @see {@link ToolPolicySchema} in `@weaveio/weave-core` for the referenced type.
 */
export interface CapabilityEntry {
  /** Stable capability identifier. */
  id: CapabilityId;
  /** Human-readable display name for CLI output. */
  description: string;
  /** Adapter-declared readiness level. */
  readiness: CapabilityReadiness;
  /**
   * Adapter-supplied implementation notes explaining how the capability is
   * satisfied (for `native`/`emulated`) or why it is limited/absent.
   */
  notes?: string;
  /**
   * Current runtime status string, if the adapter can supply one.
   * Must be sanitized — no credentials, local paths, or secrets.
   */
  runtimeStatus?: string;
  /**
   * Description of the impact when this capability is missing or degraded.
   * Used in CLI output to explain what breaks.
   */
  blockingImpact?: string;
  /**
   * Identifier of the component that supplied this capability declaration.
   * Typically the adapter name (e.g. `"opencode"`, `"pi"`, `"claude-code"`).
   */
  supplier?: string;
  /**
   * Actionable remediation hint for CLI output when readiness is degraded or
   * unsupported. Must be sanitized — no credentials or local paths.
   */
  remediationHint?: string;
}

export const CapabilityEntrySchema = z.object({
  id: CapabilityIdSchema,
  description: z.string().min(1),
  readiness: CapabilityReadinessSchema,
  notes: z.string().optional(),
  runtimeStatus: z.string().optional(),
  blockingImpact: z.string().optional(),
  supplier: z.string().optional(),
  remediationHint: z.string().optional(),
});

// ---------------------------------------------------------------------------
// § 1.3 — Adapter Capability Contract
// ---------------------------------------------------------------------------

/**
 * The top-level contract an adapter declares to describe its capabilities.
 * Adapters construct this value from static knowledge and adapter-owned
 * runtime probes; the engine never constructs it on behalf of an adapter.
 */
export interface AdapterCapabilityContract {
  /** Ordered list of capability declarations. */
  capabilities: CapabilityEntry[];
}

export const AdapterCapabilityContractSchema = z.object({
  capabilities: z.array(CapabilityEntrySchema),
});

// ---------------------------------------------------------------------------
// § 2 — Core Readiness Profile
// ---------------------------------------------------------------------------

/**
 * The 13 required capability IDs for the Core Readiness Profile.
 *
 * `token-usage-reporting` is conditionally required: it is treated as required
 * only when the adapter declares that the harness exposes usage data. When the
 * adapter explicitly marks it `unsupported` with a documented reason, the
 * evaluator downgrades it to a warning. See `evaluateCoreReadinessProfile`.
 *
 * `descriptor-relative-native-session-io` is unconditionally required. It
 * models the harness contract that every native session read and write is
 * addressed by an opaque, harness-owned session descriptor rather than by a
 * caller-supplied filesystem path. Adapters that cannot prove this contract
 * must declare it `unsupported`, which forces health-only mode: no adapter
 * route may perform a persistent session mutation without it.
 */
export const REQUIRED_CAPABILITIES: readonly CapabilityId[] = [
  "config-materialization",
  "agent-materialization",
  "primary-agent-selection",
  "delegated-specialist-execution",
  "prompt-composition",
  "tool-policy-mapping",
  "workflow-persistence",
  "workflow-step-dispatch",
  "plan-file-compatibility",
  "command-entrypoints",
  "event-logging",
  "token-usage-reporting",
  "descriptor-relative-native-session-io",
] as const;

/**
 * The 8 optional capability IDs for the Core Readiness Profile.
 * Gaps in optional capabilities produce warnings, not failures.
 */
export const OPTIONAL_CAPABILITIES: readonly CapabilityId[] = [
  "idle-continuation",
  "compaction-recovery",
  "context-window-monitor",
  "analytics-dashboard",
  "eval-integration",
  "static-artifact-generation",
  "multiple-active-workflows",
  "model-thinking-activation",
] as const;

/** All 21 capability IDs in profile order (required then optional). */
export const ALL_CAPABILITY_IDS: readonly CapabilityId[] = [
  ...REQUIRED_CAPABILITIES,
  ...OPTIONAL_CAPABILITIES,
] as const;

// ---------------------------------------------------------------------------
// § 2.1 — Readiness Verdict and Outcome
// ---------------------------------------------------------------------------

/** Per-capability evaluation verdict. */
export type ReadinessVerdict = "pass" | "fail" | "warning";

/** Structured result for a single capability evaluation. */
export interface ReadinessOutcome {
  capabilityId: CapabilityId;
  verdict: ReadinessVerdict;
  readiness: CapabilityReadiness | "missing";
  reason: string;
}

/** Aggregate result of evaluating an adapter contract against the profile. */
export interface ProfileEvaluationResult {
  /** True only when all required capabilities pass. */
  ready: boolean;
  /** Required capabilities that failed (degraded, unsupported, or missing). */
  failures: ReadinessOutcome[];
  /** Optional capabilities that are degraded/unsupported/missing. */
  warnings: ReadinessOutcome[];
  /** Capabilities that passed (native or emulated). */
  passes: ReadinessOutcome[];
}

// ---------------------------------------------------------------------------
// § 2.2 — Core Readiness Profile Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate an adapter capability contract against the Core Readiness Profile.
 *
 * Rules:
 * - Required + `native` | `emulated`  → pass
 * - Required + `degraded` | `unsupported` → fail (unless token-usage special case)
 * - Required + missing → fail
 * - Optional + `native` | `emulated` → pass
 * - Optional + `degraded` | `unsupported` → warning
 * - Optional + missing → warning
 *
 * Token-usage special case:
 * - When `token-usage-reporting` is declared `unsupported` AND the entry
 *   carries a `notes` field explaining the harness does not expose usage data,
 *   the evaluator downgrades the failure to a warning instead of a hard fail.
 *   This models the "conditionally required" semantics from the spec.
 *
 * This function is pure and performs no harness I/O.
 */
export function evaluateCoreReadinessProfile(
  contract: AdapterCapabilityContract,
): ProfileEvaluationResult {
  const byId = new Map<CapabilityId, CapabilityEntry>(
    contract.capabilities.map((c) => [c.id, c]),
  );

  const failures: ReadinessOutcome[] = [];
  const warnings: ReadinessOutcome[] = [];
  const passes: ReadinessOutcome[] = [];

  for (const id of REQUIRED_CAPABILITIES) {
    const entry = byId.get(id);
    const outcome = evaluateRequired(id, entry);
    if (outcome.verdict === "pass") passes.push(outcome);
    else if (outcome.verdict === "warning") warnings.push(outcome);
    else failures.push(outcome);
  }

  for (const id of OPTIONAL_CAPABILITIES) {
    const entry = byId.get(id);
    const outcome = evaluateOptional(id, entry);
    if (outcome.verdict === "pass") passes.push(outcome);
    else warnings.push(outcome);
  }

  return {
    ready: failures.length === 0,
    failures,
    warnings,
    passes,
  };
}

function evaluateRequired(
  id: CapabilityId,
  entry: CapabilityEntry | undefined,
): ReadinessOutcome {
  if (entry === undefined) {
    return {
      capabilityId: id,
      verdict: "fail",
      readiness: "missing",
      reason: `Required capability '${id}' is not declared by the adapter.`,
    };
  }

  if (entry.readiness === "native" || entry.readiness === "emulated") {
    return {
      capabilityId: id,
      verdict: "pass",
      readiness: entry.readiness,
      reason: `Required capability '${id}' is satisfied (${entry.readiness}).`,
    };
  }

  // Special case: token-usage-reporting unsupported with documented reason
  // is downgraded to a warning (conditionally required semantics).
  if (
    id === "token-usage-reporting" &&
    entry.readiness === "unsupported" &&
    entry.notes !== undefined &&
    entry.notes.length > 0
  ) {
    return {
      capabilityId: id,
      verdict: "warning",
      readiness: entry.readiness,
      reason: `Token usage reporting is not applicable: ${entry.notes}`,
    };
  }

  return {
    capabilityId: id,
    verdict: "fail",
    readiness: entry.readiness,
    reason: `Required capability '${id}' has readiness '${entry.readiness}' which does not satisfy the Core Readiness Profile.`,
  };
}

function evaluateOptional(
  id: CapabilityId,
  entry: CapabilityEntry | undefined,
): ReadinessOutcome {
  if (entry === undefined) {
    return {
      capabilityId: id,
      verdict: "warning",
      readiness: "missing",
      reason: `Optional capability '${id}' is not declared by the adapter.`,
    };
  }

  if (entry.readiness === "native" || entry.readiness === "emulated") {
    return {
      capabilityId: id,
      verdict: "pass",
      readiness: entry.readiness,
      reason: `Optional capability '${id}' is available (${entry.readiness}).`,
    };
  }

  return {
    capabilityId: id,
    verdict: "warning",
    readiness: entry.readiness,
    reason: `Optional capability '${id}' has readiness '${entry.readiness}'; some features may be unavailable.`,
  };
}

// ---------------------------------------------------------------------------
// § 3 — Adapter Health Report and Safe Adapter Init
// ---------------------------------------------------------------------------

/**
 * Adapter-supplied runtime probe result for a single capability.
 *
 * Adapters perform harness-specific checks (file existence, process status,
 * API availability) and report results here. The engine never performs these
 * checks itself.
 *
 * Probe details must be sanitized — no credentials, API keys, local paths
 * beyond workspace-relative references, or harness config contents.
 */
export interface CapabilityProbeResult {
  capabilityId: CapabilityId;
  probeStatus: "ok" | "degraded" | "unavailable";
  /** Sanitized detail string. No credentials or secrets. */
  details?: string;
}

/**
 * Read-only input the adapter gathers before the engine builds a health report.
 *
 * Safe Adapter Init contract:
 * - MUST NOT materialize agents.
 * - MUST NOT register lifecycle hooks.
 * - MUST NOT launch workflows or workflow steps.
 * - MUST NOT mutate harness configuration or state.
 * - MUST NOT write generated config files.
 * - MUST NOT start harness runtimes or processes.
 * - MAY perform read-only harness environment checks (file existence, env vars,
 *   version queries) and report results as `CapabilityProbeResult` entries.
 */
export interface SafeAdapterInitInput {
  /** Logical harness name (e.g. `"opencode"`, `"pi"`, `"claude-code"`). */
  harness: string;
  /** Static capability declarations from the adapter. */
  capabilityContract: AdapterCapabilityContract;
  /** Runtime probe results from adapter-owned read-only checks. */
  probeResults: CapabilityProbeResult[];
}

/**
 * Combined runtime health report for an adapter.
 *
 * Produced by `buildAdapterHealthReport` from a `SafeAdapterInitInput`.
 * Contains the static contract, runtime probe results, and the evaluated
 * Core Readiness Profile result.
 *
 * Must not contain credentials, API keys, local secrets, or harness config
 * contents. Sanitize all `runtimeStatus` and `details` fields before
 * including them in proof artifacts or issue comments.
 */
export interface AdapterHealthReport {
  /** Logical harness name. */
  harness: string;
  /** ISO 8601 timestamp when the report was built. */
  timestamp: string;
  /** Static capability contract as declared by the adapter (ceiling). */
  capabilityContract: AdapterCapabilityContract;
  /** Runtime probe results supplied by the adapter. */
  probeResults: CapabilityProbeResult[];
  /** Core Readiness Profile evaluation against probe-lowered effective readiness. */
  profileResult: ProfileEvaluationResult;
  /** Exactly one effective entry per capability ID after probe lowering. */
  effectiveCapabilities: EffectiveCapabilityEntry[];
  /** True when required effective gaps force health-only mode. */
  healthOnlyMode: boolean;
}

// ---------------------------------------------------------------------------
// § 3.1 — Probe-lowered effective readiness (adapter capability contract extension / Pi adapter contract)
// ---------------------------------------------------------------------------

/**
 * How a probe was resolved for one capability ID during a generation.
 *
 * - `ok` / `degraded` / `unavailable` — single valid adapter probe status
 * - `missing` — no probe supplied for the ID
 * - `failed` — probe payload was unusable
 * - `duplicate` — more than one probe for the same ID
 * - `contradictory` — multiple probes disagreed on status
 */
export type EffectiveProbeResolution =
  | "ok"
  | "degraded"
  | "unavailable"
  | "missing"
  | "failed"
  | "duplicate"
  | "contradictory";

/**
 * One capability after probe lowering. Static declaration fields are preserved;
 * `effectiveReadiness` is the readiness used for profile evaluation.
 */
export interface EffectiveCapabilityEntry extends CapabilityEntry {
  /** Unchanged adapter-declared readiness (ceiling). */
  readonly declaredReadiness: CapabilityReadiness;
  /** Readiness after applying the generation probe. */
  readonly effectiveReadiness: CapabilityReadiness;
  /** How the probe for this ID was resolved. */
  readonly probeResolution: EffectiveProbeResolution;
  /** Sanitized probe detail, if any. */
  readonly probeDetails?: string;
}

/** Aggregate effective evaluation for one controller generation. */
export interface EffectiveCapabilityEvaluation {
  /** Static declarations preserved unchanged. */
  readonly declarations: AdapterCapabilityContract;
  /** Exactly one effective entry per known capability ID (19). */
  readonly effectiveCapabilities: EffectiveCapabilityEntry[];
  /** Profile evaluation against effective readiness. */
  readonly profileResult: ProfileEvaluationResult;
  /**
   * True when any required effective capability is `degraded` or `unsupported`
   * (health-only mode). Equivalent to `!profileResult.ready` for the core
   * profile after probe lowering.
   */
  readonly healthOnlyMode: boolean;
}

/**
 * Lower a declared readiness ceiling by one sanitized probe outcome.
 * Probes never raise readiness.
 */
export function lowerReadinessByProbe(
  declared: CapabilityReadiness,
  resolution: EffectiveProbeResolution,
): CapabilityReadiness {
  if (resolution === "ok") return declared;
  if (resolution === "degraded") {
    if (declared === "unsupported") return "unsupported";
    return "degraded";
  }
  // unavailable | missing | failed | duplicate | contradictory
  return "unsupported";
}

function resolveProbeForId(
  id: CapabilityId,
  probes: readonly CapabilityProbeResult[],
): {
  resolution: EffectiveProbeResolution;
  details?: string;
} {
  const matches = probes.filter((probe) => probe.capabilityId === id);
  if (matches.length === 0) return { resolution: "missing" };
  if (matches.length > 1) {
    const statuses = new Set(matches.map((probe) => probe.probeStatus));
    if (statuses.size > 1) {
      return {
        resolution: "contradictory",
        details: "multiple probes disagreed on status",
      };
    }
    return {
      resolution: "duplicate",
      details: "multiple probes supplied for the same capability",
    };
  }

  const probe = matches[0];
  if (probe === undefined) return { resolution: "missing" };

  if (
    probe.probeStatus !== "ok" &&
    probe.probeStatus !== "degraded" &&
    probe.probeStatus !== "unavailable"
  ) {
    return { resolution: "failed", details: probe.details };
  }

  return { resolution: probe.probeStatus, details: probe.details };
}

/**
 * Evaluate static declarations through exactly one probe per capability ID.
 *
 * Effective-readiness rules for the Pi adapter capability contract:
 * - Static declaration is a ceiling
 * - `ok` preserves declaration
 * - `degraded` lowers to degraded (without raising unsupported)
 * - `unavailable` / missing / failed / duplicate / contradictory → unsupported
 * - Required effective degraded/unsupported → health-only mode
 * - Optional gaps remain warnings
 * - Static declarations are preserved on the result
 *
 * This function is pure and performs no harness I/O.
 */
export function evaluateEffectiveCapabilities(
  contract: AdapterCapabilityContract,
  probeResults: readonly CapabilityProbeResult[],
): EffectiveCapabilityEvaluation {
  const byId = new Map<CapabilityId, CapabilityEntry>(
    contract.capabilities.map((entry) => [entry.id, entry]),
  );

  const effectiveCapabilities: EffectiveCapabilityEntry[] = [];

  for (const id of ALL_CAPABILITY_IDS) {
    const declaredEntry = byId.get(id);
    const declaredReadiness: CapabilityReadiness =
      declaredEntry?.readiness ?? "unsupported";
    const resolved = resolveProbeForId(id, probeResults);
    const effectiveReadiness = lowerReadinessByProbe(
      declaredReadiness,
      resolved.resolution,
    );

    const base: CapabilityEntry = declaredEntry ?? {
      id,
      description: id,
      readiness: "unsupported",
    };

    effectiveCapabilities.push({
      ...base,
      // Profile evaluation consumes `readiness` as the effective level.
      readiness: effectiveReadiness,
      declaredReadiness,
      effectiveReadiness,
      probeResolution: resolved.resolution,
      ...(resolved.details !== undefined
        ? { probeDetails: resolved.details }
        : {}),
      ...(resolved.details !== undefined
        ? { runtimeStatus: resolved.details }
        : {}),
    });
  }

  const effectiveContract: AdapterCapabilityContract = {
    capabilities: effectiveCapabilities,
  };
  const profileResult = evaluateCoreReadinessProfile(effectiveContract);

  return {
    declarations: contract,
    effectiveCapabilities,
    profileResult,
    healthOnlyMode: !profileResult.ready,
  };
}

/**
 * Build an `AdapterHealthReport` from adapter-supplied inputs.
 *
 * This function is pure: it applies probe-lowered effective readiness, then
 * evaluates the Core Readiness Profile against effective levels while
 * preserving static declarations on the report. It does not perform harness
 * I/O, scan directories, register hooks, or mutate harness state.
 *
 * @param input - Read-only adapter-supplied declarations and probe results.
 * @returns A complete health report ready for CLI rendering or JSON output.
 */
export function buildAdapterHealthReport(
  input: SafeAdapterInitInput,
): AdapterHealthReport {
  const effective = evaluateEffectiveCapabilities(
    input.capabilityContract,
    input.probeResults,
  );
  return {
    harness: input.harness,
    timestamp: new Date().toISOString(),
    capabilityContract: input.capabilityContract,
    probeResults: input.probeResults,
    profileResult: effective.profileResult,
    effectiveCapabilities: effective.effectiveCapabilities,
    healthOnlyMode: effective.healthOnlyMode,
  };
}

// ---------------------------------------------------------------------------
// § 4 — Renderer-Ready Structures
// ---------------------------------------------------------------------------

/**
 * Human-readable row for CLI table output.
 * Deterministic order: required capabilities first, then optional,
 * alphabetical within each group.
 */
export interface HumanReadinessRow {
  /** Capability display name or ID. */
  capability: string;
  /** Evaluation verdict as a display status. */
  status: "PASS" | "FAIL" | "WARN";
  /** Adapter-declared readiness level (or "missing"). */
  readiness: CapabilityReadiness | "missing";
  /** Combined notes/blocking impact/remediation for display. */
  notes: string;
}

/**
 * Compact deterministic row for LLM-oriented (TOON) output.
 * Keys are intentionally short for token efficiency.
 */
export interface ToonReadinessRow {
  /** Capability ID. */
  id: string;
  /** Verdict: P=pass, F=fail, W=warn. */
  v: "P" | "F" | "W";
  /** Readiness level (or "missing"). */
  r: string;
}

/**
 * Build human-readable rows from a health report.
 *
 * Order: required capabilities first (in profile order), then optional
 * capabilities (in profile order). Within each group, order follows
 * `REQUIRED_CAPABILITIES` / `OPTIONAL_CAPABILITIES` array order.
 *
 * This function is pure and does not re-run adapter probes.
 */
export function buildHumanRows(
  report: AdapterHealthReport,
): HumanReadinessRow[] {
  const allOutcomes = [
    ...report.profileResult.passes,
    ...report.profileResult.failures,
    ...report.profileResult.warnings,
  ];

  const byId = new Map<CapabilityId, ReadinessOutcome>(
    allOutcomes.map((o) => [o.capabilityId, o]),
  );

  const capById = new Map<CapabilityId, CapabilityEntry>(
    report.capabilityContract.capabilities.map((c) => [c.id, c]),
  );

  const rows: HumanReadinessRow[] = [];

  for (const id of ALL_CAPABILITY_IDS) {
    const outcome = byId.get(id);
    const entry = capById.get(id);

    if (outcome === undefined) continue;

    const status = verdictToStatus(outcome.verdict);
    const notes = buildNotes(entry, outcome);

    rows.push({
      capability: entry?.description ?? id,
      status,
      readiness: outcome.readiness,
      notes,
    });
  }

  return rows;
}

/**
 * Build compact TOON rows from a health report.
 *
 * Same deterministic order as `buildHumanRows`. Stable across repeated calls
 * with the same input.
 */
export function buildToonRows(report: AdapterHealthReport): ToonReadinessRow[] {
  const allOutcomes = [
    ...report.profileResult.passes,
    ...report.profileResult.failures,
    ...report.profileResult.warnings,
  ];

  const byId = new Map<CapabilityId, ReadinessOutcome>(
    allOutcomes.map((o) => [o.capabilityId, o]),
  );

  const rows: ToonReadinessRow[] = [];

  for (const id of ALL_CAPABILITY_IDS) {
    const outcome = byId.get(id);
    if (outcome === undefined) continue;

    rows.push({
      id,
      v: verdictToToon(outcome.verdict),
      r: outcome.readiness,
    });
  }

  return rows;
}

/**
 * Serialize an `AdapterHealthReport` to a formatted JSON string.
 *
 * JSON is the machine-readable interchange format. Sanitize the report before
 * sharing in issue comments or proof artifacts.
 */
export function toJson(report: AdapterHealthReport): string {
  return JSON.stringify(report, null, 2);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function verdictToStatus(verdict: ReadinessVerdict): "PASS" | "FAIL" | "WARN" {
  if (verdict === "pass") return "PASS";
  if (verdict === "fail") return "FAIL";
  return "WARN";
}

function verdictToToon(verdict: ReadinessVerdict): "P" | "F" | "W" {
  if (verdict === "pass") return "P";
  if (verdict === "fail") return "F";
  return "W";
}

function buildNotes(
  entry: CapabilityEntry | undefined,
  outcome: ReadinessOutcome,
): string {
  const parts: string[] = [];

  if (entry?.blockingImpact !== undefined) parts.push(entry.blockingImpact);
  if (entry?.notes !== undefined) parts.push(entry.notes);
  if (entry?.remediationHint !== undefined) parts.push(entry.remediationHint);
  if (parts.length === 0) parts.push(outcome.reason);

  return parts.join(" | ");
}
