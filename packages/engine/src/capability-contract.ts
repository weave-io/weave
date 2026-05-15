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
 * See: docs/specs/07-spec-adapter-capability-contract/07-spec-adapter-capability-contract.md
 * See: docs/adapter-boundary.md
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
 * Stable identifiers for all 19 capabilities defined in the Core Readiness
 * Profile (12 required + 7 optional).
 *
 * Required capabilities (12):
 *   config-materialization, agent-materialization, primary-agent-selection,
 *   delegated-specialist-execution, prompt-composition, tool-policy-mapping,
 *   workflow-persistence, workflow-step-dispatch, plan-file-compatibility,
 *   command-entrypoints, event-logging, token-usage-reporting
 *
 * Optional capabilities (7):
 *   idle-continuation, compaction-recovery, context-window-monitor,
 *   analytics-dashboard, eval-integration, static-artifact-generation,
 *   multiple-active-workflows
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
  // Optional
  | "idle-continuation"
  | "compaction-recovery"
  | "context-window-monitor"
  | "analytics-dashboard"
  | "eval-integration"
  | "static-artifact-generation"
  | "multiple-active-workflows";

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
  // Optional
  "idle-continuation",
  "compaction-recovery",
  "context-window-monitor",
  "analytics-dashboard",
  "eval-integration",
  "static-artifact-generation",
  "multiple-active-workflows",
]);

// ---------------------------------------------------------------------------
// § 1.2 — Capability Entry
// ---------------------------------------------------------------------------

/**
 * A single capability declaration supplied by an adapter.
 *
 * Tool-policy capability (`tool-policy-mapping`) describes how the adapter
 * maps Weave's `ToolPolicy` (from `@weave/core`) into harness-specific
 * permission models. The `ToolPolicy` type itself is not duplicated here —
 * adapters reference `@weave/core` for the allow/deny/ask enum values.
 *
 * @see {@link ToolPolicySchema} in `@weave/core` for the referenced type.
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
 * The 12 required capability IDs for the Core Readiness Profile.
 *
 * `token-usage-reporting` is conditionally required: it is treated as required
 * only when the adapter declares that the harness exposes usage data. When the
 * adapter explicitly marks it `unsupported` with a documented reason, the
 * evaluator downgrades it to a warning. See `evaluateCoreReadinessProfile`.
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
] as const;

/**
 * The 7 optional capability IDs for the Core Readiness Profile.
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
] as const;

/** All 19 capability IDs in profile order (required then optional). */
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
  /** Static capability contract as declared by the adapter. */
  capabilityContract: AdapterCapabilityContract;
  /** Runtime probe results supplied by the adapter. */
  probeResults: CapabilityProbeResult[];
  /** Core Readiness Profile evaluation result. */
  profileResult: ProfileEvaluationResult;
}

/**
 * Build an `AdapterHealthReport` from adapter-supplied inputs.
 *
 * This function is pure: it calls `evaluateCoreReadinessProfile` internally
 * and stamps the current timestamp. It does not perform harness I/O, scan
 * directories, register hooks, or mutate harness state.
 *
 * @param input - Read-only adapter-supplied declarations and probe results.
 * @returns A complete health report ready for CLI rendering or JSON output.
 */
export function buildAdapterHealthReport(
  input: SafeAdapterInitInput,
): AdapterHealthReport {
  const profileResult = evaluateCoreReadinessProfile(input.capabilityContract);
  return {
    harness: input.harness,
    timestamp: new Date().toISOString(),
    capabilityContract: input.capabilityContract,
    probeResults: input.probeResults,
    profileResult,
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
