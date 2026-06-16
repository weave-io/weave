# Eval Report Rendering XSS Policy

**Scope**: `packages/cli/src/evals/report-markdown.ts`, `report-schema.ts`, `weave-website/evals/shared/dashboard-ui.js`, `weave-website/weave-agent-evals/shared/dashboard-ui.js`

This document specifies the XSS / HTML injection policy for the Weave agent evals reporting pipeline. It is the normative reference for how Markdown and JSON report artifacts may be rendered and what injection vectors are banned.

Related docs:

- [`docs/eval-sanitization-and-publish-pipeline.md`](./eval-sanitization-and-publish-pipeline.md) — overall sanitization architecture and publish pipeline
- [`docs/agent-evals.md`](./agent-evals.md) — eval architecture, CLI usage, and security checklist

---

## Policy Summary (v1)

### `public-report.md` is a download-only artifact

`public-report.md` is produced by `report-markdown.ts` and written to the immutable run directory alongside `public-report.json`. It is a **plain-text Markdown file** intended for:

- Direct download from a CI artifact or results repository
- Display in GitHub UI as raw Markdown (rendered by GitHub's own sanitized Markdown renderer)
- Posting as a CI step summary or PR comment (consumed by GitHub Actions or GitHub PR comment API, both of which apply their own Markdown-to-HTML sanitization)

**`public-report.md` MUST NOT be:**

- Injected into any web page as HTML via `innerHTML`, `dangerouslySetInnerHTML`, or any equivalent
- Passed to a client-side Markdown-to-HTML renderer that does not apply a strict sanitizer
- Served as `Content-Type: text/html` or embedded in a page template as unescaped HTML

If a future release adds a client-side Markdown rendering surface, it MUST apply a strict sanitizer with an explicit allowlist (e.g., DOMPurify configured for Markdown output) before assignment.

### All `innerHTML` paths require `escapeHtml()`

Both dashboard UI implementations use `innerHTML` assignment to render family and suite data:

- **Legacy section** (`weave-website/evals/shared/dashboard-ui.js`) — module-private `escapeHtml()` used throughout.
- **New section** (`weave-website/weave-agent-evals/shared/dashboard-ui.js`) — `escapeHtml()` is exported so callers can apply it explicitly; safe-render helpers (`safeTextSpan`, `safeTableCell`, `safeDataAttr`) apply it internally.

Every string value placed into `innerHTML` MUST be wrapped in `escapeHtml()` before insertion. No exceptions.

`escapeHtml()` escapes five special HTML characters:

| Character | Escaped to |
|---|---|
| `&` | `&amp;` |
| `<` | `&lt;` |
| `>` | `&gt;` |
| `"` | `&quot;` |
| `'` | `&#39;` |

This is sufficient to prevent tag injection (`<script>`, `<img>`, etc.) and attribute breakout (`"` or `'` closing a quoted attribute value).

### `explanation` fields are blocked at the schema level

`BoundedExplanationSchema` (in `report-schema.ts`) rejects any `explanation.text` value that matches a pattern in `FORBIDDEN_EXPLANATION_PATTERNS`. Explanations that fail validation are **silently dropped** from the published report entry — the case entry is still published with its score bucket and pass/fail boolean.

The HTML injection patterns added to `FORBIDDEN_EXPLANATION_PATTERNS` are:

| Pattern name | What it blocks |
|---|---|
| `html_script_tag` | `<script>` tags |
| `html_style_tag` | `<style>` tags |
| `html_iframe_tag` | `<iframe>` tags |
| `html_object_embed_tag` | `<object>` and `<embed>` tags |
| `html_form_tag` | `<form>` tags |
| `html_inline_event_handler` | Inline `on*=` event handlers (`onclick=`, `onerror=`, `onload=`, etc.) |
| `html_javascript_uri` | `javascript:` URI scheme |
| `html_data_uri` | `data:` URI scheme |

These patterns are belt-and-suspenders: the primary defence is that explanation text comes from allowlisted structured sources (score buckets, rubric templates, structured signals) — never from raw model output, rationale strings, or transcript content. The HTML patterns add a secondary rejection layer that applies regardless of the declared source.

---

## Injection Surface Audit

### `public-report.md` surface

All strings placed into the Markdown document go through one of:

1. **Fixed enum literals** — `bucketLabel()` returns fixed emoji strings. No user input.
2. **Numeric counts** — `totalCases`, `passedCases`, `failedCases` are integers. Cannot contain HTML.
3. **Boolean labels** — `"yes"` / `"no"` and `"🟢 green"` / `"🔴 red"`. Fixed literals.
4. **ISO 8601 timestamps** — schema-validated. Cannot contain `<`, `>`, or `"`.
5. **Git SHA hex strings** — schema-validated (`/^[A-Za-z0-9._-]+$/`). Cannot contain HTML.
6. **`sanitizeMdValue(text)`** — applied to all `caseId`, `modelId`, `suite`, and `explanation.text` values. This function:
   - Checks the input against `MARKDOWN_INJECTION_PATTERNS` (see below)
   - Returns an empty string for any match (injection attempt is discarded)
   - Escapes `|` to `&#124;` for surviving strings (prevents Markdown table breakage)

None of these channels can produce `<script>`, `<style>`, inline event handlers, `javascript:` URIs, `data:` URIs, or `<iframe>` tags in the rendered output.

### `MARKDOWN_INJECTION_PATTERNS`

These patterns are checked in `report-markdown.ts` via `isMarkdownSafe()` and `sanitizeMdValue()`:

| Pattern name | What it detects |
|---|---|
| `script_tag` | `<script` opening tags |
| `style_tag` | `<style` opening tags |
| `iframe_tag` | `<iframe` opening tags |
| `inline_event_handler` | `on\w+=` inline event handlers |
| `javascript_uri` | `javascript:` URI scheme |
| `data_uri` | `data:` URI scheme |
| `object_embed_tag` | `<object` and `<embed` tags |
| `form_tag` | `<form` opening tags |

### `public-report.json` surface (dashboard UI)

Both `evals/shared/dashboard-ui.js` (legacy) and `weave-agent-evals/shared/dashboard-ui.js` (new section) render all user-supplied values through `escapeHtml()` before `innerHTML` assignment. The key rendering paths are:

| Rendering call | Value | Escape applied |
|---|---|---|
| Suite labels | `view.label`, `family.title` | `escapeHtml()` |
| Model names | `model.label`, `model.provider` | `escapeHtml()` |
| Case IDs | `item.caseId` | `escapeHtml()` |
| Status badges | `text` parameter | `escapeHtml()` |
| Feed URLs | `view.url` in `data-feed=` attributes | `escapeHtml()` |
| View IDs | `item.id` in `data-view=` attributes | `escapeHtml()` |
| Error messages | `feed.errorMessage` | `escapeHtml()` |
| Timestamps | `formatDateTime(iso)` result | rendered inline but source is ISO string |
| Commit SHAs | `shortSha(sha)` result | rendered inline but source is hex string |

**`data:` attribute injection**: `data-feed` and `data-view` attributes use `escapeHtml()` on the value, which escapes `"` to `&quot;`. This prevents the value from breaking out of the surrounding `"..."` attribute delimiters, even if the value itself contains attribute-injection payloads.

---

## Banned Rendering Paths

The following are categorically banned regardless of context or convenience:

1. **`innerHTML` assignment of Markdown text** — `public-report.md` content must never be assigned via `innerHTML` without a strict sanitizer.
2. **`innerHTML` assignment of any unescaped string from JSONL feeds** — all JSONL-sourced values (model names, suite IDs, case descriptions, error messages) must be escaped by `escapeHtml()` before `innerHTML` assignment.
3. **`javascript:` or `data:` URIs in any href or src attribute** — these are caught by `html_javascript_uri` and `html_data_uri` patterns in `FORBIDDEN_EXPLANATION_PATTERNS`.
4. **Raw HTML blocks in explanation fields** — any `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, or `<form>` in an explanation is caught by `FORBIDDEN_EXPLANATION_PATTERNS` and the explanation is dropped.
5. **Client-side Markdown-to-HTML rendering without a sanitizer** — if Markdown rendering is added in a future version, it MUST go through DOMPurify (or equivalent) with a strict allowlist before any DOM assignment.

---

## Defence-in-Depth Layers

The XSS protection is applied in three independent layers. An attacker would need to bypass all three layers simultaneously to achieve code execution:

```
Layer 1: Schema validation (report-schema.ts)
    └── BoundedExplanationSchema.FORBIDDEN_EXPLANATION_PATTERNS
        └── Rejects HTML injection in explanation fields
        └── Explanation is silently dropped if it matches

Layer 2: Markdown renderer (report-markdown.ts)
    └── MARKDOWN_INJECTION_PATTERNS via isMarkdownSafe() / sanitizeMdValue()
        └── Returns "" for any injection attempt
        └── Escapes | for pipe characters

Layer 3: Dashboard UI (dashboard-ui.js — both legacy and new section)
    └── escapeHtml() applied to every value before innerHTML
        └── Escapes & < > " ' in all rendered values
        └── data-* attribute values are also escaped
        └── New section exports safeTextSpan / safeTableCell / safeDataAttr
            helpers that apply escapeHtml() internally
```

The layers are complementary:

- **Layer 1** (schema) ensures injection payloads never enter the public report artifact at all.
- **Layer 2** (renderer) ensures even if a value bypassed schema validation, it cannot produce raw HTML in the Markdown artifact.
- **Layer 3** (UI) ensures even if a value survived both prior layers, it cannot execute in a browser context when rendered via `innerHTML`.

---

## Test Coverage

The XSS policy is covered by malicious fixture tests:

| Test file | Coverage |
|---|---|
| `packages/cli/src/evals/__tests__/report-markdown.test.ts` | `MARKDOWN_INJECTION_PATTERNS`, `isMarkdownSafe()`, `sanitizeMdValue()`, `renderCaseRow()`, `renderSuiteSummary()`, `renderPublicReportBundle()` with malicious caseId/modelId/suite/explanation inputs |
| `packages/cli/src/evals/__tests__/report-bundle.test.ts` | `assembleCaseEntry()` drops malicious explanations, `assemblePublicReportBundle()` produces clean JSON, `assertJsonPublishSafe()` round-trip |
| `weave-website/evals/shared/__tests__/dashboard-data.test.js` | Legacy section: `escapeHtml()` policy, malicious JSONL field values, `innerHTML` injection policy, `data-*` attribute injection, `public-report.md` download-only policy |
| `weave-website/weave-agent-evals/shared/__tests__/dashboard-data.test.js` | New section: same XSS categories tested against exported `escapeHtml`, `safeTextSpan`, `safeTableCell`, `safeDataAttr`, `isHtmlInjectionFree` helpers; 94 malicious-fixture cases |

Each test file exercises the full set of XSS categories:
- `<script>` tag injection
- `<style>` tag injection
- `<iframe>` tag injection
- Inline event handlers (`onclick=`, `onerror=`, `onload=`, `onmouseover=`)
- `javascript:` URI injection
- `data:` URI injection
- `<object>` and `<embed>` tag injection
- `<form>` tag injection
- Combined/chained payloads
- Attribute boundary injection (breaking out of `"..."` or `'...'` attribute delimiters)
