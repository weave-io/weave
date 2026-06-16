/**
 * Central allowlist sanitizer for publishable eval bundle artifacts.
 *
 * This module owns the single source of truth for which fields are permitted
 * in any publishable output. All other modules in the eval pipeline that
 * produce publishable artifacts MUST route through this sanitizer before
 * writing to disk or to an external repository.
 *
 * # Allowlist design
 *
 * Serialization is **allowlist-first**: only fields declared in an explicit
 * allowlist are written to publishable output. Unknown fields are silently
 * dropped so that future runner additions cannot accidentally leak sensitive
 * data by adding a new field without a corresponding sanitizer update.
 *
 * # Redaction rules
 *
 * The following subfields are ALWAYS redacted from publishable output:
 *
 *   - **Tool arguments** (`toolArgs`, `arguments`, `tool_arguments`, `args`
 *     inside any tool-call-related structure) — tool arguments may contain
 *     file paths, credentials, or user-specific data.
 *   - **Environment values** (`env`, `environment`, `envValue`, `envVar`
 *     objects beyond the name) — environment variable values are secrets.
 *   - **Error payloads** (`cause`, `body`, `rawBody`, `errorBody`) — raw
 *     provider error bodies may contain API keys, quota messages, or
 *     internal URLs.
 *   - **Log tails** (`logTail`, `logs`, `logLines`) — log output may contain
 *     secrets or PII from model providers.
 *   - **Raw prompt text** (`composedPrompt`, `rawContent`, `transcript` field
 *     message content when in a publishable path) — prompt text is
 *     local-only.
 *   - **Rationales** (`rationale`) — dimension rationales are local-only.
 *     Only `score` and `applicable` are kept in publishable score records.
 *
 * # Determinism
 *
 * Sanitized output is deterministic: the same input with the same allowlist
 * always produces byte-for-byte identical output. Field insertion order
 * follows the allowlist declaration order.
 *
 * # Publish-mode guard
 *
 * `assertPublishSafe()` is the policy enforcement point. It must be called
 * before any write in publish mode. It rejects:
 *   - Sanitizer bypass attempts (passing raw/unsanitized data directly)
 *   - Objects that contain any known-sensitive field names at the top level
 *   - The `rawArtifact` field being present in any publishable object
 */

import { err, ok, type Result } from "neverthrow";
import {
  type BoundedExplanation,
  EXPLANATION_MAX_CHARS,
  type ExplanationSource,
  FORBIDDEN_EXPLANATION_PATTERNS,
  type ReportSchemaError,
} from "./report-schema.js";
import type {
  CaseResultSummary,
  NormalizedScoreRecord,
  PromptProvenanceManifest,
  PromptProvenanceRecord,
  ScoringDimension,
} from "./types.js";

// ---------------------------------------------------------------------------
// Redaction sentinel
// ---------------------------------------------------------------------------

/**
 * The string value placed in place of a redacted field value.
 * Using a recognizable sentinel makes redacted fields visible in diffs
 * rather than silently absent.
 */
export const REDACTED = "[REDACTED]";

// ---------------------------------------------------------------------------
// Sanitizer error type
// ---------------------------------------------------------------------------

/**
 * Typed errors from the sanitizer and publish-mode guard.
 */
export type SanitizerError =
  | {
      type: "PublishSafetyViolation";
      /**
       * Human-readable description of the violation.
       * Does NOT include the raw field values.
       */
      message: string;
      /** The field name that triggered the violation. */
      field: string;
    }
  | {
      type: "RawArtifactInPublishOutput";
      message: string;
    }
  | {
      type: "UnsanitizedOutputDetected";
      message: string;
      /** The sensitive field name detected. */
      field: string;
    };

// ---------------------------------------------------------------------------
// Sensitive field names — never allowed in publishable output
// ---------------------------------------------------------------------------

/**
 * Field names that must never appear in publishable output.
 *
 * This set is the authoritative blocklist. The `assertPublishSafe()` guard
 * scans the top-level keys of any object against this set before allowing
 * a publish write to proceed.
 */
export const SENSITIVE_FIELD_NAMES = new Set<string>([
  // Raw prompt / transcript content
  "composedPrompt",
  "rawContent",
  "rawPrompt",
  "prompt",
  // Raw artifacts
  "rawArtifact",
  "rawArtifacts",
  // Tool arguments (may contain secrets or user data)
  "toolArgs",
  "arguments",
  "tool_arguments",
  "args",
  // Environment values
  "env",
  "environment",
  "envValue",
  // Error payloads
  "cause",
  "body",
  "rawBody",
  "errorBody",
  // Log tails
  "logTail",
  "logs",
  "logLines",
  // Rationales (local-only; only score+applicable go public)
  "rationale",
  "dimensionRationales",
  // Transcript content (full transcript is local-only)
  "transcript",
  // Local-only diagnostic from RawErrorSummary (may contain redacted scorer messages)
  "localDiagnostic",
]);

// ---------------------------------------------------------------------------
// Sanitized run summary
// ---------------------------------------------------------------------------

/**
 * Allowlisted shape of a sanitized per-case run summary.
 *
 * This is the publishable projection of `CaseResultSummary`. Only fields
 * that are safe for external publication are present. Field insertion order
 * matches this declaration (deterministic).
 */
export interface SanitizedCaseResultSummary {
  /** The eval case ID. */
  readonly caseId: string;
  /** The model identifier used for this run. */
  readonly modelId: string;
  /** The eval suite name. */
  readonly suite: string;
  /** Whether the case passed. */
  readonly passed: boolean;
  /** Whether this case was required. */
  readonly required: boolean;
  /** Weighted total score in [0, 1]. */
  readonly weightedTotal: number;
  /**
   * Per-dimension score summaries (score + applicable only; no rationale).
   */
  readonly dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  >;
  /** ISO 8601 timestamp when scored. */
  readonly scoredAt: string;
  /** Whether this is a dry-run result. */
  readonly dryRun: boolean;
  /**
   * Optional bounded public explanation (allowlisted structured-signal text only).
   * Never contains raw model output, rationale strings, or transcript content.
   */
  readonly publicExplanation?: {
    readonly text: string;
    readonly source:
      | "score_bucket_label"
      | "structured_signal"
      | "rubric_template";
  };
}

/**
 * Sanitize a `CaseResultSummary` into its publishable allowlisted projection.
 *
 * Unknown fields on the input are silently dropped. Field order follows the
 * `SanitizedCaseResultSummary` interface declaration — deterministic.
 *
 * @param summary - The raw `CaseResultSummary` from the runner.
 * @returns A `SanitizedCaseResultSummary` safe for external publication.
 */
export function sanitizeCaseResultSummary(
  summary: CaseResultSummary,
): SanitizedCaseResultSummary {
  // Build dimension scores allowlist projection (score + applicable only)
  const dimensionScores: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  > = {
    routingCorrectness: {
      score: summary.dimensionScores.routingCorrectness.score,
      applicable: summary.dimensionScores.routingCorrectness.applicable,
    },
    delegationCorrectness: {
      score: summary.dimensionScores.delegationCorrectness.score,
      applicable: summary.dimensionScores.delegationCorrectness.applicable,
    },
    executionCompleteness: {
      score: summary.dimensionScores.executionCompleteness.score,
      applicable: summary.dimensionScores.executionCompleteness.applicable,
    },
    rationaleQuality: {
      score: summary.dimensionScores.rationaleQuality.score,
      applicable: summary.dimensionScores.rationaleQuality.applicable,
    },
  };

  // Explicit field-by-field construction (allowlist pattern):
  // Unknown fields from the input are simply not included here.
  return {
    caseId: summary.caseId,
    modelId: summary.modelId,
    suite: summary.suite,
    passed: summary.passed,
    required: summary.required,
    weightedTotal: summary.weightedTotal,
    dimensionScores,
    scoredAt: summary.scoredAt,
    dryRun: summary.dryRun,
    // publicExplanation is allowlisted: it contains only bounded structured-signal
    // text with no raw model output, rationale, or transcript content
    ...(summary.publicExplanation !== undefined
      ? {
          publicExplanation: {
            text: summary.publicExplanation.text,
            source: summary.publicExplanation.source,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Sanitized score record
// ---------------------------------------------------------------------------

/**
 * Allowlisted shape of a sanitized normalized score record.
 *
 * Rationales are stripped. Only score and applicable status remain per dimension.
 */
export interface SanitizedScoreRecord {
  readonly caseId: string;
  readonly modelId: string;
  readonly suite: string;
  readonly dimensions: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  >;
  readonly weightedTotal: number;
  readonly passed: boolean;
  readonly required: boolean;
  readonly scoredAt: string;
}

/**
 * Sanitize a `NormalizedScoreRecord` into its publishable projection.
 *
 * Rationales in each dimension are dropped; only `score` and `applicable`
 * are retained. Unknown top-level fields are dropped.
 *
 * @param record - The raw score record from the scorer.
 * @returns A sanitized score record safe for external publication.
 */
export function sanitizeScoreRecord(
  record: NormalizedScoreRecord,
): SanitizedScoreRecord {
  const dimensions: Record<
    ScoringDimension,
    { score: number; applicable: boolean }
  > = {
    routingCorrectness: {
      score: record.dimensions.routingCorrectness.score,
      applicable: record.dimensions.routingCorrectness.applicable,
    },
    delegationCorrectness: {
      score: record.dimensions.delegationCorrectness.score,
      applicable: record.dimensions.delegationCorrectness.applicable,
    },
    executionCompleteness: {
      score: record.dimensions.executionCompleteness.score,
      applicable: record.dimensions.executionCompleteness.applicable,
    },
    rationaleQuality: {
      score: record.dimensions.rationaleQuality.score,
      applicable: record.dimensions.rationaleQuality.applicable,
    },
  };

  return {
    caseId: record.caseId,
    modelId: record.modelId,
    suite: record.suite,
    dimensions,
    weightedTotal: record.weightedTotal,
    passed: record.passed,
    required: record.required,
    scoredAt: record.scoredAt,
  };
}

// ---------------------------------------------------------------------------
// Sanitized provenance record
// ---------------------------------------------------------------------------

/**
 * Allowlisted publishable provenance record.
 *
 * Same as `PromptProvenanceRecord` but constructed via explicit allowlist
 * projection to guard against accidental field additions.
 */
export interface SanitizedProvenanceRecord {
  readonly agentName: string;
  readonly hash: string;
  readonly byteLength: number;
  readonly charLength: number;
  readonly sources: PromptProvenanceRecord["sources"];
  readonly summary: string;
  readonly gitSha: string;
  readonly capturedAt: string;
}

/**
 * Sanitize a `PromptProvenanceRecord` into its allowlisted publishable form.
 *
 * Unknown fields are dropped. Field order is deterministic.
 *
 * @param record - Raw provenance record.
 * @returns Sanitized publishable provenance record.
 */
export function sanitizeProvenanceRecord(
  record: PromptProvenanceRecord,
): SanitizedProvenanceRecord {
  return {
    agentName: record.agentName,
    hash: record.hash,
    byteLength: record.byteLength,
    charLength: record.charLength,
    sources: record.sources.map((s) => {
      if (s.kind === "file") {
        // For file sources, include filePath but strip any absolute path prefix
        // to avoid leaking local machine directory structure.
        return { kind: s.kind, layer: s.layer, filePath: s.filePath };
      }
      return { kind: s.kind, layer: s.layer };
    }),
    summary: record.summary,
    gitSha: record.gitSha,
    capturedAt: record.capturedAt,
  };
}

/**
 * Sanitize a full `PromptProvenanceManifest`.
 *
 * Applies `sanitizeProvenanceRecord` to each record. Top-level manifest
 * metadata fields are allowlisted individually.
 *
 * @param manifest - Raw provenance manifest.
 * @returns Sanitized publishable manifest.
 */
export function sanitizeProvenanceManifest(
  manifest: PromptProvenanceManifest,
): {
  version: number;
  producedAt: string;
  gitSha: string;
  records: SanitizedProvenanceRecord[];
} {
  return {
    version: manifest.version,
    producedAt: manifest.producedAt,
    gitSha: manifest.gitSha,
    records: manifest.records.map(sanitizeProvenanceRecord),
  };
}

// ---------------------------------------------------------------------------
// Generic unknown-field dropping
// ---------------------------------------------------------------------------

/**
 * Drop fields not present in `allowedKeys` from a plain object.
 *
 * Returns a new object containing only the allowlisted keys. The input object
 * is not mutated. Non-object inputs are returned unchanged.
 *
 * This is a shallow operation — nested objects are not recursively filtered.
 * Use the typed sanitize functions (`sanitizeCaseResultSummary`, etc.) for
 * full deep sanitization.
 *
 * @param input - Any plain object.
 * @param allowedKeys - The set of permitted top-level key names.
 * @returns A new object with only the allowlisted keys present.
 */
export function dropUnknownFields<T extends object>(
  input: T,
  allowedKeys: ReadonlyArray<string>,
): Partial<T> {
  const allowedSet = new Set(allowedKeys);
  const output: Partial<T> = {};

  for (const key of Object.keys(input)) {
    if (allowedSet.has(key)) {
      (output as Record<string, unknown>)[key] = (
        input as Record<string, unknown>
      )[key];
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Publish-safety guard
// ---------------------------------------------------------------------------

/**
 * Assert that an object is safe for publish-mode output.
 *
 * Scans the top-level keys of `obj` against `SENSITIVE_FIELD_NAMES` and
 * fails with a typed `SanitizerError` if any sensitive field is detected.
 *
 * This function is the centralized policy enforcement point. Call it before
 * every publish-mode write. Do not use it as a replacement for `sanitize*`
 * functions — those produce the allowlisted projection; this function verifies
 * the result is safe.
 *
 * @param obj - The object about to be written to publishable output.
 * @param context - Optional description of what is being checked (for error messages).
 * @returns `ok(undefined)` when safe; `err(SanitizerError)` when a violation is found.
 */
export function assertPublishSafe(
  obj: Record<string, unknown>,
  context = "object",
): Result<undefined, SanitizerError> {
  // Check for rawArtifact specifically (separate error type for clarity)
  if ("rawArtifact" in obj || "rawArtifacts" in obj) {
    const field = "rawArtifact" in obj ? "rawArtifact" : "rawArtifacts";
    return err({
      type: "RawArtifactInPublishOutput",
      message:
        `Publish-mode safety violation: field "${field}" found in ${context}. ` +
        `Raw artifacts must never appear in publishable output. ` +
        `Strip rawArtifact fields before passing to the bundle writer.`,
    });
  }

  // Check all top-level keys against the sensitive field blocklist
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_FIELD_NAMES.has(key)) {
      return err({
        type: "PublishSafetyViolation",
        message:
          `Publish-mode safety violation: sensitive field "${key}" found in ${context}. ` +
          `This field must be redacted or dropped before publishing. ` +
          `Use the appropriate sanitize*() function to produce a publishable projection.`,
        field: key,
      });
    }
  }

  return ok(undefined);
}

/**
 * Assert that a JSON string does not contain any sensitive field names.
 *
 * Used as a belt-and-suspenders check on already-serialized JSON before
 * writing to disk in publish mode. Scans the raw JSON string for known
 * sensitive key patterns (e.g. `"composedPrompt"`, `"rawContent"`).
 *
 * @param json - Already-serialized JSON string.
 * @param context - Optional description for error messages.
 * @returns `ok(undefined)` when safe; `err(SanitizerError)` when a violation is detected.
 */
export function assertJsonPublishSafe(
  json: string,
  context = "JSON output",
): Result<undefined, SanitizerError> {
  for (const field of SENSITIVE_FIELD_NAMES) {
    // Search for the field name as a JSON key: `"fieldName":` or `"fieldName" :`
    if (json.includes(`"${field}"`)) {
      return err({
        type: "UnsanitizedOutputDetected",
        message:
          `Publish-mode safety violation: sensitive field "${field}" detected in ${context} JSON. ` +
          `Sanitize the data with the appropriate sanitize*() function before serializing.`,
        field,
      });
    }
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Explanation field sanitization
// ---------------------------------------------------------------------------

/**
 * Forbidden source descriptors — strings that callers must NEVER pass as an
 * explanation source. These represent raw text channels that must not enter
 * any public report explanation field.
 *
 * When any of these is detected as the origin of an explanation string,
 * `buildExplanation()` returns a typed `ReportSchemaError`.
 */
export const FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS = new Set<string>([
  "raw_rationale",
  "dimension_rationale",
  "transcript_content",
  "raw_content",
  "composed_prompt",
  "raw_prompt",
  "llm_freeform_summary",
  "chain_of_thought",
  "cot",
  "thinking",
]);

/**
 * Truncate an explanation string to `EXPLANATION_MAX_CHARS` characters.
 *
 * When `text.length <= EXPLANATION_MAX_CHARS`, `text` is returned unchanged.
 * When longer, the string is sliced to `EXPLANATION_MAX_CHARS - 1` characters
 * and a `…` character is appended, preserving the length cap.
 *
 * This function performs NO forbidden-pattern checks. After truncation,
 * callers must still validate the text through `buildExplanation()` or the
 * `BoundedExplanationSchema` before including it in a public report.
 *
 * @param text - The raw explanation string to truncate.
 * @returns The (possibly truncated) explanation string.
 */
export function truncateExplanation(text: string): string {
  if (text.length <= EXPLANATION_MAX_CHARS) return text;
  return text.slice(0, EXPLANATION_MAX_CHARS - 1) + "…";
}

/**
 * Build a validated `BoundedExplanation` for use in a public report field.
 *
 * Performs all safety checks in order:
 *   1. Rejects `sourceDescriptor` values in `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`.
 *      This is the primary guard against raw rationale strings, transcript content,
 *      composed prompt text, and LLM freeform summary passes.
 *   2. Rejects overlong `text` (> `EXPLANATION_MAX_CHARS` characters).
 *      Callers should pre-truncate using `truncateExplanation()`.
 *   3. Rejects text matching any `FORBIDDEN_EXPLANATION_PATTERNS` entry.
 *      This is the secondary guard against chain-of-thought markers, transcript
 *      role labels, raw rationale markers, and secret patterns.
 *   4. Returns a valid `BoundedExplanation` when all checks pass.
 *
 * The `sourceDescriptor` parameter is a human-readable label describing where
 * the text came from (used in error messages). It is distinct from the
 * `ExplanationSource` enum field on `BoundedExplanation` — the latter
 * declares the approved category (e.g. `"score_bucket_label"`), while
 * `sourceDescriptor` is a caller-supplied origin label that must NOT be in
 * the forbidden set.
 *
 * @param text - The explanation text (should be pre-truncated).
 * @param source - The allowlisted `ExplanationSource` enum value.
 * @param sourceDescriptor - A human-readable origin label (checked against
 *   `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`).
 * @returns `ok(BoundedExplanation)` when valid; `err(ReportSchemaError)` when rejected.
 */
export function buildExplanation(
  text: string,
  source: ExplanationSource,
  sourceDescriptor: string,
): Result<BoundedExplanation, ReportSchemaError> {
  // Guard 1: reject forbidden source descriptors (raw rationale, transcript, etc.)
  if (FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS.has(sourceDescriptor)) {
    return err({
      type: "ExplanationSourceForbidden",
      sourceDescriptor,
      message:
        `Explanation source "${sourceDescriptor}" is forbidden in public report fields. ` +
        `Raw rationale strings, transcript content, composed prompt text, ` +
        `chain-of-thought traces, and LLM freeform summaries must never be used ` +
        `as explanation inputs. Use a rubric_template, score_bucket_label, ` +
        `structured_signal, or operator_note instead.`,
    });
  }

  // Guard 2: reject overlong text
  if (text.length > EXPLANATION_MAX_CHARS) {
    return err({
      type: "ExplanationTooLong",
      actualLength: text.length,
      maxLength: EXPLANATION_MAX_CHARS,
      message:
        `Explanation text is ${text.length} characters, which exceeds the ` +
        `${EXPLANATION_MAX_CHARS}-character limit. Call truncateExplanation() ` +
        `before passing to buildExplanation().`,
    });
  }

  // Guard 3: reject forbidden patterns
  for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
    if (pattern.test(text)) {
      return err({
        type: "ExplanationForbiddenPattern",
        patternName: name,
        message:
          `Explanation text matches forbidden pattern "${name}". ` +
          `Raw transcript content, rationale strings, chain-of-thought traces, ` +
          `prompt text, and LLM freeform summaries are not permitted in ` +
          `public report explanation fields.`,
      });
    }
  }

  return ok({ text, source });
}

/**
 * Assert that an explanation string does not match any forbidden patterns.
 *
 * A lighter-weight check than `buildExplanation()` — only validates the text
 * content without requiring a source declaration. Use this in the sanitizer
 * pipeline when the source has already been validated.
 *
 * @param text - The explanation text to validate.
 * @param context - Optional description for error messages.
 * @returns `ok(undefined)` when clean; `err(ReportSchemaError)` when a
 *          forbidden pattern is detected.
 */
export function assertExplanationSafe(
  text: string,
  context = "explanation field",
): Result<undefined, ReportSchemaError> {
  if (text.length > EXPLANATION_MAX_CHARS) {
    return err({
      type: "ExplanationTooLong",
      actualLength: text.length,
      maxLength: EXPLANATION_MAX_CHARS,
      message:
        `Explanation text in ${context} is ${text.length} characters, which exceeds ` +
        `the ${EXPLANATION_MAX_CHARS}-character limit.`,
    });
  }

  for (const { name, pattern } of FORBIDDEN_EXPLANATION_PATTERNS) {
    if (pattern.test(text)) {
      return err({
        type: "ExplanationForbiddenPattern",
        patternName: name,
        message:
          `Explanation text in ${context} matches forbidden pattern "${name}". ` +
          `Raw content must not appear in public report explanation fields.`,
      });
    }
  }

  return ok(undefined);
}
