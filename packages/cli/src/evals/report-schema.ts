/**
 * Versioned public reporting schemas for the Weave agent evals dashboard.
 *
 * # Design Principles
 *
 * All public report schemas enforce a strict sanitization envelope. Every
 * explanation field in every public artifact is:
 *
 *   - **Bounded**: truncated at `EXPLANATION_MAX_CHARS` to prevent growth from
 *     arbitrary model output.
 *   - **Allowlisted by source**: only accepted via an `ExplanationSource` enum,
 *     never directly from raw transcript text, raw model output, rationale
 *     strings, chain-of-thought traces, or prompt text.
 *   - **Free of forbidden markers**: validated against `FORBIDDEN_EXPLANATION_PATTERNS`
 *     which reject raw rationale markers, chain-of-thought markers, prompt
 *     delimiters, secret-like patterns, and transcript role markers.
 *
 * # Explanation Field Rules
 *
 * The following are categorically rejected as explanation inputs:
 *
 *   1. Raw transcript content — any text derived from `TranscriptMessage.content`
 *      or `ModelRunOutput.rawContent`.
 *   2. Raw rationale strings — the `DimensionScore.rationale` field from scorer
 *      output (these are stripped before any report is assembled).
 *   3. Chain-of-thought text — text blocks containing `<thinking>`, `<cot>`,
 *      or similar markers that expose internal model reasoning.
 *   4. Prompt text — any string sourced from composed prompt buffers or the
 *      raw prompt artifact.
 *   5. LLM freeform summaries — generated text from any model pass over raw
 *      eval content (this is categorically forbidden in the pipeline).
 *
 * # Schema Versions
 *
 * All public schemas carry a `schemaVersion` field (positive integer) as the
 * first key. Downstream consumers MUST reject schemas whose `schemaVersion`
 * they do not recognise. `schemaVersion` increments are backward-incompatible.
 *
 * # Module Boundaries
 *
 * This module owns only the Zod schemas and inferred types for public report
 * artifacts. It does NOT:
 *   - Call the sanitizer directly (callers do that before feeding data here).
 *   - Import runner types (`RunnerResult`, `ModelRunOutput`, etc.).
 *   - Perform file I/O.
 *
 * Callers must sanitize their data through `sanitizer.ts` before validating
 * with these schemas. The schemas serve as the final gate that enforces shape
 * and rejects forbidden patterns.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character length for any explanation field in a public report.
 *
 * Explanations exceeding this limit MUST be truncated before passing to the
 * schema. The schema rejects overlong strings to prevent unbounded growth
 * from arbitrary text sources.
 *
 * Truncation is caller-owned (use `truncateExplanation()` in `sanitizer.ts`).
 */
export const EXPLANATION_MAX_CHARS = 300;

/**
 * Current schema version for public report bundle (`PublicReportBundle`).
 */
export const REPORT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Current schema version for suite summary (`SuiteSummaryEntry`).
 */
export const SUITE_SUMMARY_SCHEMA_VERSION = 1;

/**
 * Current schema version for dashboard entry manifest (`DashboardManifest`).
 */
export const DASHBOARD_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Current schema version for suite history manifest (`SuiteHistoryManifest`).
 */
export const SUITE_HISTORY_SCHEMA_VERSION = 1;

/**
 * Current schema version for model-comparison manifest (`ModelComparisonManifest`).
 */
export const MODEL_COMPARISON_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Forbidden explanation patterns
// ---------------------------------------------------------------------------

/**
 * Regex patterns that MUST NOT appear in any explanation field.
 *
 * These patterns detect raw text leakage from:
 *   - Chain-of-thought traces (`<thinking>`, `<cot>`, `<reasoning>`)
 *   - Transcript role markers (`\nUser:`, `\nAssistant:`, `Human:`, etc.)
 *   - Prompt delimiters (`<system>`, `<prompt>`, `---`, `===`)
 *   - Raw rationale markers (`rationale:`, `score:`, `justification:`)
 *   - Secret-like patterns (tokens, API keys, bearer values)
 *   - Chain-of-thought markers in various formats
 *   - HTML injection vectors (script, style, iframe, event handlers,
 *     javascript: URIs, data: URIs, object/embed/form tags)
 *
 * The HTML injection patterns are added as the primary XSS / rendering
 * policy guard. Explanation text is rendered in:
 *   - `public-report.md` (Markdown table cells — download-only artifact)
 *   - `public-report.json` (JSON field — consumed by dashboard UI)
 *
 * Even though `public-report.md` is served as a plain-text download (not
 * rendered as HTML), and `public-report.json` values are escaped by the
 * dashboard UI before `innerHTML` assignment, we apply belt-and-suspenders
 * rejection here at the schema level so that HTML injection payloads never
 * reach any rendering surface, regardless of how consumers handle the data.
 *
 * When any pattern matches, the explanation is rejected with a typed error.
 * Callers must sanitize inputs before passing to schema validation.
 */
export const FORBIDDEN_EXPLANATION_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  {
    name: "chain_of_thought_xml",
    // Matches opening tags: <thinking>, <cot>, <reasoning>, <scratchpad>
    pattern: /<(?:thinking|cot|reasoning|scratchpad)\s*>/i,
  },
  {
    name: "transcript_role_marker",
    // Matches transcript role labels at line start or after newline
    pattern: /(?:^|\n)(?:User|Human|Assistant|System|Tool)\s*:/,
  },
  {
    name: "prompt_delimiter",
    // Matches common prompt-section delimiters
    pattern: /<(?:system|prompt|instruction|context)\s*>/i,
  },
  {
    name: "raw_rationale_marker",
    // Matches scorer-internal markers that signal raw rationale text
    pattern: /\brationale\s*:/i,
  },
  {
    name: "raw_score_marker",
    // Matches scorer-internal score assignment syntax
    pattern: /\bscore\s*:\s*\d/i,
  },
  {
    name: "justification_marker",
    // Matches explicit justification/explanation labels from scorers
    pattern: /\b(?:justification|explanation)\s*:/i,
  },
  {
    name: "secret_token_pattern",
    // Matches common secret/token patterns (sk-, Bearer, ghp_)
    pattern:
      /(?:sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{10,}|ghp_[A-Za-z0-9]{8,})/,
  },
  // ---------------------------------------------------------------------------
  // HTML injection / XSS patterns
  //
  // The following patterns detect HTML markup that could be interpreted as
  // executable content if the explanation text were rendered in a browser
  // context without strict sanitization. Even though v1 policy treats
  // public-report.md as a download-only artifact (never rendered as HTML),
  // these patterns are blocked at the schema level as belt-and-suspenders
  // defence — independent of how consumers render the data.
  //
  // Policy: explanation text MUST be free of HTML injection vectors. If any
  // of the patterns below match, the explanation is rejected and the field
  // is omitted from the public report (graceful degradation).
  // ---------------------------------------------------------------------------
  {
    name: "html_script_tag",
    // Matches <script> opening tags (case-insensitive, allows whitespace/attrs)
    pattern: /<script[\s>]/i,
  },
  {
    name: "html_style_tag",
    // Matches <style> opening tags
    pattern: /<style[\s>]/i,
  },
  {
    name: "html_iframe_tag",
    // Matches <iframe> opening tags
    pattern: /<iframe[\s>]/i,
  },
  {
    name: "html_object_embed_tag",
    // Matches <object> and <embed> opening tags (plugin content vectors)
    pattern: /<(?:object|embed)[\s>]/i,
  },
  {
    name: "html_form_tag",
    // Matches <form> opening tags (phishing / credential-capture vector)
    pattern: /<form[\s>]/i,
  },
  {
    name: "html_inline_event_handler",
    // Matches HTML inline event handler attributes: onclick=, onerror=, etc.
    // The \b word boundary ensures we don't match "oncourse" or similar words.
    pattern: /\bon\w+\s*=/i,
  },
  {
    name: "html_javascript_uri",
    // Matches javascript: URI scheme (the primary vector for href/src injection)
    pattern: /javascript\s*:/i,
  },
  {
    name: "html_data_uri",
    // Matches data: URI scheme (used for encoded HTML/script content injection)
    pattern: /data\s*:/i,
  },
];

// ---------------------------------------------------------------------------
// Explanation source enum
// ---------------------------------------------------------------------------

/**
 * The allowed sources for explanation field values in public reports.
 *
 * This enum is the primary guard that prevents raw text from entering public
 * reports. Every explanation field MUST declare its source kind. The schema
 * and the sanitizer both validate source kind before accepting explanation text.
 *
 * Permitted sources:
 *   - `"rubric_template"` — text derived from a rubric template literal or
 *     rubric fixture field (static, no LLM generation)
 *   - `"score_bucket_label"` — short label automatically derived from a
 *     numeric score bucket (e.g. `"pass"`, `"partial"`, `"fail"`)
 *   - `"structured_signal"` — structured boolean/enum signal derived from
 *     typed score record fields (e.g. `"routing_matched"`, `"chain_complete"`)
 *   - `"operator_note"` — short freeform note written by a human pipeline
 *     operator at publishing time (NOT LLM-generated, NOT from raw eval content)
 *
 * Explicitly FORBIDDEN sources (the pipeline must reject these):
 *   - Raw rationale strings from `DimensionScore.rationale`
 *   - Raw model output / transcript content
 *   - Chain-of-thought text
 *   - LLM freeform summary passes over eval content
 *   - Prompt text
 */
export const ExplanationSourceSchema = z.enum([
  "rubric_template",
  "score_bucket_label",
  "structured_signal",
  "operator_note",
]);

export type ExplanationSource = z.infer<typeof ExplanationSourceSchema>;

// ---------------------------------------------------------------------------
// Score bucket enum
// ---------------------------------------------------------------------------

/**
 * Discrete score bucket that a numeric weighted-total score maps to.
 *
 * Score buckets replace raw floating-point scores in public-facing summaries,
 * making the report human-interpretable without exposing implementation details.
 *
 * Bucket thresholds (applied in order):
 *   - `"pass"`    — weightedTotal >= 0.9
 *   - `"partial"` — weightedTotal >= 0.5
 *   - `"fail"`    — weightedTotal < 0.5
 *   - `"skip"`    — case was a dry-run or was excluded from this report
 */
export const ScoreBucketSchema = z.enum(["pass", "partial", "fail", "skip"]);

export type ScoreBucket = z.infer<typeof ScoreBucketSchema>;

/**
 * Compute the score bucket for a weighted total score.
 *
 * This is a pure function — no I/O, no side effects.
 *
 * @param weightedTotal - Score in [0, 1]; or undefined for skipped cases.
 * @param dryRun - Whether the case was a dry-run (maps to "skip").
 * @returns The `ScoreBucket` for the given score.
 */
export function computeScoreBucket(
  weightedTotal: number | undefined,
  dryRun: boolean,
): ScoreBucket {
  if (dryRun || weightedTotal === undefined) return "skip";
  if (weightedTotal >= 0.9) return "pass";
  if (weightedTotal >= 0.5) return "partial";
  return "fail";
}

// ---------------------------------------------------------------------------
// Bounded explanation field
// ---------------------------------------------------------------------------

/**
 * A bounded, source-attributed explanation field for public reports.
 *
 * `text` is the explanation string. It:
 *   - Must be non-empty.
 *   - Must not exceed `EXPLANATION_MAX_CHARS` characters.
 *   - Must not match any `FORBIDDEN_EXPLANATION_PATTERNS`.
 *
 * `source` declares where the text came from. Only `ExplanationSource` values
 * are accepted — raw rationale strings, model outputs, and LLM-generated
 * summaries are categorically rejected at this level.
 *
 * Callers must truncate and sanitize text before constructing this object.
 * Use `truncateExplanation()` from `sanitizer.ts` for the truncation step
 * and pass the result directly — do not pass raw model output, rationale
 * strings, or prompt text.
 */
export const BoundedExplanationSchema = z
  .object({
    /**
     * The explanation text.
     *
     * - Non-empty string.
     * - Maximum `EXPLANATION_MAX_CHARS` characters.
     * - No forbidden patterns (raw rationale, chain-of-thought, transcript markers).
     */
    text: z
      .string()
      .min(1, "explanation text must be non-empty")
      .max(
        EXPLANATION_MAX_CHARS,
        `explanation text must not exceed ${EXPLANATION_MAX_CHARS} characters`,
      ),
    /** The declared source of the explanation text. */
    source: ExplanationSourceSchema,
  })
  .superRefine((data, ctx) => {
    for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
      if (pattern.test(data.text)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `explanation text contains a forbidden pattern ("${name}"). ` +
            `Raw transcript content, rationale strings, chain-of-thought traces, ` +
            `prompt text, and LLM freeform summaries are not permitted in ` +
            `public report explanation fields. Use a rubric_template, ` +
            `score_bucket_label, structured_signal, or operator_note instead.`,
          path: ["text"],
        });
        return;
      }
    }
  });

export type BoundedExplanation = z.infer<typeof BoundedExplanationSchema>;

// ---------------------------------------------------------------------------
// Per-case public report entry
// ---------------------------------------------------------------------------

/**
 * A single case entry in a public report suite summary.
 *
 * This is the publishable projection of a scored case result. It contains:
 *   - Identification fields (caseId, modelId, suite)
 *   - A score bucket (not raw float — human-interpretable label)
 *   - A boolean `passed` flag
 *   - An optional bounded explanation (source-attributed and length-capped)
 *   - A dry-run flag
 *
 * No raw prompt text, transcript content, tool arguments, rationale strings,
 * or chain-of-thought markers appear in this record.
 *
 * The schema uses strict mode — unknown keys (including all sensitive fields
 * such as `rationale`, `composedPrompt`, `transcript`, `rawContent`, `prompt`,
 * `toolArgs`, `env`, etc.) are rejected at parse time rather than silently
 * stripped. This ensures that callers must sanitize before passing data here.
 */
export const PublicCaseEntrySchema = z
  .object({
    /** The eval case ID. Must be a non-empty string. */
    caseId: z.string().min(1, "caseId must be non-empty"),
    /** The model identifier used for this run. Must be non-empty. */
    modelId: z.string().min(1, "modelId must be non-empty"),
    /** The eval suite name. Must be non-empty. */
    suite: z.string().min(1, "suite must be non-empty"),
    /**
     * Human-interpretable score bucket derived from the numeric weighted total.
     * Not the raw float — consumers see "pass"/"partial"/"fail"/"skip" only.
     */
    scoreBucket: ScoreBucketSchema,
    /** Whether the case passed (score >= threshold, required gate satisfied). */
    passed: z.boolean(),
    /** Whether this case was required in its rubric. */
    required: z.boolean(),
    /** Whether this result was produced by a dry-run (no model was called). */
    dryRun: z.boolean(),
    /**
     * Optional bounded explanation for why this case was bucketed this way.
     *
     * When present: must satisfy `BoundedExplanationSchema` — length-capped,
     * source-attributed, no forbidden patterns.
     *
     * When absent: the score bucket and passed/failed boolean are self-explanatory
     * and no further explanation is provided.
     *
     * NEVER populated from raw rationale text, transcript content, or LLM output.
     */
    explanation: BoundedExplanationSchema.optional(),
    /** ISO 8601 timestamp when the run was scored. */
    scoredAt: z.string().min(1, "scoredAt must be non-empty"),
  })
  .strict();

export type PublicCaseEntry = z.infer<typeof PublicCaseEntrySchema>;

// ---------------------------------------------------------------------------
// Suite summary entry
// ---------------------------------------------------------------------------

/**
 * A public summary entry for one eval suite.
 *
 * Published as `suite-summary-<name>.json` in the dashboard tree.
 * Contains aggregate counts and per-case entries for one suite.
 *
 * The schema uses strict mode — unknown keys (including sensitive fields
 * such as `rationale`, `composedPrompt`, `rawContent`, `transcript`, etc.)
 * cause parse failures rather than being silently stripped.
 */
export const SuiteSummaryEntrySchema = z
  .object({
    /**
     * Schema version for this record type.
     * Consumers MUST reject `schemaVersion` values they do not recognise.
     */
    schemaVersion: z
      .number()
      .int()
      .positive()
      .refine((v) => v === SUITE_SUMMARY_SCHEMA_VERSION, {
        message: `schemaVersion must be ${SUITE_SUMMARY_SCHEMA_VERSION} for SuiteSummaryEntry`,
      }),
    /** The eval suite name (e.g. `"loom-routing"`, `"tapestry-execution"`). */
    suite: z.string().min(1, "suite must be non-empty"),
    /** ISO 8601 timestamp when this summary was assembled. */
    assembledAt: z.string().min(1, "assembledAt must be non-empty"),
    /** Git SHA at assembly time. `"unknown"` when not determinable. */
    gitSha: z.string().min(1, "gitSha must be non-empty"),
    /** Total cases in this suite. */
    totalCases: z.number().int().nonnegative(),
    /** Number of cases that passed. */
    passedCases: z.number().int().nonnegative(),
    /** Number of cases that failed. */
    failedCases: z.number().int().nonnegative(),
    /** Whether all required cases passed. */
    suiteGreen: z.boolean(),
    /**
     * Optional bounded explanation summarising the suite outcome.
     *
     * Derived exclusively from aggregate counts, pass-rate bucket, and suite
     * green status — never from raw model output, rationale strings, transcript
     * content, chain-of-thought text, prompt text, or LLM-generated summaries.
     *
     * When present: must satisfy `BoundedExplanationSchema` — length-capped,
     * source-attributed, no forbidden patterns.
     * When absent: the suiteGreen flag and pass/fail counts are self-explanatory.
     */
    explanation: BoundedExplanationSchema.optional(),
    /** Ordered per-case public entries. */
    cases: z.array(PublicCaseEntrySchema),
  })
  .strict();

export type SuiteSummaryEntry = z.infer<typeof SuiteSummaryEntrySchema>;

// ---------------------------------------------------------------------------
// Public report bundle
// ---------------------------------------------------------------------------

/**
 * The top-level public report bundle.
 *
 * Published as `runs/v1/<runId>/public-report.json` in the dashboard tree. Aggregates
 * all suite summaries and run-level metadata for one eval run.
 *
 * # Safety contract
 *
 * NO raw prompt text, transcript content, tool arguments, rationale strings,
 * chain-of-thought markers, secret patterns, or LLM-generated summaries
 * appear in any field of this object or its nested structures.
 *
 * `explanation` fields (when present) are limited to bounded, source-attributed
 * values — see `BoundedExplanationSchema`.
 *
 * The schema uses strict mode — unknown keys (including all fields in
 * `SENSITIVE_FIELD_NAMES` such as `rationale`, `composedPrompt`, `rawContent`,
 * `transcript`, `toolArgs`, `env`, etc.) cause parse failures rather than
 * being silently stripped.
 */
export const PublicReportBundleSchema = z
  .object({
    /**
     * Schema version for this record type.
     * Consumers MUST reject `schemaVersion` values they do not recognise.
     */
    schemaVersion: z
      .number()
      .int()
      .positive()
      .refine((v) => v === REPORT_BUNDLE_SCHEMA_VERSION, {
        message: `schemaVersion must be ${REPORT_BUNDLE_SCHEMA_VERSION} for PublicReportBundle`,
      }),
    /** ISO 8601 timestamp when the bundle was assembled. */
    assembledAt: z.string().min(1, "assembledAt must be non-empty"),
    /** Git SHA at assembly time. `"unknown"` when not determinable. */
    gitSha: z.string().min(1, "gitSha must be non-empty"),
    /** Whether this bundle represents a dry-run (no model calls). */
    dryRun: z.boolean(),
    /**
     * Aggregate run summary — pass/fail counts and green status.
     * No raw content of any kind.
     */
    runSummary: z
      .object({
        /** Total cases executed across all suites. */
        totalCases: z.number().int().nonnegative(),
        /** Total passing cases. */
        passedCases: z.number().int().nonnegative(),
        /** Total failing cases. */
        failedCases: z.number().int().nonnegative(),
        /** Whether all required cases across all suites passed. */
        allSuitesGreen: z.boolean(),
        /** Names of suites included in this bundle. */
        suites: z.array(z.string().min(1)),
      })
      .strict(),
    /** Per-suite public summaries. */
    suiteSummaries: z.array(SuiteSummaryEntrySchema),
  })
  .strict();

export type PublicReportBundle = z.infer<typeof PublicReportBundleSchema>;

// ---------------------------------------------------------------------------
// Dashboard manifest
// ---------------------------------------------------------------------------

/**
 * A single entry in the dashboard run index.
 *
 * Each entry describes one eval run and points to its bundle files.
 * Published in the top-level dashboard index (`dashboard-manifest.json`).
 *
 * The schema uses strict mode — unknown keys are rejected at parse time
 * rather than being silently stripped.
 */
export const DashboardEntrySchema = z
  .object({
    /**
     * Unique run identifier.
     * Typically `<gitSha[0..7]>-<YYYY-MM-DD>-<NNN>` (same as immutable run directory name).
     * Must be non-empty and contain no path separators or whitespace.
     */
    runId: z
      .string()
      .min(1, "runId must be non-empty")
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "runId must contain only alphanumerics, dots, underscores, or hyphens",
      ),
    /** ISO 8601 timestamp when the run was assembled. */
    assembledAt: z.string().min(1, "assembledAt must be non-empty"),
    /** Git SHA for this run. `"unknown"` when not determinable. */
    gitSha: z.string().min(1, "gitSha must be non-empty"),
    /** Whether this was a dry-run (no model calls). */
    dryRun: z.boolean(),
    /** Whether all required cases passed in this run. */
    allSuitesGreen: z.boolean(),
    /** Total cases executed in this run. */
    totalCases: z.number().int().nonnegative(),
    /** Total passing cases in this run. */
    passedCases: z.number().int().nonnegative(),
    /** Total failing cases in this run. */
    failedCases: z.number().int().nonnegative(),
    /** Names of suites included in this run. */
    suites: z.array(z.string().min(1)),
    /** Relative path to the public-report.json for this run. */
    bundleReportPath: z.string().min(1, "bundleReportPath must be non-empty"),
  })
  .strict();

export type DashboardEntry = z.infer<typeof DashboardEntrySchema>;

/**
 * The top-level dashboard entry manifest.
 *
 * Published as `dashboard-manifest.json` at the root of the external results
 * repo. Lists all known eval runs in reverse-chronological order (newest first).
 *
 * The manifest itself carries no raw content — only run-level aggregate
 * metadata and paths.
 *
 * The schema uses strict mode — unknown keys are rejected at parse time
 * rather than being silently stripped.
 */
export const DashboardManifestSchema = z
  .object({
    /**
     * Schema version for this record type.
     * Consumers MUST reject `schemaVersion` values they do not recognise.
     */
    schemaVersion: z
      .number()
      .int()
      .positive()
      .refine((v) => v === DASHBOARD_MANIFEST_SCHEMA_VERSION, {
        message: `schemaVersion must be ${DASHBOARD_MANIFEST_SCHEMA_VERSION} for DashboardManifest`,
      }),
    /** ISO 8601 timestamp when this manifest was last updated. */
    updatedAt: z.string().min(1, "updatedAt must be non-empty"),
    /** Total number of runs in the index. */
    totalRuns: z.number().int().nonnegative(),
    /** Run entries, newest-first. */
    runs: z.array(DashboardEntrySchema),
  })
  .strict();

export type DashboardManifest = z.infer<typeof DashboardManifestSchema>;

// ---------------------------------------------------------------------------
// Suite history manifest
// ---------------------------------------------------------------------------

/**
 * A single historical data point for a suite's aggregate pass rate.
 *
 * Used to build pass-rate trend charts in the dashboard.
 *
 * The schema uses strict mode — unknown keys are rejected at parse time.
 */
export const SuiteHistoryPointSchema = z
  .object({
    /** ISO 8601 timestamp for this data point. */
    assembledAt: z.string().min(1, "assembledAt must be non-empty"),
    /** Git SHA for this data point. */
    gitSha: z.string().min(1, "gitSha must be non-empty"),
    /** Run ID corresponding to this data point. */
    runId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    /** Total cases in this run for this suite. */
    totalCases: z.number().int().nonnegative(),
    /** Passing cases in this run for this suite. */
    passedCases: z.number().int().nonnegative(),
    /** Whether all required cases passed (suite green status). */
    suiteGreen: z.boolean(),
    /**
     * Pass rate in [0.0, 1.0].
     * `null` when `totalCases === 0` (no cases ran).
     */
    passRate: z.union([z.number().min(0).max(1), z.null()]),
  })
  .strict();

export type SuiteHistoryPoint = z.infer<typeof SuiteHistoryPointSchema>;

/**
 * Suite history manifest for one eval suite.
 *
 * Published as `suite-history-<suiteName>.json` in the dashboard tree.
 * Contains the ordered time series of aggregate pass-rate data points for
 * one suite across multiple eval runs.
 *
 * No per-case or per-model detail appears in this record.
 *
 * The schema uses strict mode — unknown keys are rejected at parse time.
 */
export const SuiteHistoryManifestSchema = z
  .object({
    /**
     * Schema version for this record type.
     * Consumers MUST reject `schemaVersion` values they do not recognise.
     */
    schemaVersion: z
      .number()
      .int()
      .positive()
      .refine((v) => v === SUITE_HISTORY_SCHEMA_VERSION, {
        message: `schemaVersion must be ${SUITE_HISTORY_SCHEMA_VERSION} for SuiteHistoryManifest`,
      }),
    /** The eval suite name. */
    suite: z.string().min(1, "suite must be non-empty"),
    /** ISO 8601 timestamp when this manifest was last updated. */
    updatedAt: z.string().min(1, "updatedAt must be non-empty"),
    /** History data points, oldest-first. */
    history: z.array(SuiteHistoryPointSchema),
  })
  .strict();

export type SuiteHistoryManifest = z.infer<typeof SuiteHistoryManifestSchema>;

// ---------------------------------------------------------------------------
// Model comparison manifest
// ---------------------------------------------------------------------------

/**
 * A single model's aggregate performance entry in a comparison manifest.
 *
 * Used to build model-comparison tables and radar charts.
 *
 * The schema uses strict mode — unknown keys are rejected at parse time.
 */
export const ModelComparisonEntrySchema = z
  .object({
    /** Fully-qualified model identifier (e.g. `"anthropic/claude-sonnet-4-5"`). */
    modelId: z.string().min(1, "modelId must be non-empty"),
    /** Human-readable display name for this model. */
    displayName: z.string().min(1, "displayName must be non-empty"),
    /** Total cases run for this model in this report. */
    totalCases: z.number().int().nonnegative(),
    /** Passing cases for this model. */
    passedCases: z.number().int().nonnegative(),
    /** Failing cases for this model. */
    failedCases: z.number().int().nonnegative(),
    /**
     * Pass rate in [0.0, 1.0].
     * `null` when no cases were run for this model.
     */
    passRate: z.union([z.number().min(0).max(1), z.null()]),
    /**
     * Per-suite pass rates for this model.
     * Keys are suite names; values are pass rates in [0.0, 1.0] or null.
     */
    perSuitePassRates: z.record(
      z.string().min(1),
      z.union([z.number().min(0).max(1), z.null()]),
    ),
    /** Overall score bucket for this model across all suites. */
    overallBucket: ScoreBucketSchema,
    /**
     * Optional bounded explanation summarising this model's overall performance.
     *
     * Derived exclusively from aggregate counts, pass-rate bucket, and the
     * overall score bucket — never from raw model output, rationale strings,
     * transcript content, chain-of-thought text, prompt text, or LLM-generated
     * summaries.
     *
     * When present: must satisfy `BoundedExplanationSchema` — length-capped,
     * source-attributed, no forbidden patterns.
     * When absent: the overallBucket and pass/fail counts are self-explanatory.
     */
    explanation: BoundedExplanationSchema.optional(),
  })
  .strict();

export type ModelComparisonEntry = z.infer<typeof ModelComparisonEntrySchema>;

/**
 * Model-comparison manifest for one eval run.
 *
 * Published as `model-comparison-<runId>.json` in the dashboard tree.
 * Contains per-model aggregate performance data for one run so consumers
 * can compare models without loading per-case data.
 *
 * No case-level detail, no rationale strings, and no raw content appear here.
 *
 * The schema uses strict mode — unknown keys are rejected at parse time.
 */
export const ModelComparisonManifestSchema = z
  .object({
    /**
     * Schema version for this record type.
     * Consumers MUST reject `schemaVersion` values they do not recognise.
     */
    schemaVersion: z
      .number()
      .int()
      .positive()
      .refine((v) => v === MODEL_COMPARISON_SCHEMA_VERSION, {
        message: `schemaVersion must be ${MODEL_COMPARISON_SCHEMA_VERSION} for ModelComparisonManifest`,
      }),
    /** Run ID for this comparison. */
    runId: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+$/),
    /** ISO 8601 timestamp when this manifest was assembled. */
    assembledAt: z.string().min(1, "assembledAt must be non-empty"),
    /** Git SHA for this run. */
    gitSha: z.string().min(1, "gitSha must be non-empty"),
    /** Whether this run was a dry-run. */
    dryRun: z.boolean(),
    /** Per-model comparison entries. */
    models: z.array(ModelComparisonEntrySchema),
  })
  .strict();

export type ModelComparisonManifest = z.infer<
  typeof ModelComparisonManifestSchema
>;

// ---------------------------------------------------------------------------
// Schema error types
// ---------------------------------------------------------------------------

/**
 * Typed errors produced when public report schema validation fails.
 */
export type ReportSchemaError =
  | {
      type: "SchemaVersionMissing";
      message: string;
    }
  | {
      type: "SchemaVersionUnrecognised";
      found: number;
      expected: number;
      message: string;
    }
  | {
      type: "ExplanationForbiddenPattern";
      /** The pattern name that matched. */
      patternName: string;
      message: string;
    }
  | {
      type: "ExplanationTooLong";
      /** The actual length of the explanation text. */
      actualLength: number;
      /** The maximum allowed length. */
      maxLength: number;
      message: string;
    }
  | {
      type: "ExplanationSourceForbidden";
      /**
       * A descriptor of the forbidden source (e.g. `"raw_rationale"`,
       * `"transcript_content"`, `"llm_freeform_summary"`).
       */
      sourceDescriptor: string;
      message: string;
    }
  | {
      type: "SchemaValidationFailed";
      /** Human-readable summary of validation failures. */
      message: string;
      /** Raw Zod issue list for structured inspection. */
      issues: Array<{ path: string; message: string }>;
    };
