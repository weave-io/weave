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
import {
  type GeneratedReviewVariant,
  generateReviewVariants,
  type ReviewVariantConflictError,
} from "./review-variants.js";
import { evaluateEffectiveToolPolicy } from "./tool-policy.js";

/** Adapter-provided input for public agent materialization. */
export interface MaterializationInput {
  /** Fully resolved and validated Weave configuration. */
  config: WeaveConfig;
  /**
   * Optional prompt-source seam for `prompt_file` and `prompt_append_file`.
   *
   * Omit it to keep the historical behavior of reading each declared path with
   * Bun. Supply one to compose from bytes the caller already holds. Either way
   * materialization consults the reader at most once per distinct path.
   */
  promptFileReader?: PromptFileReader;
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

/**
 * Wrap a reader so each distinct path is read at most once for the lifetime of
 * the wrapper.
 *
 * The cached value is the reader's `ResultAsync` itself, so concurrent agents
 * that declare the same prompt file share one in-flight read and observe the
 * same content — or the same failure.
 */
function memoizeByPath(reader: PromptFileReader): PromptFileReader {
  const reads = new Map<string, ResultAsync<string, PromptFileReadFailure>>();

  return {
    read(path) {
      const cached = reads.get(path);
      if (cached !== undefined) return cached;

      const pending = reader.read(path);
      reads.set(path, pending);
      return pending;
    },
  };
}

function filterDisabled(
  entries: [string, AgentConfig][],
  disabled: readonly string[],
): [string, AgentConfig][] {
  return entries.filter(([agentName]) => !disabled.includes(agentName));
}

function buildReviewVariantPlaceholder(
  agentName: string,
  agentConfig: AgentConfig,
): AgentDescriptor {
  return {
    name: agentName,
    composedPrompt: "",
    models: agentConfig.models === undefined ? [] : [...agentConfig.models],
    mode: agentConfig.mode ?? "subagent",
    effectiveToolPolicy: evaluateEffectiveToolPolicy(agentConfig.tool_policy),
    rawToolPolicy: agentConfig.tool_policy,
    delegationTargets: [],
    skills: agentConfig.skills === undefined ? [] : [...agentConfig.skills],
  };
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
 *
 * Prompt files are read through `input.promptFileReader` when supplied and with
 * Bun otherwise. Each distinct path is read at most once per call, so agents
 * that share a prompt file compose from the same bytes.
 */
export function materializeAgents(
  input: MaterializationInput,
): ResultAsync<MaterializationPlan, never> {
  const { config } = input;
  const disabled = config.disabled.agents;
  const promptFileReader = memoizeByPath(
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
    entrySource: { source: "explicit" } satisfies EntrySource,
  }));

  const generatedEntries = Object.entries(generatedShuttles)
    .filter(([agentName]) => !disabled.includes(agentName))
    .map(([agentName, generated]) => ({
      agentName,
      agentConfig: generated.config,
      entrySource: { source: "category-shuttle" } satisfies EntrySource,
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
      } satisfies EntrySource,
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
    ({ agentName, agentConfig, entrySource }) => ({
      agentName,
      // The descriptor is a placeholder — only agentName/source/reviewMeta are
      // used by buildReviewRoutingContext; the real descriptor is composed later.
      descriptor: buildReviewVariantPlaceholder(agentName, agentConfig),
      source: "review-variant",
      reviewMeta: {
        sourceAgentName: entrySource.sourceAgentName,
        reviewModel: entrySource.reviewModel,
      },
    }),
  );

  const compositionPromises = allTypedEntries.map(
    ({ agentName, agentConfig, entrySource }) => {
      const category = generatedShuttles[agentName]?.categoryMeta;
      const isPrimary = agentConfig.mode === "primary";
      return composeAgentDescriptor(
        agentName,
        agentConfig,
        config,
        allAgents,
        category,
        isPrimary ? prebuiltReviewVariants : undefined,
        promptFileReader,
      ).match<
        | {
            ok: true;
            agentName: string;
            descriptor: AgentDescriptor;
            entrySource: EntrySource;
          }
        | { ok: false; error: MaterializationError }
      >(
        (descriptor) => ({ ok: true, agentName, descriptor, entrySource }),
        (cause) => ({
          ok: false,
          error: { type: "DescriptorCompositionFailure", agentName, cause },
        }),
      );
    },
  );

  return ResultAsync.fromSafePromise(Promise.all(compositionPromises)).andThen(
    (composed) => {
      const agents: MaterializedAgent[] = [];
      const compositionErrors: MaterializationError[] = [];

      for (const result of composed) {
        if (result.ok) {
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
        } else {
          compositionErrors.push(result.error);
        }
      }

      const errors: readonly MaterializationError[] = [
        ...conflictErrors,
        ...reviewVariantErrors,
        ...compositionErrors,
      ];

      return okAsync<MaterializationPlan, never>({ agents, errors });
    },
  );
}
