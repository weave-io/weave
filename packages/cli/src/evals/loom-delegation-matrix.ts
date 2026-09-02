/**
 * Loom delegation-matrix eligibility resolver and coverage preflight.
 *
 * The set of agents Loom may delegate to is NOT a hardcoded list. It is
 * derived by composing the Loom agent through the engine's public
 * `composeAgentDescriptor()` API and reading `descriptor.delegationTargets`
 * — the same eligibility source the real harness uses at runtime. This
 * module never duplicates `buildDelegationTargets()` (an engine-internal
 * helper) and never hardcodes agent names such as `"shuttle"` or `"warp"`
 * in production logic.
 *
 * # Coverage preflight
 *
 * `loom-routing` eval case fixtures may declare two tags per case:
 *   - `target:<agentName>`   — which composed delegation target this case
 *                              exercises (independent of `expected_outcome`,
 *                              since a boundary case may deliberately expect
 *                              a *different* agent to prove `<agentName>`
 *                              should NOT be selected).
 *   - `polarity:positive`    — a case proving the target IS the correct
 *                              route for some task.
 *   - `polarity:boundary`    — a case proving the target should NOT be
 *                              selected for an adjacent/ambiguous task
 *                              (a negative/boundary case).
 *
 * `validateLoomDelegationMatrixCoverage()` fails closed:
 *   - Every currently composed delegation target must have at least one
 *     `polarity:positive` case and at least one `polarity:boundary` case.
 *   - Any case tagged for a target that is no longer in the composed set
 *     (i.e. the target was removed or renamed) is reported as an error —
 *     a removed target must not remain "authoritative" in the fixture set.
 *
 * This lets a composed-target addition or removal fail the eval preflight
 * (and the corresponding unit tests) before any model call is made, instead
 * of silently drifting.
 */

import type { ConfigLoadError } from "@weaveio/weave-config";
import { loadConfig } from "@weaveio/weave-config";
import type { WeaveConfig } from "@weaveio/weave-core";
import {
  type ComposeError,
  composeAgentDescriptor,
  type DelegationTarget,
} from "@weaveio/weave-engine";
import {
  err,
  errAsync,
  ok,
  okAsync,
  type Result,
  type ResultAsync,
} from "neverthrow";
import { loadSuiteCases } from "./case-loader.js";
import { LOOM_ROUTING_SUITE } from "./loom-routing-runner.js";
import type { EvalCase, FixtureSchemaError } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The agent name whose delegation targets this module resolves. */
export const LOOM_AGENT_NAME = "loom";

/** Tag marking a case as proving a target IS the correct route. */
export const DELEGATION_MATRIX_POSITIVE_TAG = "polarity:positive";

/** Tag marking a case as proving a target should NOT be selected. */
export const DELEGATION_MATRIX_BOUNDARY_TAG = "polarity:boundary";

/** Prefix for the tag identifying which composed target a case exercises. */
const DELEGATION_MATRIX_TARGET_TAG_PREFIX = "target:";

// ---------------------------------------------------------------------------
// Target resolution — DI seams for config loading and composition
// ---------------------------------------------------------------------------

/**
 * Injectable config loader signature. Production default calls
 * `loadConfig()` from `@weaveio/weave-config`. Tests inject a fixture-backed
 * loader to avoid real filesystem discovery.
 */
export type DelegationMatrixConfigLoader = () => ResultAsync<
  WeaveConfig,
  { message: string }[]
>;

/**
 * Injectable composer signature — matches `composeAgentDescriptor`'s shape.
 * Tests may inject a stub that returns a controlled `AgentDescriptor`.
 */
export type DelegationMatrixComposer = (
  agentName: string,
  agentConfig: WeaveConfig["agents"][string],
  config: WeaveConfig,
  allAgents: WeaveConfig["agents"],
) => ResultAsync<{ delegationTargets: DelegationTarget[] }, ComposeError>;

export interface ResolveLoomDelegationTargetsOptions {
  /** Config loader override. Defaults to the real `loadConfig()`. */
  configLoader?: DelegationMatrixConfigLoader;
  /** Composer override. Defaults to the real `composeAgentDescriptor`. */
  composer?: DelegationMatrixComposer;
}

export type LoomDelegationMatrixError =
  | {
      /** Config loading failed before composition could run. */
      type: "ConfigLoadFailed";
      message: string;
    }
  | {
      /** The `loom` agent is not present in the resolved config. */
      type: "LoomAgentNotFound";
      message: string;
    }
  | {
      /** `composeAgentDescriptor` failed for the `loom` agent. */
      type: "ComposeFailed";
      message: string;
    };

function defaultConfigLoader(): ResultAsync<
  WeaveConfig,
  { message: string }[]
> {
  return loadConfig().mapErr((errors) => errors.map(summarizeConfigLoadError));
}

/**
 * Build a bounded, safe `{ message }` summary from a `ConfigLoadError`.
 *
 * Never serializes the raw error object (`JSON.stringify(error)`), since
 * `FileReadError.cause` is `unknown` and may wrap a raw I/O `Error` (message,
 * stack trace, or platform-specific diagnostic text). Only known-safe
 * discriminant/count/path fields are surfaced — no raw `cause` or nested
 * parse-error detail is copied through.
 */
function summarizeConfigLoadError(error: ConfigLoadError): { message: string } {
  switch (error.type) {
    case "FileReadError":
      return {
        message: `FileReadError while reading config at "${error.path}"`,
      };
    case "ParseError":
      return {
        message: `ParseError in config at "${error.path}" (${error.errors.length} issue(s))`,
      };
    case "BuiltinParseError":
      return {
        message: `BuiltinParseError in the built-in DSL source (${error.errors.length} issue(s))`,
      };
    case "MergeError":
      return {
        message: `MergeError while merging config layers (${error.errors.length} issue(s))`,
      };
    default:
      return { message: "Unknown ConfigLoadError" };
  }
}

/**
 * Build a bounded, safe summary string from a `ComposeError`.
 *
 * `ComposeError` variants already carry a plain-string `message` field with
 * no raw config objects or file contents — safe to surface directly,
 * prefixed with the discriminant for context.
 */
function summarizeComposeError(error: ComposeError): string {
  return `${error.type}: ${error.message}`;
}

/**
 * Resolve the current, fully composed Loom delegation target set.
 *
 * Loads the merged Weave config, composes the `loom` agent through
 * `composeAgentDescriptor()`, and returns `descriptor.delegationTargets`
 * verbatim — the sole eligibility source. This function never hardcodes
 * agent names and never calls the engine-internal `buildDelegationTargets()`
 * helper directly.
 */
export function resolveLoomDelegationTargets(
  options: ResolveLoomDelegationTargetsOptions = {},
): ResultAsync<DelegationTarget[], LoomDelegationMatrixError> {
  const configLoader = options.configLoader ?? defaultConfigLoader;
  const composer = options.composer ?? composeAgentDescriptor;

  return configLoader()
    .mapErr(
      (errors): LoomDelegationMatrixError => ({
        type: "ConfigLoadFailed",
        message: `Failed to load Weave config for Loom delegation matrix resolution: ${errors
          .map((e) => e.message)
          .join("; ")}`,
      }),
    )
    .andThen((config) => {
      const loomAgentConfig = config.agents[LOOM_AGENT_NAME];
      if (loomAgentConfig === undefined) {
        return errAsync<DelegationTarget[], LoomDelegationMatrixError>({
          type: "LoomAgentNotFound",
          message: `Agent "${LOOM_AGENT_NAME}" was not found in the resolved Weave config's agent set.`,
        });
      }

      return composer(LOOM_AGENT_NAME, loomAgentConfig, config, config.agents)
        .mapErr(
          (composeErr): LoomDelegationMatrixError => ({
            type: "ComposeFailed",
            message: `composeAgentDescriptor failed for "${LOOM_AGENT_NAME}": ${summarizeComposeError(
              composeErr,
            )}`,
          }),
        )
        .map((descriptor) => descriptor.delegationTargets);
    });
}

// ---------------------------------------------------------------------------
// Coverage validation
// ---------------------------------------------------------------------------

export interface LoomDelegationMatrixCoverageIssue {
  type:
    | "MissingPositiveCase"
    | "MissingBoundaryCase"
    | "CaseTargetsRemovedAgent";
  target: string;
  caseId?: string;
  message: string;
}

function extractTargetTag(tags: readonly string[]): string | undefined {
  const found = tags.find((tag) =>
    tag.startsWith(DELEGATION_MATRIX_TARGET_TAG_PREFIX),
  );
  return found?.slice(DELEGATION_MATRIX_TARGET_TAG_PREFIX.length);
}

/**
 * Validate that the loaded `loom-routing` case fixtures cover every
 * currently composed Loom delegation target with at least one positive case
 * and one boundary/negative case, and that no fixture case still targets a
 * removed/renamed agent as authoritative.
 *
 * Fails closed: returns `err(issues)` with every violation found (not just
 * the first), so a single preflight run surfaces the full gap list.
 *
 * `composedTargetNames` must come from `resolveLoomDelegationTargets()` (or
 * an equivalent fully-composed source) — this function performs no
 * composition itself and does not hardcode any agent name.
 */
export function validateLoomDelegationMatrixCoverage(
  composedTargetNames: readonly string[],
  cases: readonly EvalCase[],
): Result<true, LoomDelegationMatrixCoverageIssue[]> {
  const issues: LoomDelegationMatrixCoverageIssue[] = [];
  const composedSet = new Set(composedTargetNames);

  for (const evalCase of cases) {
    const targetTag = extractTargetTag(evalCase.tags);
    if (targetTag === undefined) continue;
    if (!composedSet.has(targetTag)) {
      issues.push({
        type: "CaseTargetsRemovedAgent",
        target: targetTag,
        caseId: evalCase.id,
        message:
          `Case "${evalCase.id}" is tagged "target:${targetTag}", but "${targetTag}" is not in the ` +
          `currently composed Loom delegation target set (${[...composedSet].join(", ") || "(none)"}). ` +
          `Remove or retarget this case — a removed/renamed target must not remain authoritative.`,
      });
    }
  }

  for (const target of composedSet) {
    const targetCases = cases.filter(
      (evalCase) => extractTargetTag(evalCase.tags) === target,
    );
    const hasPositive = targetCases.some((evalCase) =>
      evalCase.tags.includes(DELEGATION_MATRIX_POSITIVE_TAG),
    );
    const hasBoundary = targetCases.some((evalCase) =>
      evalCase.tags.includes(DELEGATION_MATRIX_BOUNDARY_TAG),
    );

    if (!hasPositive) {
      issues.push({
        type: "MissingPositiveCase",
        target,
        message:
          `Composed Loom delegation target "${target}" has no case tagged ` +
          `"target:${target}" + "${DELEGATION_MATRIX_POSITIVE_TAG}". Add a positive routing case ` +
          `before this target can ship.`,
      });
    }
    if (!hasBoundary) {
      issues.push({
        type: "MissingBoundaryCase",
        target,
        message:
          `Composed Loom delegation target "${target}" has no case tagged ` +
          `"target:${target}" + "${DELEGATION_MATRIX_BOUNDARY_TAG}". Add a boundary/negative routing ` +
          `case before this target can ship.`,
      });
    }
  }

  if (issues.length > 0) return err(issues);
  return ok(true);
}

// ---------------------------------------------------------------------------
// Combined preflight — resolve targets, load cases, validate coverage
// ---------------------------------------------------------------------------

export type LoomDelegationMatrixCaseLoader = (
  evalsRoot?: string,
) => ResultAsync<EvalCase[], FixtureSchemaError>;

function defaultCaseLoader(
  evalsRoot?: string,
): ResultAsync<EvalCase[], FixtureSchemaError> {
  return evalsRoot !== undefined
    ? loadSuiteCases(LOOM_ROUTING_SUITE, evalsRoot)
    : loadSuiteCases(LOOM_ROUTING_SUITE);
}

export interface RunLoomDelegationMatrixPreflightOptions {
  configLoader?: DelegationMatrixConfigLoader;
  composer?: DelegationMatrixComposer;
  caseLoader?: LoomDelegationMatrixCaseLoader;
  evalsRoot?: string;
}

export type LoomDelegationMatrixPreflightError =
  | LoomDelegationMatrixError
  | {
      type: "CaseLoadFailed";
      message: string;
      cause: FixtureSchemaError;
    }
  | {
      type: "CoverageFailed";
      message: string;
      issues: LoomDelegationMatrixCoverageIssue[];
    };

/**
 * Run the full Loom delegation-matrix preflight: resolve the composed target
 * set, load the `loom-routing` case fixtures, and validate coverage.
 *
 * Returns `ok(DelegationTarget[])` when every composed target has both a
 * positive and a boundary/negative case, and no case still targets a
 * removed agent. Returns `err(...)` on any failure — composition failure,
 * case load failure, or coverage gaps — before any model call is made.
 */
export function runLoomDelegationMatrixPreflight(
  options: RunLoomDelegationMatrixPreflightOptions = {},
): ResultAsync<DelegationTarget[], LoomDelegationMatrixPreflightError> {
  const caseLoader = options.caseLoader ?? defaultCaseLoader;

  return resolveLoomDelegationTargets({
    configLoader: options.configLoader,
    composer: options.composer,
  }).andThen((targets) =>
    caseLoader(options.evalsRoot)
      .mapErr(
        (cause): LoomDelegationMatrixPreflightError => ({
          type: "CaseLoadFailed",
          message: `Failed to load loom-routing cases for delegation matrix preflight: ${cause.message}`,
          cause,
        }),
      )
      .andThen((cases) => {
        const coverage = validateLoomDelegationMatrixCoverage(
          targets.map((target) => target.name),
          cases,
        );

        if (coverage.isErr()) {
          return errAsync<
            DelegationTarget[],
            LoomDelegationMatrixPreflightError
          >({
            type: "CoverageFailed",
            message: `Loom delegation matrix coverage preflight failed with ${coverage.error.length} issue(s): ${coverage.error
              .map((issue) => issue.message)
              .join(" | ")}`,
            issues: coverage.error,
          });
        }

        return okAsync<DelegationTarget[], LoomDelegationMatrixPreflightError>(
          targets,
        );
      }),
  );
}
