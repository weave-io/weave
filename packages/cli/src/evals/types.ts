/**
 * Zod schemas and inferred types for the Weave eval fixture contracts.
 *
 * These schemas define the allowlisted shape for eval case fixtures
 * (`evals/cases/**\/*.json`) and rubric files (`evals/rubrics/**\/*.json`).
 * They are independent of the DSL config schemas in `@weaveio/weave-core`.
 *
 * Design notes:
 *   - All identifiers are constrained to the IDENTIFIER_RE pattern to
 *     keep them unambiguous as filter/routing keys.
 *   - `expected_outcome` is a discriminated union keyed on `kind` — this
 *     lets downstream scorers branch without free-form string checks.
 *   - `accepted_alternates` provides the closed set of model IDs or agent
 *     names that may substitute for the canonical expectation.
 *   - `transcript_expectations` carries ordered assertions on the eval
 *     conversation transcript (e.g. tool call presence, content checks).
 *   - Rubric files define the scoring metadata that maps outcome assertions
 *     to numeric weights. They live alongside case fixtures but are
 *     validated separately so runners can load them independently.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared identifier primitive
// ---------------------------------------------------------------------------

/**
 * Allowlisted identifier character set.
 * Matches alphanumerics, underscores, hyphens, dots, forward slashes,
 * colons, and @ — the full set accepted by `input-validation.ts`.
 */
const IDENTIFIER_RE = /^[A-Za-z0-9_./:@-]+$/;

/**
 * A validated, non-empty identifier string.
 * Used for case IDs, agent names, model IDs, and filter keys.
 */
export const IdentifierSchema = z
  .string()
  .min(1, "identifier must be non-empty")
  .regex(IDENTIFIER_RE, "identifier may only contain A-Z a-z 0-9 _ . / : @ -");

// ---------------------------------------------------------------------------
// Shared eval suite metadata registry
// ---------------------------------------------------------------------------

/**
 * Expected outcome kinds supported by the fixture schema.
 */
export const EXPECTED_OUTCOME_KINDS = [
  "agent_routing",
  "task_completion",
  "delegation_chain",
  "tool_call",
] as const;

export type ExpectedOutcomeKind = (typeof EXPECTED_OUTCOME_KINDS)[number];

/**
 * Transcript expectation checks supported by the fixture schema.
 */
export const TRANSCRIPT_EXPECTATION_CHECKS = [
  "content_contains",
  "tool_called",
  "agent_mentioned",
  "no_tool_called",
] as const;

export type TranscriptExpectationCheck =
  (typeof TRANSCRIPT_EXPECTATION_CHECKS)[number];

/**
 * Transcript roles supported by `content_contains` expectations.
 */
export const TRANSCRIPT_EXPECTATION_ROLES = [
  "user",
  "assistant",
  "tool",
] as const;

export type TranscriptExpectationRole =
  (typeof TRANSCRIPT_EXPECTATION_ROLES)[number];

/**
 * Shared metadata for one eval suite.
 *
 * This registry is the single source of truth for:
 *   - known eval suite IDs
 *   - short `--agent` filter values
 *   - per-suite text-visible assertion contracts
 */
export interface EvalSuiteMetadata {
  suiteId: string;
  shortAgentFilter: string;
  allowedExpectedOutcomeKinds: readonly ExpectedOutcomeKind[];
  allowedTranscriptChecks: readonly TranscriptExpectationCheck[];
  allowedContentRoles: readonly TranscriptExpectationRole[];
}

/**
 * Text-eval suite registry.
 *
 * These suites are text-only: they may assert only signals visible in model
 * text output. Runtime-only assertions such as `tool_call`, `tool_called`,
 * `no_tool_called`, or `content_contains` on `tool` role are rejected before
 * any dry-run or live model execution begins, including attempted network- or
 * tool-event assertions in research-oriented suites.
 */
export const EVAL_SUITE_REGISTRY: readonly EvalSuiteMetadata[] = [
  {
    suiteId: "loom-routing",
    shortAgentFilter: "loom",
    allowedExpectedOutcomeKinds: ["agent_routing"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "tapestry-execution",
    shortAgentFilter: "tapestry",
    allowedExpectedOutcomeKinds: ["task_completion", "delegation_chain"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "shuttle-execution",
    shortAgentFilter: "shuttle",
    allowedExpectedOutcomeKinds: ["task_completion"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "spindle-tools",
    shortAgentFilter: "spindle",
    allowedExpectedOutcomeKinds: ["task_completion"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "pattern-planning",
    shortAgentFilter: "pattern",
    allowedExpectedOutcomeKinds: ["task_completion"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "weft-review",
    shortAgentFilter: "weft",
    allowedExpectedOutcomeKinds: ["task_completion"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "warp-security",
    shortAgentFilter: "warp",
    allowedExpectedOutcomeKinds: ["task_completion"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
  {
    suiteId: "tapestry-category-routing",
    shortAgentFilter: "tapestry",
    allowedExpectedOutcomeKinds: ["agent_routing"],
    allowedTranscriptChecks: ["content_contains", "agent_mentioned"],
    allowedContentRoles: ["user", "assistant"],
  },
] as const;

export const EVAL_SUITE_IDS = EVAL_SUITE_REGISTRY.map((suite) => suite.suiteId);

export const EVAL_SHORT_AGENT_FILTERS = EVAL_SUITE_REGISTRY.map(
  (suite) => suite.shortAgentFilter,
);

export const EVAL_AGENT_FILTERS = [
  ...new Set([...EVAL_SHORT_AGENT_FILTERS, ...EVAL_SUITE_IDS]),
].sort();

export function getEvalSuiteMetadata(
  suiteId: string,
): EvalSuiteMetadata | undefined {
  return EVAL_SUITE_REGISTRY.find((suite) => suite.suiteId === suiteId);
}

export function isKnownEvalSuiteId(suiteId: string): boolean {
  return getEvalSuiteMetadata(suiteId) !== undefined;
}

// ---------------------------------------------------------------------------
// Expected outcome — discriminated union
// ---------------------------------------------------------------------------

/**
 * The canonical expected outcome kinds for an eval case.
 *
 * - `agent_routing`    — verify that the orchestrator routed to the correct
 *                        agent or set of agents (Loom routing cases).
 * - `task_completion`  — verify that a task was completed with the described
 *                        artefacts / signals (Tapestry execution cases).
 * - `delegation_chain` — verify that a multi-hop delegation sequence occurred
 *                        in the expected order (Tapestry delegation cases).
 * - `tool_call`        — verify that a specific tool was called (optional
 *                        payload match) at some point in the transcript.
 */
export const ExpectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent_routing"),
    /** The canonical target agent name. */
    target_agent: IdentifierSchema,
    /**
     * Ordered list of intermediate agents visited before reaching
     * `target_agent`. Empty means direct routing is expected.
     */
    via: z.array(IdentifierSchema).default([]),
  }),
  z.object({
    kind: z.literal("task_completion"),
    /** Human-readable description of what completion looks like. */
    description: z.string().min(1),
    /** Optional set of artefact names that must be present on success. */
    required_artifacts: z.array(IdentifierSchema).default([]),
  }),
  z.object({
    kind: z.literal("delegation_chain"),
    /**
     * The expected ordered sequence of agent names in the delegation chain.
     * Must have at least two entries (delegator → delegate).
     */
    chain: z
      .array(IdentifierSchema)
      .min(2, "chain must have at least 2 agents"),
  }),
  z.object({
    kind: z.literal("tool_call"),
    /** Name of the tool expected to be called. */
    tool_name: IdentifierSchema,
    /** Optional JSON payload that must be present in the tool call arguments. */
    payload_contains: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type ExpectedOutcome = z.infer<typeof ExpectedOutcomeSchema>;

// ---------------------------------------------------------------------------
// Transcript expectation
// ---------------------------------------------------------------------------

/**
 * An ordered assertion on the eval conversation transcript.
 *
 * Transcript expectations are checked in order against the linearised
 * message sequence. A `content_contains` check scans all messages of the
 * given `role` for the presence of the substring. A `tool_called` check
 * verifies that the tool was invoked at least once.
 */
export const TranscriptExpectationSchema = z.discriminatedUnion("check", [
  z.object({
    check: z.literal("content_contains"),
    /** Which transcript participant to check: user, assistant, or tool. */
    role: z.enum(TRANSCRIPT_EXPECTATION_ROLES),
    /** Substring that must appear in at least one message from this role. */
    contains: z.string().min(1, "contains must be non-empty"),
  }),
  z.object({
    check: z.literal("tool_called"),
    /** Tool that must appear in the transcript tool-call records. */
    tool_name: IdentifierSchema,
  }),
  z.object({
    check: z.literal("agent_mentioned"),
    /** Agent name that must appear in at least one assistant message. */
    agent_name: IdentifierSchema,
  }),
  z.object({
    check: z.literal("no_tool_called"),
    /** Tool that must NOT appear in the transcript (negative assertion). */
    tool_name: IdentifierSchema,
  }),
]);

export type TranscriptExpectation = z.infer<typeof TranscriptExpectationSchema>;

// ---------------------------------------------------------------------------
// Scoring metadata
// ---------------------------------------------------------------------------

/**
 * Per-case scoring metadata included in rubric files.
 *
 * Rubrics live at `evals/rubrics/<suite>/<case-id>.json` and are loaded
 * independently from case fixtures. A single rubric file may reference
 * multiple outcome assertions with individual weights.
 */
export const ScoringMetadataSchema = z.object({
  /**
   * Weight for the primary expected outcome (0.0–1.0).
   * Weights across all assertions in a rubric should sum to 1.0 but
   * this is validated at the runner level, not here.
   */
  outcome_weight: z.number().min(0).max(1),
  /**
   * Weight applied to each passing transcript expectation.
   * Total transcript score = passing_count × per_expectation_weight.
   */
  per_expectation_weight: z.number().min(0).max(1).default(0),
  /**
   * Whether this case is required to pass for the suite to be considered
   * green. Non-required cases contribute to scoring but do not block.
   */
  required: z.boolean().default(true),
  /**
   * Optional freeform notes for human reviewers (not used by runners).
   */
  notes: z.string().optional(),
});

export type ScoringMetadata = z.infer<typeof ScoringMetadataSchema>;

// ---------------------------------------------------------------------------
// Eval case fixture
// ---------------------------------------------------------------------------

/**
 * A single eval case fixture.
 *
 * Lives at `evals/cases/<suite>/<case-id>.json`.
 * All string identifiers are validated against `IdentifierSchema`.
 */
export const EvalCaseSchema = z.object({
  /**
   * Unique case identifier within the suite.
   * Used as the `--case` filter value; must satisfy `IdentifierSchema`.
   */
  id: IdentifierSchema,
  /** Human-readable description of what this case exercises. */
  description: z.string().min(1, "description must be non-empty"),
  /**
   * The eval suite this case belongs to.
   * Convention: `loom-routing` | `tapestry-execution` |
   * `shuttle-execution` | `spindle-tools` | `pattern-planning` |
   * `weft-review` | `warp-security`.
   */
  suite: IdentifierSchema,
  /**
   * The closed set of agent names that are valid targets for this case.
   * At least one entry is required so runners can reject unknown agents.
   */
  allowed_agents: z
    .array(IdentifierSchema)
    .min(1, "allowed_agents must have at least one entry"),
  /**
   * The closed set of model identifiers valid for this case.
   * When the eval runs with a model filter, the loader validates the
   * filter value is in this set (or in the model matrix).
   * At least one entry is required.
   */
  allowed_models: z
    .array(IdentifierSchema)
    .min(1, "allowed_models must have at least one entry"),
  /**
   * The canonical expected outcome.
   * Validates via the discriminated union — unknown `kind` values are rejected.
   */
  expected_outcome: ExpectedOutcomeSchema,
  /**
   * Closed set of model IDs or agent names accepted as substitutes for the
   * canonical outcome. E.g. if `expected_outcome.target_agent` is `"shuttle"`,
   * `accepted_alternates` may allow `"shuttle-backend"` as an equivalent.
   */
  accepted_alternates: z.array(IdentifierSchema).default([]),
  /**
   * Ordered assertions on the eval transcript.
   * Checked in order by the runner; empty means no transcript assertions.
   */
  transcript_expectations: z.array(TranscriptExpectationSchema).default([]),
  /**
   * Optional case-level tags for grouping/filtering (all must be valid
   * identifiers so they can be used as filter keys without escaping).
   */
  tags: z.array(IdentifierSchema).default([]),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;

// ---------------------------------------------------------------------------
// Rubric fixture
// ---------------------------------------------------------------------------

/**
 * A rubric file defines the scoring metadata for a single eval case.
 *
 * Lives at `evals/rubrics/<suite>/<case-id>.json` and is matched to a case
 * fixture by the `case_id` field. The rubric `case_id` must match the case
 * fixture `id` exactly.
 */
export const EvalRubricSchema = z.object({
  /**
   * The case ID this rubric scores.
   * Must match the `id` field of the corresponding case fixture exactly.
   */
  case_id: IdentifierSchema,
  /** The suite this rubric belongs to (must match the case fixture `suite`). */
  suite: IdentifierSchema,
  /** Scoring weights and pass/fail metadata. */
  scoring: ScoringMetadataSchema,
});

export type EvalRubric = z.infer<typeof EvalRubricSchema>;

// ---------------------------------------------------------------------------
// Model matrix
// ---------------------------------------------------------------------------

/**
 * A single model entry in the model matrix.
 *
 * The model matrix defines the canonical set of models that evals run
 * against. It is the source of truth for allowlist validation when a
 * `--model` filter is supplied.
 */
export const ModelMatrixEntrySchema = z.object({
  /**
   * Fully-qualified model identifier (e.g. `"openai/gpt-4o"`,
   * `"anthropic/claude-sonnet-4-5"`). Must satisfy `IdentifierSchema`.
   */
  id: IdentifierSchema,
  /** Human-readable display name for reporting. */
  display_name: z.string().min(1, "display_name must be non-empty"),
  /**
   * Provider/owner of the model (e.g. `"openai"`, `"anthropic"`).
   * Used for grouping in reports.
   */
  provider: IdentifierSchema,
  /**
   * Whether this model is included in the default run (i.e. when no
   * `--model` filter is supplied). At least three entries in the matrix
   * must have `default: true` — enforced by `model-matrix.ts` at load time.
   */
  default: z.boolean(),
  /**
   * Optional tags (e.g. `["fast"]`, `["expensive"]`) for future
   * tier-based filtering. All must be valid identifiers.
   */
  tags: z.array(IdentifierSchema).default([]),
});

export type ModelMatrixEntry = z.infer<typeof ModelMatrixEntrySchema>;

/**
 * The full model matrix fixture (`evals/model-matrix.json`).
 *
 * `version` is a positive integer for future migration compatibility.
 * `models` is the ordered list of model entries; at least one must exist.
 */
export const ModelMatrixSchema = z.object({
  /** Fixture schema version (positive integer). */
  version: z.number().int().positive(),
  /** Ordered list of model entries. Must have at least one entry. */
  models: z
    .array(ModelMatrixEntrySchema)
    .min(1, "models must have at least one entry"),
});

export type ModelMatrix = z.infer<typeof ModelMatrixSchema>;

// ---------------------------------------------------------------------------
// Typed schema error
// ---------------------------------------------------------------------------

/**
 * A typed error produced when a fixture fails schema validation.
 *
 * The `file` field points at the offending fixture path so callers can
 * surface actionable error messages that include the file name.
 */
export type FixtureSchemaError =
  | {
      type: "UnknownEvalSuite";
      /** Suite ID that is not present in `EVAL_SUITE_REGISTRY`. */
      suite: string;
      /** Optional offending fixture file path. */
      file?: string;
      message: string;
    }
  | {
      type: "UnsupportedTextEvalAssertion";
      /** Path to the offending fixture. */
      file: string;
      /** Suite whose contract was violated. */
      suite: string;
      /** Human-readable summary. */
      message: string;
      /** Contract violations with structured paths. */
      issues: Array<{ path: string; message: string }>;
    }
  | {
      type: "FixtureValidationFailed";
      /** Absolute or relative path to the offending fixture file. */
      file: string;
      /** Human-readable summary of what failed. */
      message: string;
      /** Raw Zod issue list for structured inspection. */
      issues: Array<{ path: string; message: string }>;
    }
  | {
      type: "FixtureFileNotFound";
      /** Path that could not be read. */
      file: string;
      message: string;
    }
  | {
      type: "FixtureParseError";
      /** Path that could not be parsed as JSON. */
      file: string;
      message: string;
    }
  | {
      type: "ModelMatrixConstraintViolation";
      /** The model matrix file path. */
      file: string;
      message: string;
    };

// ---------------------------------------------------------------------------
// Prompt provenance — publishable records
// ---------------------------------------------------------------------------

/**
 * Describes the source of a composed prompt for one agent.
 *
 * Source descriptors are collected during composition and stored in
 * provenance records so reviewers can trace where each prompt layer came from
 * without storing raw prompt text.
 *
 * - `"builtin"`   — the prompt was loaded from the builtin DSL/embedded content
 * - `"file"`      — the prompt came from a file on disk (path recorded)
 * - `"inline"`    — the prompt was declared inline in the DSL config
 * - `"generated"` — the prompt was synthesized by the engine (e.g. category shuttle)
 */
export type PromptSourceKind = "builtin" | "file" | "inline" | "generated";

/**
 * A single source descriptor for one layer of a composed prompt.
 *
 * Multiple descriptors may be present when a composed prompt has a primary
 * source plus an append source (e.g. `prompt_file` + `prompt_append`).
 */
export interface PromptSourceDescriptor {
  /** Which kind of source provided this layer. */
  kind: PromptSourceKind;
  /**
   * For `"file"` sources: the resolved file path (relative to repo root if
   * possible, absolute otherwise). Omitted for `"inline"` and `"builtin"`.
   */
  filePath?: string;
  /**
   * Human-readable label for this source layer, e.g. `"primary"` or
   * `"append"`. Used in summaries and diagnostics.
   */
  layer: "primary" | "append";
}

/**
 * A prompt snapshot for a single agent.
 *
 * The snapshot is taken after full composition (Mustache rendering applied).
 * It records the hash and length of the composed prompt plus its sources.
 *
 * Raw prompt text is never present in this record. Use `RawPromptArtifact`
 * for local-only raw capture.
 */
export interface PromptSnapshot {
  /** The agent name this snapshot belongs to (e.g. `"loom"`, `"tapestry"`). */
  agentName: string;
  /**
   * SHA-256 hex digest of the fully composed prompt (UTF-8 encoded).
   * Deterministic: the same content always yields the same hash.
   */
  hash: string;
  /** Byte length of the composed prompt encoded as UTF-8. */
  byteLength: number;
  /** Character length of the composed prompt. */
  charLength: number;
  /** Source descriptors describing where each prompt layer came from. */
  sources: PromptSourceDescriptor[];
}

/**
 * Local-only raw prompt artifact.
 *
 * Contains the actual composed prompt text. This record is only created when
 * `rawArtifacts` is explicitly enabled and MUST NOT be included in any
 * publishable manifest or committed to version control.
 *
 * Only produced when `EvalRunRequest.rawArtifacts === true`.
 */
export interface RawPromptArtifact {
  /** The agent name this artifact belongs to. */
  agentName: string;
  /** The fully composed prompt text. Local-only; never publish. */
  composedPrompt: string;
}

// ---------------------------------------------------------------------------
// Prompt provenance records — publishable manifest entry
// ---------------------------------------------------------------------------

/**
 * A single prompt provenance record for one agent at one git SHA.
 *
 * Provenance records are the publishable unit. They contain:
 * - A stable SHA-256 hash of the composed prompt (hash-first)
 * - A sanitized summary of prompt provenance (summary-first)
 * - Metadata fields: byte/char length, source descriptors, git SHA
 *
 * Raw prompt text is NEVER present in a provenance record.
 */
export interface PromptProvenanceRecord {
  /** The agent name this record describes. */
  agentName: string;
  /**
   * SHA-256 hex digest of the fully composed prompt (UTF-8 encoded).
   * Changes whenever prompt content changes — hash-first discriminator.
   */
  hash: string;
  /** Byte length of the composed prompt (UTF-8 encoded). */
  byteLength: number;
  /** Character length of the composed prompt. */
  charLength: number;
  /** Source descriptors listing where each prompt layer came from. */
  sources: PromptSourceDescriptor[];
  /**
   * Sanitized human-readable summary of prompt provenance.
   * Describes agent, source kinds, and lengths without exposing raw prompt text.
   * Safe to commit and publish.
   */
  summary: string;
  /**
   * The git commit SHA at which this provenance was captured.
   * Used to correlate prompt snapshots with code changes over time.
   * `"unknown"` when git SHA cannot be determined.
   */
  gitSha: string;
  /** ISO 8601 timestamp at which the provenance record was captured. */
  capturedAt: string;
}

/**
 * The top-level publishable prompt provenance manifest.
 *
 * A manifest groups all provenance records from a single eval run.
 * It is safe to store in the external repo — no raw prompt text is present.
 */
export interface PromptProvenanceManifest {
  /** Manifest schema version (positive integer). */
  version: number;
  /** ISO 8601 timestamp when the manifest was produced. */
  producedAt: string;
  /** Git SHA at capture time. `"unknown"` when not determinable. */
  gitSha: string;
  /** Ordered list of provenance records, one per agent. */
  records: PromptProvenanceRecord[];
}

// ---------------------------------------------------------------------------
// Model run output — input to scoring
// ---------------------------------------------------------------------------

/**
 * A single message in the model run transcript.
 *
 * Role-labelled messages are produced by the model during an eval run and
 * carry the raw content that scoring adapters inspect for assertions.
 */
export interface TranscriptMessage {
  /** The role of the message author. */
  role: "user" | "assistant" | "tool" | "system";
  /** The message content (plain text or serialised JSON for tool calls). */
  content: string;
  /**
   * Optional tool call name — present when `role === "tool"` or when the
   * assistant emits a structured tool-call message.
   */
  toolName?: string;
}

/**
 * The normalized output of a single model run for one eval case.
 *
 * Produced by the eval runner after executing a case against one model.
 * Consumed by scoring adapters (e.g. `LangChainAgentEvalsScorer`) to
 * produce `NormalizedScoreRecord` values.
 *
 * Design notes:
 *   - `routedAgents` captures the ordered sequence of agent names that the
 *     model nominated during its response (e.g. via delegation intent).
 *   - `delegationChain` records the multi-hop ordered sequence for chain
 *     verification, including the full path from delegator to final delegate.
 *   - `transcript` is the full ordered message sequence for transcript
 *     expectation checks.
 *   - `rawContent` is the final assistant response text used for rationale
 *     quality scoring.
 */
export interface ModelRunOutput {
  /** The eval case ID this run corresponds to. */
  caseId: string;
  /** The model identifier used for this run. */
  modelId: string;
  /**
   * Ordered list of agent names that the model nominated for routing.
   * Empty when the model did not route to any agent.
   */
  routedAgents: string[];
  /**
   * Ordered delegation chain expressed by the model.
   * Empty when the model did not express any delegation chain.
   */
  delegationChain: string[];
  /**
   * Full ordered transcript of the run (user → assistant → tool messages).
   * Empty means no messages were captured.
   */
  transcript: TranscriptMessage[];
  /**
   * The final assistant response text, used for rationale quality scoring.
   * Empty string when the run produced no textual output.
   */
  rawContent: string;
  /**
   * Whether the run signalled task completion (e.g. via a sentinel tool
   * call, a recognized completion phrase, or explicit completion metadata).
   */
  completionSignalled: boolean;
  /**
   * Required artifact names that the run claimed to have produced.
   * Cross-referenced against `EvalCase.expected_outcome.required_artifacts`
   * for `task_completion` cases.
   */
  producedArtifacts: string[];
}

// ---------------------------------------------------------------------------
// Normalized score record — output of scoring
// ---------------------------------------------------------------------------

/**
 * The four scoring dimensions measured by the AgentEvals scorer.
 *
 * Each dimension produces a `DimensionScore` with a `score` in `[0, 1]`
 * and a `rationale` string that explains the score.
 *
 * Dimension semantics:
 *   - `routingCorrectness`    — did the model route to the correct agent(s)?
 *   - `delegationCorrectness` — did the delegation chain match the expected
 *                               ordered sequence of agents?
 *   - `executionCompleteness` — did the model complete the task with the
 *                               required artifacts and a completion signal?
 *   - `rationaleQuality`      — is the model's rationale/explanation coherent,
 *                               relevant, and sufficiently detailed?
 */
export type ScoringDimension =
  | "routingCorrectness"
  | "delegationCorrectness"
  | "executionCompleteness"
  | "rationaleQuality";

/**
 * A score for a single dimension with an explanatory rationale.
 *
 * `score` is always in the closed interval `[0, 1]`:
 *   - `1.0` — perfect / fully correct
 *   - `0.0` — completely wrong / no signal
 *   - Values between are fractional credit (e.g. partial routing match)
 *
 * `rationale` is a human-readable explanation of why the score was assigned.
 * It must never be empty — scoring adapters must always provide context.
 */
export interface DimensionScore {
  /**
   * Numeric score in the closed interval `[0, 1]`.
   * `1.0` is perfect; `0.0` is complete failure.
   */
  score: number;
  /**
   * Human-readable explanation of the score.
   * Must be non-empty; produced by the scoring adapter.
   */
  rationale: string;
  /**
   * Whether this dimension was applicable to the case.
   * Non-applicable dimensions should be noted in `rationale` and carry
   * a neutral `score` of `1.0` (not penalizing cases for inapplicable
   * dimensions).
   */
  applicable: boolean;
}

/**
 * The normalized score record produced for one case × model pair.
 *
 * Scoring records are the stable output contract of the scorer. They carry:
 *   - Identification fields (`caseId`, `modelId`, `suite`)
 *   - Per-dimension scores (one for each `ScoringDimension`)
 *   - A `weightedTotal` that collapses all dimensions into a single number
 *     using the rubric weights
 *   - A `passed` flag that indicates whether the case is considered green
 *     based on the rubric's `required` flag and a threshold
 *
 * The shape is Weave-owned — scoring adapters produce this type, not
 * LangChain-specific types. Downstream reporting only sees this record.
 */
export interface NormalizedScoreRecord {
  /** The eval case ID this record scores. */
  caseId: string;
  /** The model identifier used for the run. */
  modelId: string;
  /** The eval suite this case belongs to. */
  suite: string;
  /** Per-dimension scores, keyed by dimension name. */
  dimensions: Record<ScoringDimension, DimensionScore>;
  /**
   * Weighted total score in `[0, 1]`.
   *
   * Computed using the rubric `outcome_weight` for the primary dimension
   * (routing, delegation, or execution — depending on `expected_outcome.kind`)
   * and `per_expectation_weight` for `rationaleQuality` and transcript
   * expectation scores.
   */
  weightedTotal: number;
  /**
   * Whether the case is considered passing.
   *
   * A case passes when an applicable primary structural dimension is
   * near-perfect (`score >= 0.95`), or when `weightedTotal >= PASS_THRESHOLD`
   * (0.5 by default) and non-required cases do not need a near-perfect primary
   * dimension. Required cases with only partial primary correctness do not pass
   * on rationale quality alone.
   */
  passed: boolean;
  /**
   * Whether this case was marked `required` in the rubric.
   * Non-required failures do not block suite green status.
   */
  required: boolean;
  /** ISO 8601 timestamp when the score record was produced. */
  scoredAt: string;
}

// ---------------------------------------------------------------------------
// Scoring error types
// ---------------------------------------------------------------------------

/**
 * Typed errors produced by the AgentEvals scoring adapter.
 *
 * All scoring failures are returned as `Result` / `ResultAsync` values —
 * no exceptions propagate from the scorer to callers.
 */
export type ScoringError =
  | {
      /**
       * No rubric was found for the case being scored.
       *
       * Returned when the rubric set passed to the scorer does not contain
       * an entry whose `case_id` matches the `ModelRunOutput.caseId`.
       */
      type: "RubricNotFound";
      /** The case ID for which no rubric was found. */
      caseId: string;
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * Rubric `case_id` does not match the case `id`.
       *
       * This is a fixture integrity error — rubric and case files must be
       * matched by `case_id` before being passed to the scorer.
       */
      type: "RubricCaseMismatch";
      /** The case ID from `ModelRunOutput`. */
      caseId: string;
      /** The `case_id` found in the rubric. */
      rubricCaseId: string;
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * The underlying LangChain AgentEvals adapter returned a scoring
       * failure for this case.
       *
       * Carries the original adapter error message and the dimension
       * that failed, allowing callers to retry or log with context.
       */
      type: "ScorerAdapterError";
      /** The case ID that triggered the adapter error. */
      caseId: string;
      /** The scoring dimension that encountered the error. */
      dimension: ScoringDimension;
      /** Human-readable description forwarded from the adapter. */
      message: string;
    }
  | {
      /**
       * Returned by `StubAgentEvalsScorer` when `score()` is called but
       * no response has been configured.
       *
       * This is a programming error in the test setup — analogous to
       * `NotConfigured` in `StubModelClient`. The variant exists so tests
       * can assert on a typed error rather than catching a thrown exception.
       */
      type: "NotConfigured";
      /** Zero-based index of the call that was not configured. */
      callIndex: number;
      /** Human-readable description. */
      message: string;
    };

// ---------------------------------------------------------------------------
// Prompt provider interface — abstracts prompt acquisition for runners
// ---------------------------------------------------------------------------

/**
 * Abstracts prompt acquisition for eval runners.
 *
 * The default production implementation composes the prompt via
 * `composeAgentSnapshots` from `prompt-snapshots.ts`. Tests inject a mock
 * that returns a controlled string without touching the file system, git, or
 * any network endpoint.
 *
 * The interface is intentionally narrow — one method, typed I/O — so stubs
 * remain simple and the engine-level composition stays decoupled from the
 * runner execution loop.
 */
export interface PromptProvider {
  /**
   * Retrieve the composed system prompt for the named agent.
   *
   * @param agentName - The agent whose prompt should be composed
   *                    (e.g. `"loom"` or `"tapestry"`).
   * @returns `ResultAsync<string, ProvenanceError>` — the composed prompt text,
   *          or a typed error when composition fails.
   */
  getPrompt(
    agentName: string,
  ): import("neverthrow").ResultAsync<string, ProvenanceError>;
}

// ---------------------------------------------------------------------------
// Bounded raw error summary — for local-only raw artifacts
// ---------------------------------------------------------------------------

/**
 * A bounded, sanitized summary of an error that occurred during a run or
 * scoring step.
 *
 * Used in `RawCaseResultArtifact` to record diagnostic error context without
 * storing arbitrary raw error strings, stack traces, or unbounded provider
 * response bodies.
 *
 * Design rules:
 *   - `errorType` is drawn from the known typed error discriminants
 *     (e.g. `"NetworkError"`, `"ParseError"`, `"RubricNotFound"`).
 *   - `classification` is a fixed, allowlisted string derived from `errorType`.
 *     It never contains raw provider message text, stack traces, or secrets.
 *   - `dimension` carries the scoring dimension name for `ScorerAdapterError`
 *     variants; omitted for model client errors.
 *   - `localDiagnostic` is a LOCAL-ONLY bounded diagnostic string for debugging.
 *     It may contain the scorer/provider error message (with common secret
 *     patterns redacted). It is ONLY written when `--raw-artifacts` is
 *     explicitly used and MUST NEVER appear in any publishable bundle or
 *     committed artifact. The central sanitizer blocks this field in all
 *     publishable output.
 *
 * Arbitrary provider/scorer message text is NEVER stored in `classification`.
 * Callers use `classifyErrorType()` to derive the classification string from
 * the typed discriminant, and `redactSecrets()` before placing text in
 * `localDiagnostic`.
 */
export interface RawErrorSummary {
  /**
   * The typed error discriminant (e.g. `"NetworkError"`, `"RubricNotFound"`).
   * Drawn from `ModelClientError.type` or `ScoringError.type`.
   */
  errorType: string;
  /**
   * A fixed, allowlisted classification string derived from `errorType`.
   *
   * This is NOT the raw error message from the provider or scorer. It is a
   * sanitized label such as `"model-network-failure"`, `"model-parse-failure"`,
   * or `"scoring-rubric-missing"` — derived from the typed discriminant, never
   * copied from provider/scorer message text.
   */
  classification: string;
  /**
   * For scoring errors: the dimension that failed.
   * Omitted for model client errors.
   */
  dimension?: string;
  /**
   * LOCAL-ONLY bounded diagnostic string for debugging scorer/model failures.
   *
   * Contains the scorer or provider error message after redacting common secret
   * patterns (API keys, bearer tokens, etc.). Bounded to 500 characters to
   * prevent unbounded growth from provider response bodies.
   *
   * This field is:
   *   - ONLY present when `--raw-artifacts` is explicitly enabled
   *   - ONLY written to local raw artifact files (`raw/` subdirectory)
   *   - NEVER included in any publishable bundle or manifest
   *   - Blocked by the central sanitizer (`SENSITIVE_FIELD_NAMES`)
   *
   * Use this field to diagnose scorer integration failures locally without
   * needing to re-run against a live model.
   */
  localDiagnostic?: string;
}

// ---------------------------------------------------------------------------
// Runner types — per-case result with publishable/raw boundary
// ---------------------------------------------------------------------------

/**
 * Publishable summary fields for a single eval case result.
 *
 * Contains only metadata and normalized score information — no raw prompt
 * text, no transcript content, no tool arguments, and no raw error details.
 * Safe to commit, publish, or include in CI reports.
 */
export interface CaseResultSummary {
  /** The eval case ID. */
  caseId: string;
  /** The model identifier used for this run. */
  modelId: string;
  /** The suite this case belongs to (`"loom-routing"` | `"tapestry-execution"` | `"shuttle-execution"` | `"spindle-tools"` | `"pattern-planning"` | `"weft-review"` | `"warp-security"`). */
  suite: string;
  /** Whether the case passed (score >= threshold, required gate satisfied). */
  passed: boolean;
  /** Whether this case was required in its rubric. */
  required: boolean;
  /**
   * Weighted total score in `[0, 1]`.
   * The same value as `NormalizedScoreRecord.weightedTotal`.
   */
  weightedTotal: number;
  /**
   * Per-dimension score summary — scores and applicability only.
   * Rationales are omitted to keep the publishable record small.
   * Include full rationales in `RawCaseResultArtifact` when needed.
   */
  dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  >;
  /** ISO 8601 timestamp when the run was scored. */
  scoredAt: string;
  /**
   * Whether this result was produced by a dry-run (no model was called).
   * Dry-run results have zero scores and are for workload inspection only.
   */
  dryRun: boolean;
  /**
   * Optional bounded public explanation for why this case received its score bucket.
   *
   * Generated deterministically from allowlisted structured inputs only:
   * pass/fail booleans, score buckets, outcome kind enums, required flags,
   * and rubric metadata. NEVER derived from raw model output, rationale strings,
   * transcript content, chain-of-thought text, prompt text, or LLM-generated
   * freeform summaries.
   *
   * When present: bounded to `EXPLANATION_MAX_CHARS`, source-attributed, and
   * validated to contain no forbidden patterns.
   * When absent: the score bucket and passed/failed boolean are self-explanatory.
   */
  publicExplanation?: {
    /** The explanation text (bounded, sanitized). */
    text: string;
    /** The declared source of the explanation text. */
    source: "score_bucket_label" | "structured_signal" | "rubric_template";
  };
}

/**
 * Local-only raw artifact for a single eval case result.
 *
 * Contains transcript content, raw model output, full dimension rationales,
 * and the composed prompt snapshot used for the run.
 *
 * MUST NOT be included in any publishable manifest or committed to version
 * control. Only produced when `EvalRunRequest.rawArtifacts === true`.
 */
export interface RawCaseResultArtifact {
  /** The eval case ID. */
  caseId: string;
  /** The model identifier used for this run. */
  modelId: string;
  /**
   * The full composed prompt text sent to the model.
   * Local-only; never publish.
   */
  composedPrompt: string;
  /**
   * Full ordered transcript of the run (all messages, including content).
   * Local-only; never publish.
   */
  transcript: TranscriptMessage[];
  /**
   * The raw assistant response text.
   * Local-only; never publish.
   */
  rawContent: string;
  /**
   * Full dimension rationales (one per applicable dimension).
   * Omitted from publishable summaries.
   * Local-only; never publish.
   */
  dimensionRationales: Partial<Record<ScoringDimension, string>>;
  /**
   * Optional deterministic runner-local diagnostics.
   *
   * Used to explain extraction outcomes without relying on judge rationale or
   * raw freeform interpretation. Local-only; never publish.
   */
  runnerDiagnostics?: {
    /** Artifact identifiers the runner detected from the assistant text. */
    detectedArtifacts: string[];
    /** Required artifact identifiers that the runner did not detect. */
    missingRequiredArtifacts: string[];
    /** Structured Loom routing signals used to explain route extraction outcomes. */
    routingSignals?: {
      /** Raw extracted agent mentions before canonicalization. */
      extractedAgents: string[];
      /** Canonical routed agents after normalizing accepted shuttle variants. */
      canonicalRoutedAgents: string[];
      /** Primary implementation-routing agents used for scoring. */
      primaryRoutedAgents: string[];
      /** Exploratory or evidence-gathering agents kept out of the primary route. */
      exploratoryAgents: string[];
      /** Expected routing target from the fixture. */
      expectedTarget: string;
      /** Accepted routing targets after canonicalization. */
      acceptedTargets: string[];
      /** First primary routing target observed after canonicalization. */
      observedPrimaryTarget?: string;
      /** Bounded classification for local regression triage. */
      classification:
        | "matched-primary-target"
        | "acceptable-but-nonprimary-exploratory-route"
        | "wrong-primary-target"
        | "extraction-miss";
    };
    /** Structured planning-signal booleans and counts used by the runner. */
    planningSignals?: {
      scopeExplicit: boolean;
      fileBackedTasks: boolean;
      sequencingExplicit: boolean;
      acceptanceCoverage: boolean;
      taskCount: number;
      fileCount: number;
      acceptanceCount: number;
    };
  };
  /**
   * Bounded error summary, if the run or scoring step failed.
   *
   * Uses `RawErrorSummary` (not a raw string) to enforce a type-level cap
   * on what error information is stored. Raw stack traces, provider response
   * bodies, and arbitrary strings are never stored here.
   * Local-only; never publish.
   */
  errorSummary?: RawErrorSummary;
}

/**
 * The complete per-case result produced by a runner.
 *
 * Contains both a publishable `summary` and an optional local-only
 * `rawArtifact`. Runners always populate `summary`; `rawArtifact` is only
 * populated when `rawArtifacts` mode is explicitly enabled.
 *
 * Callers that write publishable output MUST only serialize the `summary`
 * field and discard (or locally persist) `rawArtifact`.
 */
export interface CaseResult {
  /** Publishable summary — safe to commit, report, or publish. */
  summary: CaseResultSummary;
  /**
   * Local-only raw artifact — only present when `rawArtifacts` mode is on.
   * MUST NOT appear in any publishable manifest.
   */
  rawArtifact?: RawCaseResultArtifact;
}

/**
 * Typed errors produced by eval runners.
 *
 * All runner failures are returned as `Result` / `ResultAsync` values —
 * no exceptions propagate from runners to callers.
 */
export type RunnerError =
  | {
      /**
       * A suite outside the shared eval suite registry was targeted.
       *
       * This is a fail-closed guard: dry runs and live runs may only execute
       * suites declared in `EVAL_SUITE_REGISTRY`.
       */
      type: "UnknownEvalSuite";
      suite: string;
      message: string;
    }
  | {
      /**
       * No cases were found for the requested suite (after filters applied).
       *
       * Returned when the case set is empty — either the suite has no fixture
       * files, or the applied `--case` filter eliminated all cases.
       */
      type: "NoCasesFound";
      /** The suite name(s) that yielded no cases. */
      suite: string;
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * A case filter value (`--case`) did not match any loaded case fixture.
       *
       * Distinct from `NoCasesFound` — the fixture files exist but none match
       * the supplied filter identifier.
       */
      type: "CaseFilterNotFound";
      /** The filter value that did not match. */
      caseId: string;
      /** Human-readable description. */
      message: string;
    }
  | {
      /**
       * The fixture loading step failed (file not found, parse error, or
       * schema validation failure).
       */
      type: "FixtureLoadError";
      /** Human-readable description. */
      message: string;
      /** The underlying `FixtureSchemaError` that caused the failure. */
      cause: FixtureSchemaError;
    }
  | {
      /**
       * An individual case run or scoring step produced an error.
       *
       * The runner accumulates per-case errors and continues executing
       * remaining cases. This variant is placed in `CaseResult.summary`
       * with zero scores. The full error detail is in `rawArtifact` when
       * `rawArtifacts` mode is on.
       */
      type: "CaseExecutionError";
      /** The case that errored. */
      caseId: string;
      /** The model ID the run was targeting. */
      modelId: string;
      /** Human-readable description (no raw content). */
      message: string;
    }
  | {
      /**
       * The prompt provider failed to compose the agent prompt.
       *
       * Returned when the `PromptProvider` returns an error before any model
       * calls are made. No cases are executed. No model is called.
       *
       * This is a hard failure — the runner will not fall back to a hardcoded
       * prompt. Use the `loomSystemPrompt` / `tapestrySystemPrompt` test-only
       * constructor options to bypass the provider in isolated tests.
       */
      type: "PromptProviderFailed";
      /** The agent name for which prompt composition failed. */
      agentName: string;
      /** Human-readable description (no raw provider error text). */
      message: string;
    };

/**
 * The aggregated result of a runner execution.
 *
 * Runners return one `RunnerResult` per suite execution. Per-case results
 * are accumulated in `caseResults`. A suite is considered green when all
 * `required` cases have `passed === true`.
 */
export interface RunnerResult {
  /** The suite name this result corresponds to. */
  suite: string;
  /**
   * Whether all required cases passed.
   * `true` iff every `CaseResult.summary` where `required === true` has
   * `passed === true`.
   */
  suiteGreen: boolean;
  /** Ordered list of per-case results (one per case × model pair). */
  caseResults: CaseResult[];
  /**
   * Total number of cases executed (including failures).
   */
  totalCases: number;
  /**
   * Number of cases that passed.
   */
  passedCases: number;
  /**
   * Number of cases that failed.
   */
  failedCases: number;
  /** ISO 8601 timestamp when the runner completed. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Provenance error types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Eval run bundle — publishable multi-artifact bundle types
// ---------------------------------------------------------------------------

/**
 * A single score file entry in a publishable eval bundle.
 *
 * Contains the sanitized per-case score records for a single suite.
 * No raw content, rationales, or transcript fields are present.
 */
export interface BundleScoreFile {
  /** The eval suite name (`"loom-routing"` | `"tapestry-execution"` | `"shuttle-execution"` | `"spindle-tools"` | `"pattern-planning"` | `"weft-review"` | `"warp-security"`). */
  suite: string;
  /** ISO 8601 timestamp when the bundle was assembled. */
  assembledAt: string;
  /** Git SHA at bundle assembly time. `"unknown"` when not determinable. */
  gitSha: string;
  /** Whether this was a dry-run (no model calls were made). */
  dryRun: boolean;
  /** Ordered sanitized per-case result summaries. */
  results: Array<{
    caseId: string;
    modelId: string;
    passed: boolean;
    required: boolean;
    weightedTotal: number;
    dimensionScores: Record<string, { score: number; applicable: boolean }>;
    scoredAt: string;
    dryRun: boolean;
    /** Optional bounded public explanation (allowlisted structured-signal text only). */
    publicExplanation?: {
      text: string;
      source: "score_bucket_label" | "structured_signal" | "rubric_template";
    };
  }>;
  /** Aggregate pass/fail totals. */
  totals: {
    totalCases: number;
    passedCases: number;
    failedCases: number;
    suiteGreen: boolean;
  };
}

/**
 * Prompt hash records for a publishable bundle.
 *
 * Contains the stable SHA-256 hashes of composed prompts for each agent,
 * captured at bundle assembly time. Raw prompt text is never present.
 */
export interface BundlePromptHashRecord {
  /** The agent name. */
  agentName: string;
  /** SHA-256 hex digest of the composed prompt. */
  hash: string;
  /** Byte length of the composed prompt. */
  byteLength: number;
  /** Character length of the composed prompt. */
  charLength: number;
  /** Human-readable provenance summary (no raw content). */
  summary: string;
}

/**
 * The provenance manifest section of a publishable bundle.
 *
 * A compact, publishable reference to the full provenance manifest. The
 * full manifest JSON is written separately as `provenance-manifest.json`.
 */
export interface BundleProvenanceRef {
  /** Path of the full provenance manifest file relative to the bundle root. */
  manifestPath: string;
  /** Git SHA at capture time. */
  gitSha: string;
  /** ISO 8601 timestamp when provenance was captured. */
  capturedAt: string;
  /** Number of agent records in the manifest. */
  agentCount: number;
}

/**
 * A publishable eval result bundle.
 *
 * The bundle aggregates all publishable artifacts from a single eval run:
 *   - `runSummary`: aggregate run metadata (suite, counts, timestamps)
 *   - `scoreFiles`: per-suite sanitized score records
 *   - `promptHashRecords`: stable hashes of composed prompts (no raw text)
 *   - `provenanceRef`: reference to the full provenance manifest
 *
 * The bundle is assembled by `ArtifactBundleWriter` and written to a
 * deterministic directory layout for external repository publication.
 *
 * NO raw prompt text, transcript content, tool arguments, env values,
 * error payloads, or log tails are present in any bundle field.
 */
export interface EvalBundle {
  /** Bundle schema version (positive integer). */
  version: number;
  /** ISO 8601 timestamp when the bundle was assembled. */
  assembledAt: string;
  /** Git SHA at assembly time. `"unknown"` when not determinable. */
  gitSha: string;
  /** Whether this bundle represents a dry-run (no model calls). */
  dryRun: boolean;
  /**
   * Aggregate run summary.
   * Safe to publish: no raw content.
   */
  runSummary: {
    /** Total cases executed across all suites. */
    totalCases: number;
    /** Total passing cases. */
    passedCases: number;
    /** Total failing cases. */
    failedCases: number;
    /** Whether all required cases passed. */
    allSuitesGreen: boolean;
    /** Names of the suites included in this bundle. */
    suites: string[];
  };
  /** Per-suite sanitized score files. */
  scoreFiles: BundleScoreFile[];
  /** Stable prompt hash records (one per agent; no raw text). */
  promptHashRecords: BundlePromptHashRecord[];
  /** Reference to the full provenance manifest. */
  provenanceRef: BundleProvenanceRef | null;
}

/**
 * Typed errors produced by `ArtifactBundleWriter`.
 */
export type BundleError =
  | {
      type: "BundleWriteError";
      /** The path that could not be written. */
      path: string;
      message: string;
    }
  | {
      type: "BundleSanitizationError";
      /** Human-readable sanitization failure. */
      message: string;
      /** The field that triggered the violation. */
      field?: string;
    }
  | {
      type: "PublishTokenMissing";
      /** Name of the required environment variable. */
      envVar: string;
      message: string;
    }
  | {
      type: "PublishPolicyViolation";
      message: string;
    };

// ---------------------------------------------------------------------------
// Raw artifacts writer types
// ---------------------------------------------------------------------------

/**
 * Typed errors produced by the `RawArtifactsWriter`.
 */
export type RawArtifactWriteError =
  | {
      type: "RawArtifactWriteError";
      path: string;
      message: string;
    }
  | {
      type: "RawArtifactsDisabled";
      message: string;
    };

// ---------------------------------------------------------------------------
// Results repo types
// ---------------------------------------------------------------------------

/**
 * Configuration for the external results repository publisher.
 *
 * The external repo is a separate git repository that receives publishable
 * eval result bundles. Authentication is token-gated; publishing without
 * a valid token is rejected at the policy enforcement point.
 */
export interface ResultsRepoConfig {
  /**
   * The HTTPS URL of the external results repository.
   * Must start with `https://`.
   */
  repoUrl: string;
  /**
   * The branch to push bundle commits to.
   * Defaults to `"main"` when omitted.
   */
  branch?: string;
  /**
   * The directory within the external repo where bundles are written.
   * Defaults to `"evals/"` when omitted.
   */
  bundleDir?: string;
}

/**
 * Typed errors produced by the `ResultsRepoPublisher`.
 */
export type ResultsRepoError =
  | {
      type: "TokenMissing";
      /** The environment variable name that was absent or empty. */
      envVar: string;
      message: string;
    }
  | {
      type: "RepoConfigInvalid";
      message: string;
    }
  | {
      type: "PublishFailed";
      message: string;
    }
  | {
      type: "DryRunPublishBlocked";
      message: string;
    }
  | {
      /**
       * The bundle has no score files and therefore cannot be published.
       *
       * Distinct from `DryRunPublishBlocked` — the bundle is a real (non-dry)
       * run but contains no score data to publish. This is a programming or
       * pipeline error: bundles must always contain at least one score file
       * before being submitted to the publisher.
       */
      type: "NoScoreFilesToPublish";
      message: string;
    }
  | {
      type: "UnsanitizedBundleBlocked";
      message: string;
      field: string;
    };

// ---------------------------------------------------------------------------
// Provenance error types
// ---------------------------------------------------------------------------

/**
 * Errors that can occur during prompt snapshot composition or provenance
 * record derivation.
 */
export type ProvenanceError =
  | {
      type: "PromptCompositionError";
      agentName: string;
      message: string;
    }
  | {
      type: "HashComputationError";
      agentName: string;
      message: string;
    }
  | {
      type: "GitShaResolutionError";
      message: string;
    }
  | {
      type: "ConfigLoadError";
      message: string;
    }
  | {
      type: "ManifestWriteError";
      path: string;
      message: string;
    };
