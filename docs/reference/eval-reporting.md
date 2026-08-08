# Eval Reporting

Eval reporting turns case results into sanitized, schema-versioned artifacts. This contract separates immutable run evidence from mutable dashboard indexes and keeps raw model content out of published repositories.

**Related:** [Agent Eval Guide](../guides/evals.md) · [CLI](cli.md) · [Testing](../contributing/testing.md)

---

## Pipeline

1. Runners produce typed case results.
2. The central sanitizer allowlists publishable fields and rejects sensitive names or values.
3. Report schemas validate the sanitized objects.
4. The bundle writer emits immutable run files.
5. Dashboard indexes are rebuilt from valid run bundles.
6. An optional publisher writes the same sanitized files to the results repository.

The implementation lives under [`packages/cli/src/evals/`](../../packages/cli/src/evals). The public schema source is [`report-schema.ts`](../../packages/cli/src/evals/report-schema.ts).

## Artifact classes

### Immutable run bundle

Each run writes under `runs/v1/<runId>/`:

- `public-report.json` — primary machine-readable report;
- `public-report.md` — download-only text rendering;
- per-suite score files;
- prompt-provenance manifest;
- bundle manifest and checksums.

A run directory is content evidence. Never rewrite it after publication.

### Derived indexes

Files under `indexes/v1/` summarize known run bundles for dashboards and comparisons. They are mutable projections, not evidence. Rebuild them from validated `public-report.json` files; never treat an existing index as authoritative.

All artifacts carry a numeric `schemaVersion`. Consumers reject unknown versions rather than guessing.

## Sanitization

Published artifacts use an allowlist. They may contain stable IDs, model IDs, bounded scores, pass/fail/skip verdicts, allowlisted explanations, timestamps, hashes, and safe classifications.

They never contain:

- raw prompts or model responses;
- transcripts or tool input/output;
- credentials, headers, tokens, cookies, or environment values;
- stack traces, raw exception messages, or provider payloads;
- local absolute paths;
- raw artifacts or local diagnostics.

`RawErrorSummary.localDiagnostic` and raw model output remain local-only. Filenames derived from case, model, or agent IDs pass through path-safe normalization.

## Explanation and rendering policy

Explanation text is accepted only from known scoring sources, bounded, sanitized, and schema-validated.

- `public-report.md` is a plain-text download; never render it as trusted HTML.
- Dashboard code escapes every value before inserting it into `innerHTML`.
- Markdown links, images, raw HTML, scripts, event handlers, data URLs, JavaScript URLs, and control characters are rejected.
- Do not add a second renderer that bypasses the central sanitizer.

Tests in [`sanitizer.test.ts`](../../packages/cli/src/evals/__tests__/sanitizer.test.ts), [`report-schema.test.ts`](../../packages/cli/src/evals/__tests__/report-schema.test.ts), and [`report-markdown.test.ts`](../../packages/cli/src/evals/__tests__/report-markdown.test.ts) define the executable security boundary.

## Raw artifacts

`--raw-artifacts` is explicit local opt-in. Raw files:

- stay outside the sanitized bundle;
- never enter dashboard indexes;
- are not accepted by the publisher;
- use path-safe names;
- should have short local or CI retention.

No environment variable or publish mode may enable raw artifacts implicitly.

## Publication

Local mode writes sanitized bundles to disk. Publish mode uses the results-repository interface and a token-gated GitHub publisher. Publishing is best-effort only where the command contract says so; sanitization and schema failures always fail closed before network work.

The publisher:

- accepts only allowlisted bundle paths;
- uses immutable run paths;
- updates derived indexes after the run files exist;
- does not accept arbitrary local files;
- reports typed failures without embedding provider response bodies.

## Change rule

A report schema change requires:

1. a schema version decision;
2. schema, sanitizer, writer, reader, and index updates;
3. tests for valid and rejected data;
4. public dashboard compatibility or an explicit migration;
5. an update to this reference.

Dated eval results and rollout decisions belong in the relevant issue or pull request, not this maintained contract.
