import type { AgentConfig, WeaveConfig } from "@weaveio/weave-core";
import { okAsync, ResultAsync } from "neverthrow";

import {
  type AgentDescriptor,
  type ComposeError,
  composeAgentDescriptor,
  defaultPromptFileReader,
  type PromptFileReader,
  type PromptFileReadFailure,
} from "./compose.js";
import {
  type CategoryShuttleConflictError,
  type GeneratedCategoryShuttle,
  generateCategoryShuttles,
} from "./descriptors.js";
import { logger } from "./logger.js";
import {
  type GeneratedReviewVariant,
  generateReviewVariants,
  type ReviewVariantConflictError,
} from "./review-variants.js";

/** Adapter-provided input for public agent materialization. */
export interface MaterializationInput {
  /** Fully resolved and validated Weave configuration. */
  config: WeaveConfig;
  /** Read each prompt path once per call, including shared failures. */
  promptFileReader?: PromptFileReader;
  /**
   * What the harness did with a previous materialization of this config:
   * which agents it holds and why it refused any others. When given, an
   * agent is offered as a delegation target only if the report lists it as
   * materialized (ADR 0013). When omitted, every agent that composes is a
   * candidate — all that is known before the harness has run.
   */
  harness?: HarnessMaterializationReport;
}

/**
 * Why an agent is not available to delegate to.
 *
 * - `composition_failed` — the engine could not compose its descriptor (for
 *   example its prompt template does not render). The engine detects this
 *   itself; adapters need not report it.
 * - `model_unresolved` — the harness could not resolve the agent's model and
 *   refused to register it.
 * - `translation_failed` — the adapter could not translate the descriptor
 *   into harness configuration.
 * - `name_taken` — the harness already holds an agent of that name that
 *   Weave does not own, so Weave's agent was not registered.
 * - `not_reported` — the adapter's report named the agent neither as
 *   materialized nor as failed.
 */
export type AgentUnavailableReason =
  | "composition_failed"
  | "model_unresolved"
  | "translation_failed"
  | "name_taken"
  | "not_reported";

/** One agent that is not available to delegate to, and why. */
export interface UnavailableAgent {
  readonly agentName: string;
  readonly reason: AgentUnavailableReason;
  /** Human-readable detail for logs and diagnostics. */
  readonly message?: string;
}

/**
 * The adapter's account of which agents the harness holds after it
 * registered a materialization plan. Harness knowledge, supplied as explicit
 * context (see `docs/adapter-boundary.md`).
 */
export interface HarnessMaterializationReport {
  /** Agents the harness holds under Weave's ownership. */
  readonly materialized: readonly string[];
  /** Agents the harness did not take, each with its reason. */
  readonly failed: readonly UnavailableAgent[];
}

/** A composed agent descriptor paired with its deterministic materialization key. */
export interface MaterializedAgent {
  /** Agent name from the resolved config or generated category shuttle name. */
  agentName: string;
  /** Adapter-facing descriptor with rendered prompt and normalized metadata. */
  descriptor: AgentDescriptor;
  /**
   * Origin discriminator — allows consumers to filter by how this agent was
   * introduced without relying on name-pattern matching.
   *
   * - `"explicit"` — declared directly in the config `agents {}` block.
   * - `"category-shuttle"` — generated from a `category {}` declaration.
   * - `"review-variant"` — generated from an agent's `review_models` list.
   */
  source: "explicit" | "category-shuttle" | "review-variant";
  /**
   * Present only when `source === "review-variant"`. Carries the originating
   * agent name and the review model for this variant.
   */
  reviewMeta?: { sourceAgentName: string; reviewModel: string };
}

/** Deterministically ordered adapter-facing materialization output. */
export interface MaterializationPlan {
  /** Ordered resolved agents, preserving config order followed by generated shuttles. */
  agents: MaterializedAgent[];
  /**
   * Per-agent failures collected during materialization. Values are accumulated
   * rather than returned as a top-level rejection — the ResultAsync only rejects
   * on a truly irrecoverable upstream failure (none currently exist).
   */
  errors: readonly MaterializationError[];
  /**
   * Agents left out of every delegation target list because they were not
   * materialized: those that failed to compose, plus those the harness
   * report says it does not hold. Each one is also logged.
   */
  unavailableAgents: readonly UnavailableAgent[];
}

/**
 * Public materialization failures exposed to adapters.
 *
 * These values are collected into `MaterializationPlan.errors[]` rather than
 * returned as a top-level ResultAsync rejection. Adapters should inspect
 * `plan.errors` after a successful `materializeAgents` call to detect partial
 * failures.
 */
export type MaterializationError =
  | {
      type: "CategoryShuttleConflict";
      conflict: CategoryShuttleConflictError;
    }
  | {
      type: "ReviewVariantConflict";
      conflict: ReviewVariantConflictError;
    }
  | {
      type: "DescriptorCompositionFailure";
      agentName: string;
      cause: ComposeError;
    };

const log = logger.child({ module: "materialization" });

/** One instance per materialization, so concurrent descriptors share reads. */
class MaterializationPromptReader implements PromptFileReader {
  private readonly reads = new Map<
    string,
    ResultAsync<string, PromptFileReadFailure>
  >();

  constructor(private readonly reader: PromptFileReader) {}

  read(path: string): ResultAsync<string, PromptFileReadFailure> {
    const cached = this.reads.get(path);
    if (cached !== undefined) return cached;
    const pending = this.reader.read(path);
    this.reads.set(path, pending);
    return pending;
  }
}

function filterDisabled(
  entries: [string, AgentConfig][],
  disabled: readonly string[],
): [string, AgentConfig][] {
  return entries.filter(([agentName]) => !disabled.includes(agentName));
}

/**
 * Compose all adapter-facing agent descriptors from a resolved Weave config.
 *
 * The plan order is deterministic: explicit agents keep resolved config order,
 * followed by generated category shuttle agents in category declaration order.
 * Disabled agents are filtered before iteration.
 *
 * Per-agent failures are accumulated into `plan.errors[]`. The ResultAsync
 * itself only rejects on a truly irrecoverable upstream failure — currently
 * none exist, so the returned promise always resolves to `ok`.
 */
export function materializeAgents(
  input: MaterializationInput,
): ResultAsync<MaterializationPlan, never> {
  const { config } = input;
  const disabled = config.disabled.agents;
  const promptFileReader = new MaterializationPromptReader(
    input.promptFileReader ?? defaultPromptFileReader,
  );

  const generatedShuttlesResult = generateCategoryShuttles(config);

  // CategoryShuttleConflict is a per-agent failure — collect it and continue
  // with an empty generated-shuttle set so explicit agents still materialise.
  const generatedShuttles: Record<string, GeneratedCategoryShuttle> =
    generatedShuttlesResult.isOk() ? generatedShuttlesResult.value : {};

  const conflictErrors: MaterializationError[] = generatedShuttlesResult.isErr()
    ? [
        {
          type: "CategoryShuttleConflict",
          conflict: generatedShuttlesResult.error,
        },
      ]
    : [];

  const generatedReviewVariantsResult = generateReviewVariants(config);

  const generatedReviewVariants: Record<string, GeneratedReviewVariant> =
    generatedReviewVariantsResult.isOk()
      ? generatedReviewVariantsResult.value
      : {};

  const reviewVariantErrors: MaterializationError[] =
    generatedReviewVariantsResult.isErr()
      ? [
          {
            type: "ReviewVariantConflict",
            conflict: generatedReviewVariantsResult.error,
          },
        ]
      : [];

  type EntrySource =
    | { source: "explicit" }
    | { source: "category-shuttle" }
    | {
        source: "review-variant";
        sourceAgentName: string;
        reviewModel: string;
      };

  const explicitEntries = filterDisabled(
    Object.entries(config.agents),
    disabled,
  ).map(([agentName, agentConfig]) => ({
    agentName,
    agentConfig,
    entrySource: { source: "explicit" } as EntrySource,
  }));

  const generatedEntries = filterDisabled(
    Object.entries(generatedShuttles).map(
      ([agentName, generated]) =>
        [agentName, generated.config] as [string, AgentConfig],
    ),
    disabled,
  ).map(([agentName, agentConfig]) => ({
    agentName,
    agentConfig,
    entrySource: { source: "category-shuttle" } as EntrySource,
  }));

  const reviewVariantEntries = Object.entries(generatedReviewVariants)
    .filter(([agentName]) => !disabled.includes(agentName))
    .map(([agentName, generated]) => ({
      agentName,
      agentConfig: generated.config,
      entrySource: {
        source: "review-variant",
        sourceAgentName: generated.sourceAgentName,
        reviewModel: generated.reviewModel,
      } as EntrySource,
    }));

  const allTypedEntries = [
    ...explicitEntries,
    ...generatedEntries,
    ...reviewVariantEntries,
  ];

  const allEntries: [string, AgentConfig][] = allTypedEntries.map(
    ({ agentName, agentConfig }) => [agentName, agentConfig],
  );

  const allAgents = Object.fromEntries(allEntries);

  // Build lightweight MaterializedAgent-shaped objects for review variants so
  // primary-mode agents can receive reviewRouting context during composition.
  // These are pre-built before the main composition loop (review variants are
  // generated before composition) so they are available for all primary agents.
  const prebuiltReviewVariants: MaterializedAgent[] = reviewVariantEntries.map(
    ({ agentName: rvName, agentConfig: _rvConfig, entrySource: rvSource }) => {
      const rv = rvSource as {
        source: "review-variant";
        sourceAgentName: string;
        reviewModel: string;
      };
      return {
        agentName: rvName,
        // descriptor is a placeholder — only agentName/source/reviewMeta are
        // used by buildReviewRoutingContext; the real descriptor is composed later.
        descriptor: null as unknown as import("./compose.js").AgentDescriptor,
        source: "review-variant" as const,
        reviewMeta: {
          sourceAgentName: rv.sourceAgentName,
          reviewModel: rv.reviewModel,
        },
      };
    },
  );

  const reviewVariantNames = new Set(
    reviewVariantEntries.map(({ agentName }) => agentName),
  );
  const unavailable = new Map<string, UnavailableAgent>(
    unavailableFromReport(
      allTypedEntries.map(({ agentName }) => agentName),
      input.harness,
    ).map((entry) => [entry.agentName, entry]),
  );
  const delegationCandidates = (): ReadonlySet<string> =>
    new Set(
      allTypedEntries
        .map(({ agentName }) => agentName)
        .filter((agentName) => !unavailable.has(agentName)),
    );

  if (input.harness === undefined) {
    log.debug(
      { agentCount: allTypedEntries.length },
      "No harness materialization report — delegation targets are drawn from every agent that composes",
    );
  }

  type TypedEntry = (typeof allTypedEntries)[number];

  type Composed =
    | {
        ok: true;
        agentName: string;
        descriptor: AgentDescriptor;
        entrySource: EntrySource;
        /** Review variants this agent's review routing was built from. */
        reviewVariantsOffered: readonly string[];
      }
    | { ok: false; agentName: string; error: MaterializationError };

  const compose = (
    { agentName, agentConfig, entrySource }: TypedEntry,
    candidates: ReadonlySet<string>,
  ): Promise<Composed> => {
    const category = generatedShuttles[agentName]?.categoryMeta;
    const reviewVariants =
      agentConfig.mode === "primary"
        ? prebuiltReviewVariants.filter((variant) =>
            candidates.has(variant.agentName),
          )
        : undefined;
    return composeAgentDescriptor(
      agentName,
      agentConfig,
      config,
      allAgents,
      category,
      reviewVariants,
      generatedShuttles,
      promptFileReader,
      candidates,
    ).match<Composed>(
      (descriptor) => ({
        ok: true,
        agentName,
        descriptor,
        entrySource,
        reviewVariantsOffered: (reviewVariants ?? []).map(
          (variant) => variant.agentName,
        ),
      }),
      (cause) => ({
        ok: false,
        agentName,
        error: { type: "DescriptorCompositionFailure", agentName, cause },
      }),
    );
  };

  /** Whether a composed prompt offers an agent that is now unavailable. */
  const offersUnavailable = (result: Composed): boolean => {
    if (!result.ok) return false;
    if (
      result.descriptor.delegationTargets.some((target) =>
        unavailable.has(target.name),
      )
    )
      return true;
    return result.reviewVariantsOffered.some((name) => unavailable.has(name));
  };

  /**
   * Compose every agent, then re-compose only the agents whose prompt offers
   * one that failed to compose, until no prompt offers an unavailable agent.
   * Each round either marks another agent unavailable or settles, so there
   * are at most as many rounds as agents; in practice there is at most one,
   * because an agent's own composition does not depend on which targets it
   * is offered. The bound only guards against a composer that ignored the
   * candidate set.
   */
  const composeAll = async (): Promise<Composed[]> => {
    const initialCandidates = delegationCandidates();
    const results = await Promise.all(
      allTypedEntries.map((entry) => compose(entry, initialCandidates)),
    );

    for (let round = 0; round <= allTypedEntries.length; round += 1) {
      for (const result of results) {
        if (result.ok) continue;
        if (result.error.type !== "DescriptorCompositionFailure") continue;
        // The engine's own reason is more precise than "the adapter did not
        // report it"; any other reported reason stands.
        const known = unavailable.get(result.agentName);
        if (known !== undefined && known.reason !== "not_reported") continue;
        unavailable.set(result.agentName, {
          agentName: result.agentName,
          reason: "composition_failed",
          message: result.error.cause.message,
        });
      }

      const stale = results.flatMap((result, index) =>
        offersUnavailable(result) ? [index] : [],
      );
      if (stale.length === 0) return results;

      const candidates = delegationCandidates();
      const recomposed = await Promise.all(
        stale.map((index) =>
          compose(allTypedEntries[index] as TypedEntry, candidates),
        ),
      );
      stale.forEach((index, position) => {
        results[index] = recomposed[position] as Composed;
      });
    }
    return results;
  };

  return ResultAsync.fromSafePromise(composeAll()).andThen((composed) => {
    const agents: MaterializedAgent[] = [];
    const compositionErrors: MaterializationError[] = [];

    for (const result of composed) {
      if (!result.ok) {
        compositionErrors.push(result.error);
        continue;
      }
      const agent: MaterializedAgent = {
        agentName: result.agentName,
        descriptor: result.descriptor,
        source: result.entrySource.source,
      };
      if (result.entrySource.source === "review-variant") {
        agent.reviewMeta = {
          sourceAgentName: result.entrySource.sourceAgentName,
          reviewModel: result.entrySource.reviewModel,
        };
      }
      agents.push(agent);
    }

    const unavailableAgents = [...unavailable.values()];
    for (const excluded of unavailableAgents) {
      log.warn(
        {
          agent: excluded.agentName,
          reason: excluded.reason,
          message: excluded.message,
          reviewVariant: reviewVariantNames.has(excluded.agentName),
        },
        "Agent was not materialized — it is left out of every delegation target list",
      );
    }

    const errors: readonly MaterializationError[] = [
      ...conflictErrors,
      ...reviewVariantErrors,
      ...compositionErrors,
    ];

    return okAsync<MaterializationPlan, never>({
      agents,
      errors,
      unavailableAgents,
    });
  });
}

/**
 * The agents an adapter's report says the harness does not hold: every
 * candidate it reported as failed, or did not report as materialized at all.
 * A failure wins over a conflicting "materialized" entry.
 */
function unavailableFromReport(
  candidates: readonly string[],
  report: HarnessMaterializationReport | undefined,
): UnavailableAgent[] {
  if (report === undefined) return [];
  const materialized = new Set(report.materialized);
  const failed = new Map(
    report.failed.map((failure) => [failure.agentName, failure]),
  );
  return candidates.flatMap((agentName): UnavailableAgent[] => {
    const failure = failed.get(agentName);
    if (failure !== undefined) return [failure];
    if (materialized.has(agentName)) return [];
    return [{ agentName, reason: "not_reported" }];
  });
}
