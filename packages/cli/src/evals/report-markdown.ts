/**
 * Markdown report renderer for the Weave agent evals dashboard.
 *
 * Converts `PublicReportBundle` and `SuiteSummaryEntry` values to Markdown
 * strings suitable for CI comment posting, GitHub PR summaries, or local
 * display. All rendered content is derived from public schema types only.
 *
 * # Safety contract
 *
 * All text in the rendered Markdown comes from:
 *   - Schema-validated public fields (caseId, modelId, suite names — identifiers)
 *   - Score bucket labels ("pass", "partial", "fail", "skip")
 *   - Pass/fail counts (integers)
 *   - Bounded `publicExplanation.text` values (pre-validated by `BoundedExplanationSchema`)
 *   - ISO 8601 timestamps
 *   - Git SHAs (hex strings, bounded to 40 chars)
 *
 * This module MUST NOT render:
 *   - Raw model output, rationale strings, or transcript content
 *   - Chain-of-thought text or prompt text
 *   - LLM-generated freeform summaries
 *   - Any field from `RawCaseResultArtifact`
 *
 * # Explanation text rendering
 *
 * When a `PublicCaseEntry` has an `explanation` field, the `text` value is
 * rendered verbatim in the case detail row. The text has already been validated
 * by `BoundedExplanationSchema` (bounded, no forbidden patterns) before it
 * reaches this module — no additional escaping beyond standard Markdown table
 * cell escaping is required.
 *
 * # XSS / HTML injection policy (public-report.md)
 *
 * `public-report.md` files produced by this renderer are **plain-text Markdown
 * download artifacts only**. They MUST NOT be injected into any web page as
 * HTML (via `innerHTML`, `dangerouslySetInnerHTML`, or any equivalent). The
 * v1 policy is:
 *
 *   - `public-report.md` is served as a downloadable file or displayed as
 *     raw plain text. No server-side or client-side Markdown-to-HTML rendering
 *     is applied before the document reaches a browser rendering context.
 *
 *   - If a future release renders Markdown to HTML, the renderer MUST apply a
 *     strict sanitizer with an explicit element allowlist (e.g. DOMPurify or
 *     equivalent). The following constructs MUST be rejected before any HTML
 *     surface:
 *       - Raw HTML blocks (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`)
 *       - Inline event handlers (`on*` attributes: `onclick`, `onerror`, etc.)
 *       - `javascript:` URI scheme in any attribute (`href`, `src`, `action`)
 *       - `data:` URI scheme in any attribute
 *       - `<form>` and `<input>` elements
 *       - Any attribute injection via Markdown link/image syntax
 *
 *   - `innerHTML` assignment is categorically banned as a Markdown rendering
 *     path. Use `textContent` or a sanitizer-wrapped renderer that returns a
 *     safe DocumentFragment.
 *
 * The rendered Markdown intentionally contains no raw HTML — all output is
 * pure Markdown syntax (headings, tables, emphasis, code spans). This means
 * even a naive renderer that permits HTML pass-through cannot inject scripts
 * from this module's output, provided no injection occurs upstream of the
 * rendered data (covered by BoundedExplanationSchema and SENSITIVE_FIELD_NAMES).
 *
 * # Injection surface audit
 *
 * Every string value placed into the Markdown output passes through
 * `escapeMdCell()` (which neutralizes `|` characters) before inclusion in
 * table cells. Non-table strings are derived from:
 *   - Fixed enum literals (`bucketLabel` — pure switch, no external input)
 *   - Numeric `toString()` values (integers, no HTML)
 *   - ISO 8601 timestamp strings (schema-validated, no HTML)
 *   - Hex SHA strings (schema-validated, no HTML)
 *   - `BoundedExplanationSchema`-validated explanation text (forbidden patterns
 *     already block HTML tags, script injection markers, and secret patterns)
 *
 * None of these channels can produce `<script>`, `<style>`, inline event
 * handlers, `javascript:` URIs, `data:` URIs, or `<iframe>` tags in the
 * rendered output.
 */

import type {
  PublicCaseEntry,
  PublicReportBundle,
  SuiteSummaryEntry,
} from "./report-schema.js";

// ---------------------------------------------------------------------------
// Markdown escaping and HTML injection guards
// ---------------------------------------------------------------------------

/**
 * Patterns that MUST NOT appear in any string written to a Markdown report.
 *
 * These patterns detect HTML injection attempts that could execute scripts or
 * inject malicious markup if the Markdown document were ever rendered as HTML
 * without a strict sanitizer. The patterns are checked in `assertMarkdownSafe()`
 * which is called on every user-supplied string before it enters the output.
 *
 * Note: `BoundedExplanationSchema` already blocks many of these at schema
 * validation time. This guard is the belt-and-suspenders check inside the
 * Markdown renderer itself.
 */
export const MARKDOWN_INJECTION_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  {
    name: "script_tag",
    // Matches opening <script> tags (case-insensitive, allowing whitespace)
    pattern: /<script[\s>]/i,
  },
  {
    name: "style_tag",
    // Matches opening <style> tags
    pattern: /<style[\s>]/i,
  },
  {
    name: "iframe_tag",
    // Matches <iframe> tags
    pattern: /<iframe[\s>]/i,
  },
  {
    name: "inline_event_handler",
    // Matches HTML event handler attributes: onclick=, onerror=, onload=, etc.
    pattern: /\bon\w+\s*=/i,
  },
  {
    name: "javascript_uri",
    // Matches javascript: URI scheme (with optional whitespace/encoding)
    pattern: /javascript\s*:/i,
  },
  {
    name: "data_uri",
    // Matches data: URI scheme (used for encoded content injection)
    pattern: /data\s*:/i,
  },
  {
    name: "object_embed_tag",
    // Matches <object> and <embed> tags
    pattern: /<(?:object|embed)[\s>]/i,
  },
  {
    name: "form_tag",
    // Matches <form> tags (phishing/credential-capture vector)
    pattern: /<form[\s>]/i,
  },
];

/**
 * Assert that a string does not contain any Markdown/HTML injection patterns.
 *
 * This is a belt-and-suspenders guard inside the Markdown renderer. The
 * primary defence is schema validation (`BoundedExplanationSchema` and strict
 * Zod schemas that reject unknown fields). This function is the secondary
 * check applied to strings after they leave schema validation but before they
 * enter the rendered Markdown document.
 *
 * Returns `true` when the string is clean; `false` when any injection pattern
 * matches. When `false`, the caller MUST substitute a safe fallback (empty
 * string or a static label) instead of emitting the flagged value.
 *
 * @param text - The string to check.
 * @returns `true` when no injection patterns match; `false` when any match.
 */
export function isMarkdownSafe(text: string): boolean {
  for (const { pattern } of MARKDOWN_INJECTION_PATTERNS) {
    if (pattern.test(text)) return false;
  }
  return true;
}

/**
 * Sanitize a string for safe inclusion in a Markdown report.
 *
 * Applies the following in order:
 *   1. If the string contains any `MARKDOWN_INJECTION_PATTERNS` match, returns
 *      an empty string (the injection attempt is discarded entirely).
 *   2. Replaces pipe characters (`|`) with `&#124;` to prevent Markdown table
 *      layout breakage.
 *
 * This function is used for all user-supplied strings in the Markdown output.
 * Fixed enum values (bucket labels, boolean strings, numeric counts) do not
 * require this check but are safe regardless.
 *
 * @param text - Input string (from a schema-validated public field).
 * @returns Safe string for Markdown table cell or inline use.
 */
export function sanitizeMdValue(text: string): string {
  if (!isMarkdownSafe(text)) return "";
  return text.replace(/\|/g, "&#124;");
}

/**
 * Escape a string for use in a Markdown table cell.
 *
 * Replaces pipe characters (`|`) with their HTML entity to prevent table
 * layout breakage. Does not escape other Markdown constructs — the content
 * is guaranteed by the schema to be a bounded identifier or structured label.
 *
 * For explanation text and other user-supplied strings, prefer `sanitizeMdValue()`
 * which also applies `MARKDOWN_INJECTION_PATTERNS` checks before pipe escaping.
 *
 * @param text - Input string.
 * @returns Escaped string safe for Markdown table cells.
 */
function escapeMdCell(text: string): string {
  return sanitizeMdValue(text);
}

// ---------------------------------------------------------------------------
// Score bucket emoji / label
// ---------------------------------------------------------------------------

/**
 * Return a Markdown-friendly label for a score bucket.
 *
 * Uses emoji for visual scannability without depending on any model-generated
 * text — the bucket values are a fixed enum.
 */
function bucketLabel(bucket: "pass" | "partial" | "fail" | "skip"): string {
  switch (bucket) {
    case "pass":
      return "✅ pass";
    case "partial":
      return "⚠️ partial";
    case "fail":
      return "❌ fail";
    case "skip":
      return "⏭️ skip";
  }
}

// ---------------------------------------------------------------------------
// Per-case Markdown row
// ---------------------------------------------------------------------------

/**
 * Render a single `PublicCaseEntry` as a Markdown table row.
 *
 * Columns: case ID | model ID | bucket | passed | explanation
 *
 * When `explanation` is present, the `text` value (already validated and
 * bounded) is rendered in the final column. When absent, the cell is empty.
 *
 * @param entry - A validated `PublicCaseEntry`.
 * @returns Markdown table row string (no trailing newline).
 */
export function renderCaseRow(entry: PublicCaseEntry): string {
  const caseIdCell = escapeMdCell(entry.caseId);
  const modelIdCell = escapeMdCell(entry.modelId);
  const bucketCell = bucketLabel(entry.scoreBucket);
  const passedCell = entry.passed ? "yes" : "no";
  const explanationCell =
    entry.explanation !== undefined ? escapeMdCell(entry.explanation.text) : "";

  return `| ${caseIdCell} | ${modelIdCell} | ${bucketCell} | ${passedCell} | ${explanationCell} |`;
}

// ---------------------------------------------------------------------------
// Suite summary Markdown block
// ---------------------------------------------------------------------------

/**
 * Render a `SuiteSummaryEntry` as a Markdown block.
 *
 * Includes:
 *   - H3 heading with suite name and green/red status badge
 *   - Aggregate counts (total, passed, failed)
 *   - Per-case table with score bucket, passed/failed, and explanation columns
 *
 * All text is derived from schema-validated public fields only.
 *
 * @param summary - A validated `SuiteSummaryEntry`.
 * @returns Multi-line Markdown string.
 */
export function renderSuiteSummary(summary: SuiteSummaryEntry): string {
  const statusBadge = summary.suiteGreen ? "🟢 green" : "🔴 red";
  const lines: string[] = [];

  lines.push(`### Suite: ${escapeMdCell(summary.suite)} — ${statusBadge}`);
  lines.push("");
  lines.push(
    `**Total**: ${summary.totalCases} | **Passed**: ${summary.passedCases} | **Failed**: ${summary.failedCases}`,
  );
  lines.push("");

  if (summary.cases.length === 0) {
    lines.push("_No cases in this suite._");
  } else {
    lines.push("| Case ID | Model | Score | Passed | Explanation |");
    lines.push("|---------|-------|-------|--------|-------------|");
    for (const entry of summary.cases) {
      lines.push(renderCaseRow(entry));
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full public report bundle Markdown
// ---------------------------------------------------------------------------

/**
 * Render a complete `PublicReportBundle` as a Markdown document.
 *
 * Includes:
 *   - H2 heading with overall green/red status
 *   - Run metadata (git SHA, assembled timestamp, dry-run flag)
 *   - Aggregate run summary (total, passed, failed across all suites)
 *   - Per-suite sections rendered by `renderSuiteSummary()`
 *
 * The document is bounded by the size of the bundle — no unbounded string
 * growth occurs because explanation fields are already bounded by
 * `EXPLANATION_MAX_CHARS`.
 *
 * @param bundle - A validated `PublicReportBundle`.
 * @returns Multi-line Markdown string.
 */
export function renderPublicReportBundle(bundle: PublicReportBundle): string {
  const overallStatus = bundle.runSummary.allSuitesGreen
    ? "🟢 All suites green"
    : "🔴 One or more suites failed";

  const dryRunNote = bundle.dryRun
    ? "\n> ⚠️ **Dry-run**: no model was called — all scores are zero.\n"
    : "";

  const lines: string[] = [];

  lines.push(`## Weave Agent Evals Report — ${overallStatus}`);
  lines.push(dryRunNote);
  lines.push(
    `**Git SHA**: \`${bundle.gitSha.slice(0, 7)}\` | **Assembled**: ${bundle.assembledAt}`,
  );
  lines.push("");
  lines.push(
    `**Total cases**: ${bundle.runSummary.totalCases} | **Passed**: ${bundle.runSummary.passedCases} | **Failed**: ${bundle.runSummary.failedCases}`,
  );
  lines.push("");

  for (const suiteSummary of bundle.suiteSummaries) {
    lines.push(renderSuiteSummary(suiteSummary));
    lines.push("");
  }

  return lines.join("\n");
}
