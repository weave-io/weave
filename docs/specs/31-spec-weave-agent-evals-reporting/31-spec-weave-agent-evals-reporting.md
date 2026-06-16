# 31-spec-weave-agent-evals-reporting.md

**Related**: [Specs Index](../README.md) · [DSL Reference](../../dsl-reference.md) · [Adapter Boundary](../../adapter-boundary.md) · [Spec 12 — Runtime Persistence](../12-spec-runtime-persistence/12-spec-runtime-persistence.md) · [`packages/cli/src/evals/report-schema.ts`](../../../packages/cli/src/evals/report-schema.ts) · [`packages/cli/src/evals/sanitizer.ts`](../../../packages/cli/src/evals/sanitizer.ts) · [`packages/cli/src/evals/types.ts`](../../../packages/cli/src/evals/types.ts)

---

## Introduction / Overview

This spec defines the **public reporting contract and sanitization envelope** for Weave agent eval results. It governs the versioned schemas for all publishable report artifacts (public report bundles, suite summaries, dashboard entry manifests, suite history manifests, and model-comparison manifests) and the strict sanitization rules that prevent any sensitive, raw, or internal content from appearing in those artifacts.

The central problem this spec addresses: eval pipelines produce a large volume of raw internal data — model transcripts, rationale strings, composed prompts, chain-of-thought traces, dimension-level floating-point scores, tool arguments, and environment values — none of which should appear in publicly-committed or externally-published report artifacts. Without an explicit contract, individual callers make ad-hoc decisions about what to include, leading to accidental leakage.

This spec draws a hard line: all public report schemas are **allowlist-first** and **schema-version-gated**. Every explanation field is **bounded, source-attributed, and pattern-validated**. Raw text channels (rationale strings, transcript content, prompt text, LLM freeform summaries) are categorically rejected as explanation sources.

---

## Goals

1. Define versioned Zod schemas for all public dashboard report artifact types.
2. Define a strict sanitization envelope that explicitly bounds explanation fields and rejects raw text inputs.
3. Define a `ScoreBucket` enum that replaces raw floating-point scores in all public summaries.
4. Provide a `computeScoreBucket()` pure function mapping scores to buckets.
5. Define `FORBIDDEN_EXPLANATION_PATTERNS` covering all known raw-text leakage channels.
6. Define `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS` covering all known forbidden source origins.
7. Provide `truncateExplanation()`, `buildExplanation()`, and `assertExplanationSafe()` in `sanitizer.ts` as the authoritative sanitization functions for explanation fields.
8. Prove all contracts with typed tests that cover the acceptance criteria.

---

## Non-Goals

1. This spec does not define how the dashboard UI renders report data.
2. This spec does not change how the scorer produces `NormalizedScoreRecord` values — the scorer output is internal; only the sanitized projection enters public reports.
3. This spec does not change the eval runner, model client, or fixture schemas.

---

## Artifact Layout

`public-report.json` (a serialized `PublicReportBundle`) and optional `public-report.md` (rendered by `report-markdown.ts`) are written into every immutable run directory alongside the internal bundle files. The writer (`artifact-bundle.ts`) owns this disk write; this spec owns the schema and content constraints.

Run directories are immutable and unique — each eval run writes to `<bundleRoot>/runs/<runId>/`. The `runId` has the form `<sha7>-<YYYY-MM-DD>-<NNN>`. Repeat runs on the same commit and date increment the sequence counter rather than overwriting prior artifacts. See [`docs/eval-sanitization-and-publish-pipeline.md`](../../eval-sanitization-and-publish-pipeline.md) for the full layout spec.

---

## Public Schema Contracts

### Schema versioning

Every public schema carries `schemaVersion` as the **first** key, typed as a positive integer. Consumers must reject any document whose `schemaVersion` they do not recognise. Schema version increments are backward-incompatible.

| Schema | Version constant | Current value |
| --- | --- | --- |
| `PublicReportBundle` | `REPORT_BUNDLE_SCHEMA_VERSION` | 1 |
| `SuiteSummaryEntry` | `SUITE_SUMMARY_SCHEMA_VERSION` | 1 |
| `DashboardManifest` | `DASHBOARD_MANIFEST_SCHEMA_VERSION` | 1 |
| `SuiteHistoryManifest` | `SUITE_HISTORY_SCHEMA_VERSION` | 1 |
| `ModelComparisonManifest` | `MODEL_COMPARISON_SCHEMA_VERSION` | 1 |

### PublicReportBundle

Top-level public bundle published as `runs/v1/<runId>/public-report.json`. Contains:
- `schemaVersion` (required)
- `assembledAt`, `gitSha`, `dryRun`
- `runSummary` — aggregate pass/fail counts and green status; no raw content
- `suiteSummaries` — array of `SuiteSummaryEntry`

No raw prompt text, transcript content, rationale strings, dimension scores as floats, tool arguments, or chain-of-thought traces appear in this object.

### SuiteSummaryEntry

Per-suite summary published alongside the bundle. Contains:
- `schemaVersion` (required)
- `suite`, `assembledAt`, `gitSha`
- `totalCases`, `passedCases`, `failedCases`, `suiteGreen`
- `cases` — array of `PublicCaseEntry`

### PublicCaseEntry

Per-case entry in a suite summary. Key design decisions:
- `scoreBucket` replaces raw `weightedTotal` float — consumers see `"pass"` / `"partial"` / `"fail"` / `"skip"` only.
- `explanation` is optional; when present it must satisfy `BoundedExplanationSchema`.
- No `rationale`, `dimensionRationales`, `composedPrompt`, `rawContent`, or `transcript` fields are present.

### DashboardManifest

Run index published as `dashboard-manifest.json` at the external repo root. Contains:
- `schemaVersion` (required)
- `updatedAt`, `totalRuns`
- `runs` — array of `DashboardEntry` (newest first)

Each `DashboardEntry` has `runId` (validated against `[A-Za-z0-9._-]+`), aggregate pass/fail counts, and a `bundleReportPath` pointing to `runs/v1/<runId>/public-report.json`.

### SuiteHistoryManifest

Per-suite time series for trend charts. Contains:
- `schemaVersion` (required)
- `suite`, `updatedAt`
- `history` — array of `SuiteHistoryPoint` (oldest first)

`passRate` is `number | null` — null when `totalCases === 0`.

### ModelComparisonManifest

Per-model comparison for the dashboard comparison table. Contains:
- `schemaVersion` (required)
- `runId`, `assembledAt`, `gitSha`, `dryRun`
- `models` — array of `ModelComparisonEntry`

Each `ModelComparisonEntry` carries `passRate` and `perSuitePassRates` (both nullable for zero-case scenarios) and an `overallBucket` drawn from the `ScoreBucket` enum.

---

## Sanitization Envelope

### ScoreBucket enum

```
"pass"    — weightedTotal >= 0.9
"partial" — weightedTotal >= 0.5
"fail"    — weightedTotal < 0.5
"skip"    — dryRun === true OR weightedTotal is undefined
```

Raw floating-point scores are internal. All public schemas expose only `ScoreBucket` labels.

### Explanation field rules

The `BoundedExplanation` type carries two fields:
- `text` — the explanation string (non-empty, max `EXPLANATION_MAX_CHARS` = 300 chars, no forbidden patterns)
- `source` — the `ExplanationSource` enum value declaring where the text came from

**Allowed `ExplanationSource` values**:

| Value | Meaning |
| --- | --- |
| `"rubric_template"` | Text from a rubric template literal or fixture field |
| `"score_bucket_label"` | Short label derived from a score bucket |
| `"structured_signal"` | Boolean/enum signal from typed score record fields |
| `"operator_note"` | Short human-written note (NOT LLM-generated) |

**Categorically forbidden explanation sources** (`FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`):

- `raw_rationale`, `dimension_rationale` — scorer rationale strings
- `transcript_content`, `raw_content` — model/transcript output
- `composed_prompt`, `raw_prompt` — prompt text
- `llm_freeform_summary` — any LLM pass over raw eval content
- `chain_of_thought`, `cot`, `thinking` — internal model reasoning

### Forbidden explanation patterns (`FORBIDDEN_EXPLANATION_PATTERNS`)

Seven pattern categories are rejected:

| Name | Detects |
| --- | --- |
| `chain_of_thought_xml` | `<thinking>`, `<cot>`, `<reasoning>`, `<scratchpad>` |
| `transcript_role_marker` | `\nUser:`, `\nAssistant:`, `\nHuman:`, `\nSystem:`, `\nTool:` |
| `prompt_delimiter` | `<system>`, `<prompt>`, `<instruction>`, `<context>` |
| `raw_rationale_marker` | `rationale:` (case-insensitive) |
| `raw_score_marker` | `score: <digit>` |
| `justification_marker` | `justification:`, `explanation:` |
| `secret_token_pattern` | `sk-<8+ chars>`, `Bearer <10+ chars>`, `ghp_<8+ chars>` |

### Sanitization functions

All live in `sanitizer.ts`:

**`truncateExplanation(text)`** — truncates to `EXPLANATION_MAX_CHARS` characters, appending `…` when truncated. Performs no pattern checks. Must be called before `buildExplanation()` when the source text may be long.

**`buildExplanation(text, source, sourceDescriptor)`** — the authoritative builder. Validates in order:
1. Rejects `sourceDescriptor` if in `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`
2. Rejects `text.length > EXPLANATION_MAX_CHARS`
3. Rejects `text` matching any `FORBIDDEN_EXPLANATION_PATTERNS` entry

Returns `Result<BoundedExplanation, ReportSchemaError>`. Never throws.

**`assertExplanationSafe(text, context?)`** — lighter-weight check for already-attributed text. Validates length and pattern guards. Returns `Result<undefined, ReportSchemaError>`.

---

## Error types

`ReportSchemaError` (in `report-schema.ts`) is a discriminated union:

| Type | When |
| --- | --- |
| `SchemaVersionMissing` | `schemaVersion` field absent |
| `SchemaVersionUnrecognised` | `schemaVersion` present but not a known value |
| `ExplanationForbiddenPattern` | explanation text matches a forbidden pattern |
| `ExplanationTooLong` | explanation exceeds `EXPLANATION_MAX_CHARS` |
| `ExplanationSourceForbidden` | source descriptor is in the forbidden set |
| `SchemaValidationFailed` | Zod parse failed with structured issues |

---

## Acceptance Criteria

The following criteria must be met for this spec to be considered complete:

1. **`schemaVersion` required** — All five public schema types (`PublicReportBundle`, `SuiteSummaryEntry`, `DashboardManifest`, `SuiteHistoryManifest`, `ModelComparisonManifest`) have `schemaVersion` as a required field. Parsing without it fails. Parsing with an unrecognised version fails.

2. **Sensitive field rejection** — All public schema types (`PublicCaseEntry`, `SuiteSummaryEntry`, `PublicReportBundle`, `DashboardEntry`, `DashboardManifest`, `SuiteHistoryPoint`, `SuiteHistoryManifest`, `ModelComparisonEntry`, `ModelComparisonManifest`) use Zod's `.strict()` mode. Any object that contains unknown keys — including all fields in `SENSITIVE_FIELD_NAMES` such as `rationale`, `composedPrompt`, `rawContent`, `transcript`, `dimensionRationales`, `toolArgs`, `env`, `prompt`, etc. — **fails schema validation** rather than being silently stripped. Typed tests prove rejection (not stripping) for each sensitive key category.

3. **Raw text explanation input rejection** — `BoundedExplanationSchema` and `buildExplanation()` reject:
   - Any text containing chain-of-thought markers (`<thinking>`, `<cot>`, `<reasoning>`, `<scratchpad>`)
   - Any text containing transcript role markers (`\nUser:`, `\nAssistant:`, etc.)
   - Any text containing prompt delimiters (`<system>`, `<prompt>`, etc.)
   - Any text containing raw rationale markers (`rationale:`)
   - Any text containing raw score markers (`score: <digit>`)
   - Any text containing justification/explanation markers
   - Any text containing secret patterns (API key formats)
   - Any sourceDescriptor in `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS`

4. **Overlong explanation rejection** — `BoundedExplanationSchema` and `buildExplanation()` reject strings exceeding `EXPLANATION_MAX_CHARS` (300) characters.

5. **No LLM/freeform summary pass** — `llm_freeform_summary` is a forbidden `sourceDescriptor`. The schema and `buildExplanation()` both reject it. No code path in the public report pipeline calls a model to generate explanation text.

6. **Score bucket replaces raw float** — `PublicCaseEntry` and `ModelComparisonEntry` expose `scoreBucket` (enum) not raw `weightedTotal` (float). `computeScoreBucket()` is a pure function mapping score values to enum labels.

7. **Typed tests prove all acceptance criteria** — `report-schema.test.ts` and `sanitizer.test.ts` contain typed tests that parse valid fixtures (asserting success) and parse forbidden inputs (asserting failure with typed errors) for each criterion above.

---

## Invariants

- **No LLM summary pass over raw eval content** is permitted anywhere in the public report pipeline. This is a categorical rule, not a best-effort guideline. The source enum and source descriptor blocklist enforce it at the API level.
- **Schema version is always the first key**. Downstream dashboard consumers may use `schemaVersion` as the first key read to decide how to route the document.
- **Public schemas use strict mode**. All public report and index Zod schemas call `.strict()`, which means unknown keys — including every field in `SENSITIVE_FIELD_NAMES` — cause parse failure. Callers must sanitize via the allowlist functions in `sanitizer.ts` before presenting data to public schemas.
- **`truncateExplanation` does not sanitize**. It only truncates. Callers must still validate with `buildExplanation()` or `assertExplanationSafe()`.
- **`buildExplanation()` checks source descriptor before length before pattern**. This ordering is intentional and tested. Source descriptor violations are the highest-priority signal.

---

## Related Files

| File | Role |
| --- | --- |
| `packages/cli/src/evals/report-schema.ts` | Zod schemas, `ScoreBucket`, `ExplanationSource`, `FORBIDDEN_EXPLANATION_PATTERNS`, `BoundedExplanationSchema`, `computeScoreBucket()` |
| `packages/cli/src/evals/sanitizer.ts` | `truncateExplanation()`, `buildExplanation()`, `assertExplanationSafe()`, `FORBIDDEN_EXPLANATION_SOURCE_DESCRIPTORS` |
| `packages/cli/src/evals/types.ts` | Internal eval types (runner, scorer, bundle) — not extended by this spec |
| `packages/cli/src/evals/__tests__/report-schema.test.ts` | Proof tests for this spec |
| `packages/cli/src/evals/__tests__/sanitizer.test.ts` | Proof tests for sanitizer extension |
